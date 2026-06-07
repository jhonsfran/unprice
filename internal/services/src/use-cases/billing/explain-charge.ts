import type { Analytics } from "@unprice/analytics"
import { explainChargeEventRowSchema } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { customerEntitlements } from "@unprice/db/schema"
import {
  type Currency,
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
} from "@unprice/db/validators"
import { BaseError, Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import {
  type Dinero,
  LEDGER_SCALE,
  formatMoney,
  fromLedgerMinor,
  toDecimal,
  toLedgerMinor,
} from "@unprice/money"
import { z } from "zod"
import { computeGrantPeriodBucket } from "../../entitlements/grant-consumption"
import type { UnPriceLedgerError } from "../../ledger"
import type { InvoiceLine, LedgerGateway } from "../../ledger"

export const explainChargeInputSchema = z.object({
  projectId: z.string(),
  invoiceId: z.string(),
  entryId: z.string(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
})

export const explainChargeOutputSchema = z.object({
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
    latestAmountAfter: z.number().int(),
    currency: z.string(),
    amountScale: z.number().int(),
    firstEventAt: z.number().int().nullable(),
    lastEventAt: z.number().int().nullable(),
    multiComponentEventCount: z.number().int(),
  }),
  pricing: z.object({
    featureType: z.string(),
    usageMode: z.string().nullable(),
    tierMode: z.string().nullable(),
    unitOfMeasure: z.string(),
    description: z.string(),
    rows: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    ),
  }),
  events: z.array(explainChargeEventRowSchema),
  answer: z.string(),
  evidence: z.array(
    z.object({
      type: z.enum(["ledger_line", "billing_period", "meter_fact"]),
      id: z.string(),
    })
  ),
  pagination: z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
  }),
})

export type ExplainChargeInput = z.infer<typeof explainChargeInputSchema>
export type ExplainChargeOutput = z.infer<typeof explainChargeOutputSchema>
type ExplainChargeSummary = ExplainChargeOutput["summary"]
type ExplainChargeEvent = ExplainChargeOutput["events"][number]
type ResolvedInvoiceLine = {
  line: InvoiceLine
  ledgerEntryIds: string[]
}

export type ExplainChargeDeps = {
  db: Database
  ledger: LedgerGateway
  analytics: Analytics
}

