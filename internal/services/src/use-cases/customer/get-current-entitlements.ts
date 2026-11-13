import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { formatAmount } from "@unprice/money"
import { z } from "zod"
import type { EntitlementService } from "../../entitlements"
import type { BudgetClient } from "../budgets/budget-client"
import {
  meteredAccessOf,
  payerQuotaWindowSchema,
  quantity,
  statementAt,
  statementWindow,
  staticAccess,
} from "../budgets/payer-access"
import { type PayerBudgetView, readPayerBudget } from "../budgets/read-payer-budget"

const currentEntitlementBaseShape = {
  id: z.string(),
  featureSlug: z.string(),
  featureTitle: z.string(),
  featureType: z.enum(["flat", "tier", "package", "usage"]),
  unitOfMeasure: z.string(),
  grantCount: z.number().int().nonnegative(),
}

const availableCurrentEntitlementSchema = z.object({
  ...currentEntitlementBaseShape,
  status: z.literal("available"),
  allowed: z.boolean(),
  limit: z.number().nullable(),
  usage: z.number().optional(),
  usagePercent: z.number().nullable().optional(),
  quotaWindow: payerQuotaWindowSchema.nullable().optional(),
  /** What the current billing period's usage costs so far, priced at ingestion. */
  spending: z
    .object({
      /** The payer budget's unit: money:<code>, credits:<id>, or units:<slug>. */
      unit: z.string(),
      /** A decimal amount in that unit. */
      amount: z.string(),
    })
    .optional(),
})

const unavailableCurrentEntitlementSchema = z.object({
  ...currentEntitlementBaseShape,
  status: z.literal("unavailable"),
})

export const customerCurrentEntitlementSchema = z.discriminatedUnion("status", [
  availableCurrentEntitlementSchema,
  unavailableCurrentEntitlementSchema,
])

export const getCustomerCurrentEntitlementsInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const getCustomerCurrentEntitlementsOutputSchema = z.object({
  customerId: z.string(),
  generatedAt: z.number().int(),
  entitlements: customerCurrentEntitlementSchema.array(),
})

export type GetCustomerCurrentEntitlementsInput = z.infer<
  typeof getCustomerCurrentEntitlementsInputSchema
>
export type GetCustomerCurrentEntitlementsOutput = z.infer<
  typeof getCustomerCurrentEntitlementsOutputSchema
>

export type GetCustomerCurrentEntitlementsDeps = {
  entitlements: Pick<EntitlementService, "getCustomerEntitlementsForCustomer">
  budgets: Pick<BudgetClient, "execute">
  logger: Pick<Logger, "error">
  now?: () => number
}

/**
 * The customer's entitlements in force, each metered one with its live state from the payer budget
 * at `unprice:customer:<customerId>` (ADR-0008 D1): its quantity limit, the usage in that limit's
 * window (or in the open billing period when it has none), and what that period costs so far. A
 * metered entitlement the budget cannot answer for is `unavailable`.
 */
export async function getCustomerCurrentEntitlements(
  deps: GetCustomerCurrentEntitlementsDeps,
  rawInput: GetCustomerCurrentEntitlementsInput
): Promise<Result<GetCustomerCurrentEntitlementsOutput, FetchError>> {
  const input = getCustomerCurrentEntitlementsInputSchema.parse(rawInput)
  const generatedAt = deps.now?.() ?? Date.now()
  const [entitlementsResult, payer] = await Promise.all([
    deps.entitlements.getCustomerEntitlementsForCustomer({
      customerId: input.customerId,
      projectId: input.projectId,
      now: generatedAt,
    }),
    readPayerBudgetOrUnavailable(deps, input),
  ])
  if (entitlementsResult.err) return entitlementsResult
  const rows = entitlementsResult.val.map((entitlement) =>
    resolveCurrentEntitlement({ entitlement, generatedAt, payer })
  )

  return Ok(
    getCustomerCurrentEntitlementsOutputSchema.parse({
      customerId: input.customerId,
      generatedAt,
      entitlements: rows,
    })
  )
}

/** Null when the customer has no payer budget yet, or it could not be read. */
async function readPayerBudgetOrUnavailable(
  deps: GetCustomerCurrentEntitlementsDeps,
  input: GetCustomerCurrentEntitlementsInput
): Promise<PayerBudgetView | null> {
  const context = {
    context: "payer budget read failed",
    customer_id: input.customerId,
    project_id: input.projectId,
  }
  try {
    const result = await readPayerBudget(deps.budgets, input, { statements: true })
    if (result.err) {
      deps.logger.error(result.err, context)
      return null
    }
    return result.val
  } catch (error) {
    deps.logger.error(error instanceof Error ? error : new Error(String(error)), context)
    return null
  }
}

function resolveCurrentEntitlement(params: {
  entitlement: CustomerEntitlementExtended
  generatedAt: number
  payer: PayerBudgetView | null
}): z.infer<typeof customerCurrentEntitlementSchema> {
  const { entitlement, generatedAt, payer } = params
  const base = {
    id: entitlement.id,
    featureSlug: entitlement.featurePlanVersion.feature.slug,
    featureTitle: entitlement.featurePlanVersion.feature.title,
    featureType: entitlement.featurePlanVersion.featureType,
    unitOfMeasure: entitlement.featurePlanVersion.unitOfMeasure,
    grantCount: entitlement.grants?.length ?? 0,
  }

  if (entitlement.featurePlanVersion.featureType !== "usage") {
    return {
      ...base,
      status: "available",
      ...staticAccess(entitlement),
    }
  }

  const access = payer ? meteredAccessOf(payer.budget, base.featureSlug) : null
  if (!payer || !access) {
    return { ...base, status: "unavailable" }
  }

  const statement = statementAt(payer.statements, base.featureSlug, generatedAt)
  const usage = access.usage ?? (statement ? quantity(statement.quantity) : 0)
  return {
    ...base,
    status: "available",
    allowed: access.allowed,
    limit: access.limit,
    usage,
    usagePercent:
      access.limit !== null && access.limit > 0
        ? Math.min(100, (usage / access.limit) * 100)
        : null,
    quotaWindow: access.quotaWindow ?? (statement ? statementWindow(statement) : null),
    ...(statement && {
      spending: { unit: payer.budget.unit, amount: formatAmount(statement.amount) },
    }),
  }
}
