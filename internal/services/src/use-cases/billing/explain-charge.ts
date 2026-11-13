import { type Database, and, eq } from "@unprice/db"
import { customerEntitlements } from "@unprice/db/schema"
import type { Currency, RateRow } from "@unprice/db/validators"
import { BaseError, Err, type FetchError, Ok, type Result } from "@unprice/error"
import {
  type Dinero,
  LEDGER_SCALE,
  formatMoney,
  fromLedgerMinor,
  toDecimal,
  toLedgerMinor,
} from "@unprice/money"
import { z } from "zod"
import { type journalChargeDataSchema, parseSignedDecimal } from "../../analytics/budget-journal"
import { getStatementEvents } from "../../analytics/budget-journal-reader"
import type { ServiceContext } from "../../context"
import type { UnPriceLedgerError } from "../../ledger"
import type { InvoiceLine, LedgerGateway } from "../../ledger"
import { describeRatePrice, describeTiers } from "../../pricing"
import type { RateCardService } from "../../rate-cards"
import { aiAnswerEnvelopeSchema } from "../analytics/ai-contracts"

/** One accepted event counted by the invoice statement, read from the budget journal. */
export const explainChargeEventSchema = z.object({
  idempotency_key: z.string(),
  feature_slug: z.string(),
  period_key: z.string(),
  event_slug: z.string(),
  timestamp: z.number().describe("timestamp of the ingested event"),
  created_at: z.number().describe("timestamp of when the budget operation was created"),
  delta: z.number(),
  amount: z.number().int(),
  amount_scale: z.literal(LEDGER_SCALE),
  currency: z.string().length(3),
  pricing_component_count: z.number().int().nonnegative(),
  operation_id: z.string(),
})

export const explainChargeInputSchema = z.object({
  projectId: z.string(),
  invoiceId: z.string(),
  entryId: z.string(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
})

export const explainChargeOutputSchema = z
  .object({
    invoice: z.object({
      id: z.string(),
      statementKey: z.string(),
      customerId: z.string(),
      currency: z.string(),
    }),
    line: z.object({
      entryId: z.string(),
      billingPeriodId: z.string(),
      kind: z.string(),
      amount: z.number().int(),
      currency: z.string(),
    }),
    scope: z.object({
      projectId: z.string(),
      customerId: z.string(),
      featureSlug: z.string(),
      periodKey: z.string(),
      customerEntitlementId: z.string().nullable(),
      featurePlanVersionId: z.string().nullable(),
    }),
    summary: z.object({
      eventCount: z.number().int(),
      totalUsage: z.number(),
      totalAmount: z.number().int(),
      /** Provider cost in USD at the ledger scale, from the invoice line; null when none was priced. */
      costUsd: z.number().int().nullable(),
      currency: z.string(),
      amountScale: z.number().int(),
      firstEventAt: z.number().int().nullable(),
      lastEventAt: z.number().int().nullable(),
      multiComponentEventCount: z.number().int(),
    }),
    pricing: z.object({
      featureType: z.string(),
      usageMode: z.string().nullable(),
      unitOfMeasure: z.string(),
      description: z.string(),
      rows: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
        })
      ),
    }),
    events: z.array(explainChargeEventSchema),
    answer: z.string(),
    pagination: z.object({
      limit: z.number().int(),
      offset: z.number().int(),
      hasMore: z.boolean(),
    }),
  })
  .extend(aiAnswerEnvelopeSchema.shape)

export type ExplainChargeInput = z.infer<typeof explainChargeInputSchema>
export type ExplainChargeOutput = z.infer<typeof explainChargeOutputSchema>
type ExplainChargeDetails = Omit<
  ExplainChargeOutput,
  "confidence" | "freshness" | "evidence" | "warnings" | "nextActions"
>
type ExplainChargeSummary = ExplainChargeOutput["summary"]
type ExplainChargeEvent = ExplainChargeOutput["events"][number]
type ResolvedInvoiceLine = {
  line: InvoiceLine
}

