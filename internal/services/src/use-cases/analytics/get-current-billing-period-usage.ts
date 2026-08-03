import type { Analytics, BillingPeriodUsageRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { BaseError, Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { z } from "zod"

export const getCurrentBillingPeriodUsageInputSchema = z.object({
  customerId: z.string(),
  projectId: z.string(),
})

const currentBillingPeriodUsageSchema = z.object({
  cycleEndAt: z.number().int(),
  cycleStartAt: z.number().int(),
  id: z.string(),
  usage: z.array(
    z.object({
      amount: z.number().int(),
      currency: z.string().length(3),
      featureSlug: z.string(),
      usage: z.number(),
    })
  ),
})

export const getCurrentBillingPeriodUsageOutputSchema = z.object({
  billingPeriods: z.array(currentBillingPeriodUsageSchema),
})

export type GetCurrentBillingPeriodUsageInput = z.infer<
  typeof getCurrentBillingPeriodUsageInputSchema
>
export type GetCurrentBillingPeriodUsageOutput = z.infer<
  typeof getCurrentBillingPeriodUsageOutputSchema
>

export type GetCurrentBillingPeriodUsageAnalytics = Pick<
  Analytics,
  "getBillingPeriodUsage" | "getBillingPeriodUsageCoverage"
>

export type GetCurrentBillingPeriodUsageDeps = {
  analytics: GetCurrentBillingPeriodUsageAnalytics
  db: Database
  now?: () => number
}

export class BillingPeriodUsageCoverageError extends BaseError<{
  billingPeriodIds: string[]
  customerId: string
  projectId: string
  start: number
  end: number
}> {
  public readonly retry = false
  public readonly name = BillingPeriodUsageCoverageError.name

  constructor(context: {
    billingPeriodIds: string[]
    customerId: string
    projectId: string
    start: number
    end: number
  }) {
    super({
      message:
        "Current billing-period usage is unavailable until pre-attribution usage is migrated.",
      context,
    })
  }
}

type GetCurrentBillingPeriodUsageFailure = BillingPeriodUsageCoverageError | FetchError

export async function getCurrentBillingPeriodUsage(
  deps: GetCurrentBillingPeriodUsageDeps,
  rawInput: GetCurrentBillingPeriodUsageInput
): Promise<Result<GetCurrentBillingPeriodUsageOutput, GetCurrentBillingPeriodUsageFailure>> {
  const input = getCurrentBillingPeriodUsageInputSchema.parse(rawInput)
  const now = deps.now?.() ?? Date.now()
  const billingPeriods = await deps.db.query.billingPeriods.findMany({
    columns: {
      id: true,
      cycleStartAt: true,
      cycleEndAt: true,
    },
    where: (table, { and, eq, gt, lte }) =>
      and(
        eq(table.projectId, input.projectId),
        eq(table.customerId, input.customerId),
        eq(table.status, "pending"),
        lte(table.cycleStartAt, now),
        gt(table.cycleEndAt, now)
      ),
  })

  if (billingPeriods.length === 0) {
    return Ok(getCurrentBillingPeriodUsageOutputSchema.parse({ billingPeriods: [] }))
  }

  const billingPeriodIds = billingPeriods.map((period) => period.id)
  const start = Math.min(...billingPeriods.map((period) => period.cycleStartAt))
  const end = Math.max(...billingPeriods.map((period) => period.cycleEndAt))
  const analyticsInput = {
    project_id: input.projectId,
    customer_id: input.customerId,
    start,
    end,
  }
  const [usageResult, coverageResult] = await Promise.all([
    wrapResult(
      deps.analytics.getBillingPeriodUsage({
        ...analyticsInput,
        billing_period_ids: billingPeriodIds,
      }),
      (error) =>
        toBillingUsageFetchError({
          error,
          pipe: "v1_get_billing_period_usage",
          projectId: input.projectId,
          customerId: input.customerId,
          billingPeriodIds,
        })
    ),
    wrapResult(deps.analytics.getBillingPeriodUsageCoverage(analyticsInput), (error) =>
      toBillingUsageFetchError({
        error,
        pipe: "v1_get_billing_period_usage_coverage",
        projectId: input.projectId,
        customerId: input.customerId,
        billingPeriodIds,
      })
    ),
  ])

  if (usageResult.err) {
    return Err(usageResult.err)
  }

  if (coverageResult.err) {
    return Err(coverageResult.err)
  }

  const coverage = coverageResult.val.data
  const coverageRow = coverage?.[0]
  if (!coverageRow || coverage?.length !== 1) {
    return Err(
      toBillingUsageFetchError({
        error: new Error("Expected one billing-period usage coverage row"),
        pipe: "v1_get_billing_period_usage_coverage",
        projectId: input.projectId,
        customerId: input.customerId,
        billingPeriodIds,
      })
    )
  }

  if (coverageRow.unattributed_fact_count > 0) {
    return Err(
      new BillingPeriodUsageCoverageError({
        billingPeriodIds,
        customerId: input.customerId,
        projectId: input.projectId,
        start,
        end,
      })
    )
  }

  return Ok(
    getCurrentBillingPeriodUsageOutputSchema.parse({
      billingPeriods: joinUsageByPeriod(billingPeriods, usageResult.val.data ?? []),
    })
  )
}

function joinUsageByPeriod(
  billingPeriods: Array<{ id: string; cycleStartAt: number; cycleEndAt: number }>,
  usageRows: BillingPeriodUsageRow[]
): GetCurrentBillingPeriodUsageOutput["billingPeriods"] {
  const usageByPeriodId = new Map<string, BillingPeriodUsageRow[]>()
  for (const row of usageRows) {
    const usage = usageByPeriodId.get(row.billing_period_id) ?? []
    usage.push(row)
    usageByPeriodId.set(row.billing_period_id, usage)
  }

  return billingPeriods.map((period) => ({
    id: period.id,
    cycleStartAt: period.cycleStartAt,
    cycleEndAt: period.cycleEndAt,
    usage: (usageByPeriodId.get(period.id) ?? []).map((row) => ({
      featureSlug: row.feature_slug,
      usage: row.usage,
      amount: row.amount,
      currency: row.currency,
    })),
  }))
}

function toBillingUsageFetchError({
  error,
  pipe,
  projectId,
  customerId,
  billingPeriodIds,
}: {
  error: Error
  pipe: "v1_get_billing_period_usage" | "v1_get_billing_period_usage_coverage"
  projectId: string
  customerId: string
  billingPeriodIds: string[]
}): FetchError {
  return new FetchError({
    message: error.message,
    retry: true,
    context: {
      url: `tinybird:${pipe}`,
      method: "GET",
      projectId,
      customerId,
      billingPeriodIds,
    },
  })
}