export type ExplainChargeErrorCode =
  | "INVOICE_NOT_FOUND"
  | "LEDGER_LINE_NOT_FOUND"
  | "BILLING_PERIOD_METADATA_MISSING"
  | "BILLING_PERIOD_NOT_FOUND"
  | "BILLING_PERIOD_CONTEXT_MISMATCH"
  | "FEATURE_NOT_FOUND"
  | "PERIOD_KEY_NOT_DERIVED"

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
  const ledgerEntryIds = resolvedLine?.ledgerEntryIds ?? [line.entryId]
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
  const usagePeriodKey = isUsageFeature
    ? computeGrantPeriodBucket(
        {
          cadenceEffectiveAt: singleScopedEntitlement?.effectiveAt ?? billingPeriod.cycleStartAt,
          cadenceExpiresAt: singleScopedEntitlement?.expiresAt ?? billingPeriod.cycleEndAt,
          effectiveAt: billingPeriod.cycleStartAt,
          expiresAt: billingPeriod.cycleEndAt,
          grantId: "explain-charge",
          resetConfig: featurePlanVersion.resetConfig,
        },
        billingPeriod.cycleStartAt
      )?.periodKey
    : null

  const periodKey = usagePeriodKey ?? `billing_period:${billingPeriod.id}`
  const lineAmount = toLedgerMinor(line.amount)
  let summary: ExplainChargeSummary
  let events: ExplainChargeEvent[]

  if (isUsageFeature) {
    const query = {
      project_id: input.projectId,
      customer_id: invoice.customerId,
      feature_slug: featureSlug,
      ...(usagePeriodKey
        ? {
            period_key: usagePeriodKey,
            ...(singleScopedEntitlement
              ? { customer_entitlement_id: singleScopedEntitlement.id }
              : {}),
          }
        : {
            start: billingPeriod.cycleStartAt,
            end: billingPeriod.cycleEndAt,
            ...(singleScopedEntitlement
              ? { customer_entitlement_id: singleScopedEntitlement.id }
              : {}),
          }),
    }

    const analyticsResult = await wrapResult(
      Promise.all([
        deps.analytics.getExplainChargeSummary(query),
        deps.analytics.getExplainChargeEvents({
          ...query,
          limit: input.limit,
          offset: input.offset,
        }),
      ]),
      (error) =>
        new FetchError({
          message: error.message,
          retry: true,
          context: {
            url: "tinybird:v1_explain_charge",
            method: "GET",
            projectId: input.projectId,
            invoiceId: input.invoiceId,
            entryId: input.entryId,
          },
        })
    )

    if (analyticsResult.err) {
      return Err(analyticsResult.err)
    }

    const [summaryResponse, eventsResponse] = analyticsResult.val
    const summaryRow = summaryResponse.data.at(0)
    events = eventsResponse.data
    const analyticsSummary = summaryRow
      ? mapExplainChargeSummaryRow(summaryRow)
      : emptyExplainChargeSummary(line.currency)

    summary = {
      ...analyticsSummary,
      totalUsage: line.quantity ?? analyticsSummary.totalUsage,
      totalAmount: lineAmount,
      latestAmountAfter: lineAmount,
      currency: line.currency,
      amountScale: LEDGER_SCALE,
    }
  } else {
    events = []
    summary = {
      eventCount: 0,
      totalUsage: line.quantity ?? 0,
      totalAmount: lineAmount,
      latestAmountAfter: lineAmount,
      currency: line.currency,
      amountScale: LEDGER_SCALE,
      firstEventAt: null,
      lastEventAt: null,
      multiComponentEventCount: 0,
    }
  }

  const output: ExplainChargeOutput = {
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
    pricing: buildPricingSummary({ featurePlanVersion, featureSlug }),
    events,
    answer: buildAnswer({
      featureSlug,
      lineDisplayAmount: formatDineroAmount(line.amount),
      isUsageFeature,
      summary,
    }),
    evidence: [
      ...ledgerEntryIds.map((entryId) => ({ type: "ledger_line" as const, id: entryId })),
      { type: "billing_period", id: billingPeriodId },
      ...events.map((event) => ({ type: "meter_fact" as const, id: event.event_id })),
    ],
    pagination: {
      limit: input.limit,
      offset: input.offset,
      hasMore: summary.eventCount > input.offset + events.length,
    },
  }

  return Ok(explainChargeOutputSchema.parse(output))
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
    return { line: exact, ledgerEntryIds: [exact.entryId] }
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
    ledgerEntryIds: groupLines.map((line) => line.entryId),
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

function mapExplainChargeSummaryRow(row: {
  event_count: number
  total_delta: number
  total_amount: number
  latest_amount_after: number
  currency: string
  amount_scale: number
  first_event_at: number | null
  last_event_at: number | null
  multi_component_event_count: number
}): ExplainChargeSummary {
  return {
    eventCount: row.event_count,
    totalUsage: row.total_delta,
    totalAmount: row.total_amount,
    latestAmountAfter: row.latest_amount_after,
    currency: row.currency,
    amountScale: row.amount_scale,
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    multiComponentEventCount: row.multi_component_event_count,
  }
}

function emptyExplainChargeSummary(currency: Currency): ExplainChargeSummary {
  return {
    eventCount: 0,
    totalUsage: 0,
    totalAmount: 0,
    latestAmountAfter: 0,
    currency,
    amountScale: LEDGER_SCALE,
    firstEventAt: null,
    lastEventAt: null,
    multiComponentEventCount: 0,
  }
}

type PriceSnapshot = z.infer<typeof configUsageSchema>["price"]
type TierSnapshot = NonNullable<z.infer<typeof configUsageSchema>["tiers"]>[number]