export type ExplainChargeDeps = {
  db: Database
  ledger: LedgerGateway
  budgetJournal: ServiceContext["budgetJournal"]
  rateCards: Pick<RateCardService, "pricingForPlanVersions">
  now?: () => number
}

export type ExplainChargeErrorCode =
  | "INVOICE_NOT_FOUND"
  | "LEDGER_LINE_NOT_FOUND"
  | "BILLING_PERIOD_METADATA_MISSING"
  | "BILLING_PERIOD_NOT_FOUND"
  | "BILLING_PERIOD_CONTEXT_MISMATCH"
  | "FEATURE_NOT_FOUND"

export class ExplainChargeError extends BaseError<{
  code: ExplainChargeErrorCode
  context?: Record<string, unknown>
}> {
  public readonly retry = false
  public readonly name = ExplainChargeError.name
  public readonly code: ExplainChargeErrorCode

  constructor({
    code,
    message,
    context,
  }: {
    code: ExplainChargeErrorCode
    message: string
    context?: Record<string, unknown>
  }) {
    super({ message, context: { code, context } })
    this.code = code
  }
}

type ExplainChargeFailure = ExplainChargeError | UnPriceLedgerError | FetchError

export async function explainCharge(
  deps: ExplainChargeDeps,
  rawInput: ExplainChargeInput
): Promise<Result<ExplainChargeOutput, ExplainChargeFailure>> {
  const input = explainChargeInputSchema.parse(rawInput)

  const invoice = await deps.db.query.invoices.findFirst({
    columns: {
      id: true,
      statementKey: true,
      customerId: true,
      currency: true,
    },
    where: (row, { and, eq }) =>
      and(eq(row.id, input.invoiceId), eq(row.projectId, input.projectId)),
  })

  if (!invoice) {
    return Err(
      new ExplainChargeError({
        code: "INVOICE_NOT_FOUND",
        message: "Invoice not found",
        context: { invoiceId: input.invoiceId, projectId: input.projectId },
      })
    )
  }

  const linesResult = await deps.ledger.getInvoiceLines({
    projectId: input.projectId,
    statementKey: invoice.statementKey,
  })

  if (linesResult.err) {
    return Err(linesResult.err)
  }

  const resolvedLine = resolveRequestedInvoiceLine(linesResult.val, input.entryId, invoice.currency)
  const syntheticBillingPeriodId = readBillingPeriodLineId(input.entryId)
  const billingPeriodId = resolvedLine
    ? readStringMetadata(resolvedLine.line.metadata, "billing_period_id")
    : syntheticBillingPeriodId

  if (!resolvedLine && !syntheticBillingPeriodId) {
    return Err(
      new ExplainChargeError({
        code: "LEDGER_LINE_NOT_FOUND",
        message: "Invoice line not found",
        context: { entryId: input.entryId, invoiceId: input.invoiceId },
      })
    )
  }

  if (!billingPeriodId) {
    return Err(
      new ExplainChargeError({
        code: "BILLING_PERIOD_METADATA_MISSING",
        message: "Invoice line is missing billing period metadata",
        context: { entryId: input.entryId },
      })
    )
  }

  const billingPeriod = await deps.db.query.billingPeriods.findFirst({
    with: {
      subscriptionItem: {
        with: {
          featurePlanVersion: {
            with: {
              feature: {
                columns: {
                  slug: true,
                },
              },
            },
          },
        },
      },
    },
    where: (row, { and, eq }) =>
      and(eq(row.id, billingPeriodId), eq(row.projectId, input.projectId)),
  })

  if (!billingPeriod) {
    return Err(
      new ExplainChargeError({
        code: "BILLING_PERIOD_NOT_FOUND",
        message: "Billing period not found",
        context: { billingPeriodId, projectId: input.projectId },
      })
    )
  }

  const line =
    resolvedLine?.line ??
    buildSyntheticBillingPeriodLine({
      billingPeriod,
      currency: invoice.currency,
      entryId: input.entryId,
      statementKey: invoice.statementKey,
    })
  const featurePlanVersion = billingPeriod.subscriptionItem?.featurePlanVersion ?? null
  const featureSlug = featurePlanVersion?.feature?.slug ?? null
  if (!featurePlanVersion || !featureSlug) {
    return Err(
      new ExplainChargeError({
        code: "FEATURE_NOT_FOUND",
        message: "Billing period feature not found",
        context: { billingPeriodId },
      })
    )
  }

  if (
    billingPeriod.invoiceId !== invoice.id ||
    billingPeriod.customerId !== invoice.customerId ||
    billingPeriod.statementKey !== invoice.statementKey
  ) {
    return Err(
      new ExplainChargeError({
        code: "BILLING_PERIOD_CONTEXT_MISMATCH",
        message: "Billing period does not match invoice context",
        context: {
          billingPeriodId,
          invoiceId: invoice.id,
          billingPeriodInvoiceId: billingPeriod.invoiceId,
          invoiceCustomerId: invoice.customerId,
          billingPeriodCustomerId: billingPeriod.customerId,
          invoiceStatementKey: invoice.statementKey,
          billingPeriodStatementKey: billingPeriod.statementKey,
        },
      })
    )
  }

  const scopedEntitlements = await deps.db.query.customerEntitlements.findMany({
    columns: {
      id: true,
      effectiveAt: true,
      expiresAt: true,
    },
    where: and(
      eq(customerEntitlements.projectId, input.projectId),
      eq(customerEntitlements.customerId, invoice.customerId),
      eq(customerEntitlements.subscriptionItemId, billingPeriod.subscriptionItemId),
      eq(customerEntitlements.featurePlanVersionId, featurePlanVersion.id)
    ),
  })
  const singleScopedEntitlement =
    scopedEntitlements.length === 1 ? scopedEntitlements[0] : undefined

  const isUsageFeature = featurePlanVersion.featureType === "usage"
  // A metered line bills one payer statement, identified by its billing period (ADR-0008 D4).
  const periodKey = isUsageFeature ? billingPeriod.id : `billing_period:${billingPeriod.id}`
  const lineAmount = toLedgerMinor(line.amount)
  // The statement as billed: amount and quantity on the line, cost in its metadata.
  const statementSummary: ExplainChargeSummary = {
    eventCount: 0,
    totalUsage: line.quantity ?? 0,
    totalAmount: lineAmount,
    costUsd: readIntegerMetadata(line.metadata, "cost_usd"),
    currency: line.currency,
    amountScale: LEDGER_SCALE,
    firstEventAt: null,
    lastEventAt: null,
    multiComponentEventCount: 0,
  }
  let summary = statementSummary
  let events: ExplainChargeEvent[] = []

  if (isUsageFeature) {
    const journal = await getStatementEvents(deps.budgetJournal, {
      projectId: input.projectId,
      customerId: invoice.customerId,
      periodId: periodKey,
      // Everything the statement counted was written after its period started, late usage of
      // a sealed earlier period included.
      window: {
        from: new Date(billingPeriod.cycleStartAt),
        to: new Date(deps.now?.() ?? Date.now()),
      },
      limit: input.limit,
      offset: input.offset,
    })

    if (journal.err) {
      return Err(journal.err)
    }

    events = journal.val.events.flatMap((row) => {
      const event = toExplainChargeEvent({
        data: row.data,
        operationId: row.operation_id,
        periodId: periodKey,
        currency: line.currency,
      })
      return event ? [event] : []
    })
    summary = {
      ...statementSummary,
      eventCount: journal.val.total,
      firstEventAt: journal.val.firstEventAt,
      lastEventAt: journal.val.lastEventAt,
      multiComponentEventCount: journal.val.multiComponentEventCount,
    }
  }

  const output: ExplainChargeDetails = {
    invoice: {
      id: invoice.id,
      statementKey: invoice.statementKey,
      customerId: invoice.customerId,
      currency: invoice.currency,
    },
    line: {
      entryId: line.entryId,
      billingPeriodId,
      kind: line.kind,
      amount: lineAmount,
      currency: line.currency,
    },
    scope: {
      projectId: input.projectId,
      customerId: invoice.customerId,
      featureSlug,
      periodKey,
      customerEntitlementId: singleScopedEntitlement?.id ?? null,
      featurePlanVersionId: featurePlanVersion.id,
    },
    summary,
    pricing: buildPricingSummary({
      featurePlanVersion,
      featureSlug,
      currency: invoice.currency,
      rows: await periodRows(deps, {
        projectId: input.projectId,
        planVersionId: featurePlanVersion.planVersionId,
        currency: invoice.currency,
        from: billingPeriod.cycleStartAt,
        to: billingPeriod.cycleEndAt,
      }),
    }),
    events,
    answer: buildAnswer({
      featureSlug,
      lineDisplayAmount: formatDineroAmount(line.amount),
      isUsageFeature,
      summary,
    }),
    pagination: {
      limit: input.limit,
      offset: input.offset,
      hasMore: summary.eventCount > input.offset + events.length,
    },
  }

  return Ok(
    explainChargeOutputSchema.parse({
      ...output,
      confidence: buildConfidence({
        eventCount: summary.eventCount,
        eventsReturned: events.length,
      }),
      freshness: {
        generatedAt: deps.now?.() ?? Date.now(),
        dataFrom: summary.firstEventAt,
        dataTo: summary.lastEventAt,
      },
      evidence: buildEvidence(output),
      warnings: buildWarnings(output),
      nextActions: buildNextActions(output),
    })
  )
}

