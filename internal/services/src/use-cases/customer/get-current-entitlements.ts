import type { CustomerEntitlementExtended } from "@unprice/db/validators"
import { type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { formatAmount } from "@unprice/money"
import { z } from "zod"
import { type BudgetSnapshot, type Statement, isOutcomeOf } from "../../budgets"
import { type EntitlementService, resolveEntitlementLimit } from "../../entitlements"
import type { BudgetClient } from "../budgets/budget-client"
import { payerBudgetKey } from "../budgets/compile-payer-budget"
import {
  meteredAccessOf,
  payerQuotaWindowSchema,
  quantity,
  statementAt,
  statementWindow,
} from "../budgets/payer-access"

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
  budgets: BudgetClient
  logger: Pick<Logger, "error">
  now?: () => number
}

/** The payer budget and its statements, read once for every metered entitlement. */
type PayerBudgetView = Readonly<{ budget: BudgetSnapshot; statements: readonly Statement[] }>

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
  const entitlementsResult = await deps.entitlements.getCustomerEntitlementsForCustomer({
    customerId: input.customerId,
    projectId: input.projectId,
    now: generatedAt,
  })

  if (entitlementsResult.err) {
    return entitlementsResult
  }

  const metered = entitlementsResult.val.some(
    (entitlement) => entitlement.featurePlanVersion.featureType === "usage"
  )
  const payer = metered ? await readPayerBudget(deps, input) : null
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
async function readPayerBudget(
  deps: GetCustomerCurrentEntitlementsDeps,
  input: GetCustomerCurrentEntitlementsInput
): Promise<PayerBudgetView | null> {
  const address = { projectId: input.projectId, key: payerBudgetKey(input.customerId) }
  const context = {
    context: "payer budget read failed",
    customer_id: input.customerId,
    project_id: input.projectId,
  }
  try {
    const [got, statements] = await Promise.all([
      deps.budgets.execute(address, { type: "get" }),
      deps.budgets.execute(address, { type: "statements" }),
    ])
    if (got.err || statements.err) {
      const error = got.err ?? statements.err
      if (error && error.rejection.code !== "BUDGET_NOT_FOUND") deps.logger.error(error, context)
      return null
    }
    if (!isOutcomeOf(got.val, "get") || !isOutcomeOf(statements.val, "statements")) {
      throw new Error("payer budget answered another verb")
    }
    return { budget: got.val.budget, statements: statements.val.statements }
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
      allowed: true,
      limit: resolveEntitlementLimit({
        configuredLimit: entitlement.featurePlanVersion.limit ?? null,
        featureType: entitlement.featurePlanVersion.featureType,
        grants: entitlement.grants ?? [],
      }),
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
