import type { Analytics } from "@unprice/analytics"
import { explainChargeEventRowSchema } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { customerEntitlements } from "@unprice/db/schema"
import { BaseError, Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { LEDGER_SCALE, toLedgerMinor } from "@unprice/money"
import { z } from "zod"
import { computeGrantPeriodBucket } from "../../entitlements/grant-consumption"
import type { UnPriceLedgerError } from "../../ledger"
import type { LedgerGateway } from "../../ledger"

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

  const line = linesResult.val.find((candidate) => candidate.entryId === input.entryId)
  if (!line) {
    return Err(
      new ExplainChargeError({
        code: "LEDGER_LINE_NOT_FOUND",
        message: "Invoice line not found",
        context: { entryId: input.entryId, invoiceId: input.invoiceId },
      })
    )
  }

  const billingPeriodId = readStringMetadata(line.metadata, "billing_period_id")
  if (!billingPeriodId) {
    return Err(
      new ExplainChargeError({
        code: "BILLING_PERIOD_METADATA_MISSING",
        message: "Invoice line is missing billing period metadata",
        context: { entryId: line.entryId },
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

  const customerEntitlement = await deps.db.query.customerEntitlements.findFirst({
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

  const periodKey = computeGrantPeriodBucket(
    {
      cadenceEffectiveAt: customerEntitlement?.effectiveAt ?? billingPeriod.cycleStartAt,
      cadenceExpiresAt: customerEntitlement?.expiresAt ?? billingPeriod.cycleEndAt,
      effectiveAt: billingPeriod.cycleStartAt,
      expiresAt: billingPeriod.cycleEndAt,
      grantId: "explain-charge",
      resetConfig: featurePlanVersion.resetConfig,
    },
    billingPeriod.cycleStartAt
  )?.periodKey

  if (!periodKey) {
    return Err(
      new ExplainChargeError({
        code: "PERIOD_KEY_NOT_DERIVED",
        message: "Could not derive usage period key",
        context: { billingPeriodId },
      })
    )
  }

  const query = {
    project_id: input.projectId,
    customer_id: invoice.customerId,
    feature_slug: featureSlug,
    period_key: periodKey,
    customer_entitlement_id: customerEntitlement?.id,
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
  const events = eventsResponse.data
  const lineAmount = toLedgerMinor(line.amount)
  const summary = summaryRow
    ? {
        eventCount: summaryRow.event_count,
        totalUsage: summaryRow.total_delta,
        totalAmount: summaryRow.total_amount,
        latestAmountAfter: summaryRow.latest_amount_after,
        currency: summaryRow.currency,
        amountScale: summaryRow.amount_scale,
        firstEventAt: summaryRow.first_event_at,
        lastEventAt: summaryRow.last_event_at,
        multiComponentEventCount: summaryRow.multi_component_event_count,
      }
    : {
        eventCount: 0,
        totalUsage: 0,
        totalAmount: 0,
        latestAmountAfter: 0,
        currency: line.currency,
        amountScale: LEDGER_SCALE,
        firstEventAt: null,
        lastEventAt: null,
        multiComponentEventCount: 0,
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
      customerEntitlementId: customerEntitlement?.id ?? null,
      featurePlanVersionId: featurePlanVersion.id,
    },
    summary,
    events,
    answer: buildAnswer({
      entryId: line.entryId,
      invoiceId: invoice.id,
      featureSlug,
      periodKey,
      lineAmount,
      lineCurrency: line.currency,
      summary,
    }),
    evidence: [
      { type: "ledger_line", id: line.entryId },
      { type: "billing_period", id: billingPeriodId },
      ...events.map((event) => ({ type: "meter_fact" as const, id: event.event_id })),
    ],
    pagination: {
      limit: input.limit,
      offset: input.offset,
      hasMore: events.length === input.limit,
    },
  }

  return Ok(explainChargeOutputSchema.parse(output))
}

function readStringMetadata(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function buildAnswer({
  entryId,
  invoiceId,
  featureSlug,
  periodKey,
  lineAmount,
  lineCurrency,
  summary,
}: {
  entryId: string
  invoiceId: string
  featureSlug: string
  periodKey: string
  lineAmount: number
  lineCurrency: string
  summary: ExplainChargeOutput["summary"]
}): string {
  return `Invoice line ${entryId} on invoice ${invoiceId} charged ${lineAmount} ${lineCurrency} for ${featureSlug} in period ${periodKey}. ${summary.eventCount} rated meter facts contributed ${summary.totalUsage} usage units and ${summary.totalAmount} ${summary.currency}.`
}