function readStringMetadata(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readBillingPeriodLineId(entryId: string): string | null {
  const prefix = "billing-period:"
  return entryId.startsWith(prefix) ? entryId.slice(prefix.length) : null
}

function resolveRequestedInvoiceLine(
  lines: InvoiceLine[],
  entryId: string,
  currency: Currency
): ResolvedInvoiceLine | null {
  const exact = lines.find((candidate) => candidate.entryId === entryId)
  if (exact) {
    return { line: exact }
  }

  const groupPrefix = "group:"
  if (!entryId.startsWith(groupPrefix)) {
    return null
  }

  const groupKey = entryId.slice(groupPrefix.length)
  const groupLines = lines.filter((line) => invoiceLineGroupKey(line) === groupKey)
  if (groupLines.length === 0) {
    return null
  }

  const [firstLine, ...remainingLines] = groupLines
  if (!firstLine) {
    return null
  }

  const totalAmount = groupLines.reduce((total, line) => total + toLedgerMinor(line.amount), 0)
  const quantity = groupLines.every((line) => line.quantity !== null)
    ? groupLines.reduce((total, line) => total + (line.quantity ?? 0), 0)
    : null

  return {
    line: {
      ...firstLine,
      entryId,
      quantity,
      amount: fromLedgerMinor(totalAmount, currency),
      createdAt: remainingLines.reduce(
        (earliest, line) => (line.createdAt < earliest ? line.createdAt : earliest),
        firstLine.createdAt
      ),
    },
  }
}

function invoiceLineGroupKey(line: InvoiceLine): string {
  const metadata = line.metadata ?? {}
  const billingPeriodId = readStringMetadata(metadata, "billing_period_id")
  const itemId =
    readStringMetadata(metadata, "feature_plan_version_item_id") ??
    readStringMetadata(metadata, "subscription_item_id")

  if (!billingPeriodId || !itemId) {
    return line.entryId
  }

  return [
    billingPeriodId,
    itemId,
    line.kind,
    line.settlementSource,
    line.settlementStatus,
    line.collectable ? "collectable" : "non_collectable",
  ].join(":")
}

function buildSyntheticBillingPeriodLine({
  billingPeriod,
  currency,
  entryId,
  statementKey,
}: {
  billingPeriod: {
    id: string
    invoiceAt: number
    subscriptionItem: {
      units: number | null
    } | null
    type: "normal" | "trial"
  }
  currency: Currency
  entryId: string
  statementKey: string
}): InvoiceLine {
  return {
    entryId,
    statementKey,
    kind: billingPeriod.type === "trial" ? "trial" : "period",
    description: null,
    quantity: billingPeriod.subscriptionItem?.units ?? 0,
    amount: fromLedgerMinor(0, currency),
    amountDue: 0,
    amountIncluded: 0,
    amountPaid: 0,
    collectable: false,
    settlementSource: billingPeriod.type === "trial" ? "trial" : "provider",
    settlementStatus: billingPeriod.type === "trial" ? "included" : "due",
    walletCreditId: null,
    walletCreditSource: null,
    walletId: null,
    currency,
    createdAt: new Date(billingPeriod.invoiceAt),
    metadata: { billing_period_id: billingPeriod.id },
  }
}

function readIntegerMetadata(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key]
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}