function buildPricingSummary({
  featurePlanVersion,
  featureSlug,
}: {
  featurePlanVersion: {
    featureType: string
    unitOfMeasure: string
    config: unknown
  }
  featureSlug: string
}): ExplainChargeOutput["pricing"] {
  const unit = displayUnit(featurePlanVersion.unitOfMeasure, featureSlug)

  if (featurePlanVersion.featureType === "usage") {
    const config = configUsageSchema.parse(featurePlanVersion.config)

    if (config.usageMode === "unit" && config.price) {
      const price = formatConfiguredPrice(config.price)
      return {
        featureType: "usage",
        usageMode: config.usageMode,
        tierMode: null,
        unitOfMeasure: unit,
        description: `Unit pricing: ${price} per ${unit}`,
        rows: [{ label: "Unit price", value: `${price} / ${unit}` }],
      }
    }

    if (config.usageMode === "package" && config.price && config.units) {
      const price = formatConfiguredPrice(config.price)
      return {
        featureType: "usage",
        usageMode: config.usageMode,
        tierMode: null,
        unitOfMeasure: unit,
        description: `Package pricing: ${price} per ${formatUsage(config.units)} ${unit}`,
        rows: [
          { label: "Package", value: `${formatUsage(config.units)} ${unit}` },
          { label: "Package price", value: price },
        ],
      }
    }

    if (config.usageMode === "tier" && config.tiers && config.tierMode) {
      return tierPricingSummary({
        featureType: "usage",
        usageMode: config.usageMode,
        tierMode: config.tierMode,
        unit,
        tiers: config.tiers,
      })
    }
  }

  if (featurePlanVersion.featureType === "tier") {
    const config = configTierSchema.parse(featurePlanVersion.config)
    return tierPricingSummary({
      featureType: "tier",
      usageMode: null,
      tierMode: config.tierMode,
      unit,
      tiers: config.tiers,
    })
  }

  if (featurePlanVersion.featureType === "package") {
    const config = configPackageSchema.parse(featurePlanVersion.config)
    const price = formatConfiguredPrice(config.price)
    return {
      featureType: "package",
      usageMode: null,
      tierMode: null,
      unitOfMeasure: unit,
      description: `Package pricing: ${price} per ${formatUsage(config.units)} ${unit}`,
      rows: [
        { label: "Package", value: `${formatUsage(config.units)} ${unit}` },
        { label: "Package price", value: price },
      ],
    }
  }

  const config = configFlatSchema.parse(featurePlanVersion.config)
  const price = formatConfiguredPrice(config.price)
  return {
    featureType: "flat",
    usageMode: null,
    tierMode: null,
    unitOfMeasure: unit,
    description: `Fixed price: ${price}`,
    rows: [{ label: "Fixed price", value: price }],
  }
}

function tierPricingSummary({
  featureType,
  usageMode,
  tierMode,
  unit,
  tiers,
}: {
  featureType: string
  usageMode: string | null
  tierMode: string
  unit: string
  tiers: TierSnapshot[]
}): ExplainChargeOutput["pricing"] {
  const modeLabel = tierMode === "graduated" ? "Graduated tiers" : "Volume tiers"

  return {
    featureType,
    usageMode,
    tierMode,
    unitOfMeasure: unit,
    description: `${modeLabel}: price changes by ${unit} range`,
    rows: tiers.map((tier) => ({
      label: tierRangeLabel(tier, unit),
      value: tierValueLabel(tier),
    })),
  }
}

function tierRangeLabel(tier: TierSnapshot, unit: string): string {
  const first = formatUsage(tier.firstUnit)
  const last = tier.lastUnit === null ? "unlimited" : formatUsage(tier.lastUnit)
  return `${first}-${last} ${unit}`
}

function tierValueLabel(tier: TierSnapshot): string {
  const unitPrice = formatConfiguredPrice(tier.unitPrice)
  const flatPrice = formatConfiguredPrice(tier.flatPrice)

  if (isZeroConfiguredPrice(tier.flatPrice)) {
    return `${unitPrice} / unit`
  }

  return `${flatPrice} + ${unitPrice} / unit`
}

function formatConfiguredPrice(price: PriceSnapshot): string {
  if (!price) {
    return "0"
  }

  return `${price.displayAmount} ${price.dinero.currency.code}`
}

function isZeroConfiguredPrice(price: PriceSnapshot): boolean {
  return Number(price?.displayAmount ?? 0) === 0
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
    return `${featureSlug} costs ${lineDisplayAmount} for this invoice period. This line is not usage based, so no rated meter facts are expected.`
  }

  if (summary.eventCount === 0) {
    return `${featureSlug} costs ${lineDisplayAmount}. The invoice ledger has usage for this line, but no rated meter facts were found in the billing window.`
  }

  const usage = formatUsage(summary.totalUsage)
  return `${usage} units of ${featureSlug} were rated for this invoice period. Those rated facts produced ${lineDisplayAmount}.`
}

function formatDineroAmount(amount: Dinero<number>): string {
  return toDecimal(amount, ({ value, currency }) => formatMoney(value, currency.code))
}

function formatUsage(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 4,
  }).format(value)
}