/**
 * A journaled charge, record, or settled hold as one rated event of the statement: its entry for
 * the statement's feature. Null when the row is not one (a malformed export, or the statement's
 * feature missing).
 */
function toExplainChargeEvent(opts: {
  data: z.infer<typeof journalChargeDataSchema>
  operationId: string
  periodId: string
  currency: string
}): ExplainChargeEvent | null {
  const data = opts.data
  const priced = data.priced ?? data.state?.priced
  const feature = priced?.features.find((entry) => entry.periodId === opts.periodId)
  if (!priced || !feature) {
    return null
  }

  const quantity = parseSignedDecimal(feature.meterQuantity) ?? BigInt(0)
  const amount = Number(parseSignedDecimal(feature.amount) ?? BigInt(0))
  const units = (value: bigint) => Number(value) / 10 ** LEDGER_SCALE

  return {
    idempotency_key: data.idempotencyKey,
    feature_slug: feature.featureSlug,
    period_key: feature.periodId,
    event_slug: priced.slug,
    timestamp: priced.at,
    created_at: data.createdAt,
    delta: units(quantity),
    amount,
    amount_scale: LEDGER_SCALE,
    currency: opts.currency,
    pricing_component_count: feature.lines?.length ?? 0,
    operation_id: opts.operationId,
  }
}

/** The plan version's card rows in `currency` that were in effect during [from, to). */
async function periodRows(
  deps: Pick<ExplainChargeDeps, "rateCards">,
  input: { projectId: string; planVersionId: string; currency: string; from: number; to: number }
): Promise<RateRow[]> {
  const pricing = await deps.rateCards.pricingForPlanVersions(
    input.projectId,
    [input.planVersionId],
    input.from,
    Math.max(input.to, input.from + 1)
  )
  return (
    pricing.get(input.planVersionId)?.find((card) => card.currency === input.currency)?.rows ?? []
  )
}

/** The feature's rows on the plan version's rate card (ADR-0008 D2) during the billed period. */
function buildPricingSummary({
  featurePlanVersion,
  featureSlug,
  currency,
  rows,
}: {
  featurePlanVersion: {
    featureType: string
    unitOfMeasure: string
    config: { usageMode?: string } | null
  }
  featureSlug: string
  currency: string
  rows: readonly RateRow[]
}): ExplainChargeOutput["pricing"] {
  const unit = displayUnit(featurePlanVersion.unitOfMeasure, featureSlug)
  const base = {
    featureType: featurePlanVersion.featureType,
    usageMode: featurePlanVersion.config?.usageMode ?? null,
    unitOfMeasure: unit,
  }
  const featureRows = rows.filter((row) => row.featureSlug === featureSlug)
  const [only] = featureRows

  if (!only) {
    return { ...base, description: "No rate card row priced this feature", rows: [] }
  }

  if (featureRows.length === 1 && only.price.type === "graduated") {
    return {
      ...base,
      description: `Graduated tiers: price changes by ${unit} range`,
      rows: describeTiers(only.price, currency, unit),
    }
  }

  return {
    ...base,
    description:
      featureRows.length === 1
        ? `Rate card price: ${describeRatePrice(only.price, currency, unit)}`
        : `Rate card prices: ${featureRows.length} rows during the period`,
    rows: featureRows.map((row) => ({
      label: rowLabel(row),
      value: describeRatePrice(row.price, currency, unit),
    })),
  }
}

/** The row's match and, when it changed during the period, from when it applied. */
function rowLabel(row: RateRow): string {
  const match = Object.entries(row.match)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")
  const since = new Date(row.effectiveFrom).toISOString()
  return `${match || "Default"} (from ${since}${row.effectiveTo === null ? "" : ` to ${new Date(row.effectiveTo).toISOString()}`})`
}

function displayUnit(unitOfMeasure: string, featureSlug: string): string {
  const unit = unitOfMeasure === "units" ? featureSlug : unitOfMeasure
  return unit.endsWith("s") ? unit.slice(0, -1) : unit
}

function buildAnswer({
  featureSlug,
  lineDisplayAmount,
  isUsageFeature,
  summary,
}: {
  featureSlug: string
  lineDisplayAmount: string
  isUsageFeature: boolean
  summary: ExplainChargeOutput["summary"]
}): string {
  if (!isUsageFeature) {
    return `${featureSlug} costs ${lineDisplayAmount} for this invoice period. This line is not usage based, so no journal events are expected.`
  }

  if (summary.eventCount === 0) {
    return `${featureSlug} costs ${lineDisplayAmount}. The invoice ledger has usage for this line, but no journal events were found in the billing window.`
  }

  const usage = formatUsage(summary.totalUsage)
  return `${usage} units of ${featureSlug} were rated for this invoice period. Those journal events produced ${lineDisplayAmount}.`
}

function formatDineroAmount(amount: Dinero<number>): string {
  return toDecimal(amount, ({ value, currency }) => formatMoney(value, currency.code))
}

function formatUsage(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 4,
  }).format(value)
}

function buildConfidence({
  eventCount,
  eventsReturned,
}: {
  eventCount: number
  eventsReturned: number
}): ExplainChargeOutput["confidence"] {
  if (eventCount > 0 || eventsReturned > 0) {
    return "high"
  }

  return "medium"
}

function buildEvidence(result: ExplainChargeDetails): ExplainChargeOutput["evidence"] {
  return [
    {
      type: "invoice" as const,
      id: result.invoice.id,
      source: "postgres" as const,
      timestamp: null,
    },
    {
      type: "ledger_line" as const,
      id: result.line.entryId,
      source: "ledger" as const,
      timestamp: null,
    },
    {
      type: "billing_period" as const,
      id: result.line.billingPeriodId,
      source: "postgres" as const,
      timestamp: null,
    },
    ...(result.scope.featurePlanVersionId
      ? [
          {
            type: "plan_version" as const,
            id: result.scope.featurePlanVersionId,
            source: "postgres" as const,
            timestamp: null,
          },
        ]
      : []),
    ...result.events.map((event) => ({
      type: "event" as const,
      id: [
        result.scope.projectId,
        result.scope.customerId,
        event.period_key,
        event.operation_id,
      ].join(":"),
      source: "r2" as const,
      timestamp: event.timestamp,
    })),
  ]
}

function buildWarnings(result: ExplainChargeDetails): string[] {
  const warnings: string[] = []

  if (result.summary.eventCount === 0) {
    warnings.push(
      isBillingPeriodScopedLine(result)
        ? "This non-usage line is explained from ledger and billing-period evidence; no journal events are expected."
        : "No journal events were found for this invoice line."
    )
  }

  if (result.pagination.hasMore) {
    warnings.push("Additional journal events are available on later pages.")
  }

  return warnings
}

function buildNextActions(result: ExplainChargeDetails): string[] {
  if (result.summary.eventCount === 0) {
    if (isBillingPeriodScopedLine(result)) {
      return []
    }

    return ["Verify the billing period, feature slug, and period key for this invoice line."]
  }

  if (result.pagination.hasMore) {
    return ["Request the next page to inspect the remaining journal events."]
  }

  return []
}

function isBillingPeriodScopedLine(result: ExplainChargeDetails): boolean {
  return result.scope.periodKey.startsWith("billing_period:")
}
