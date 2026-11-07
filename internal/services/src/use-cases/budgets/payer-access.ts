import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import { type Amount, type SignedAmount, formatAmount } from "@unprice/money"
import { z } from "zod"
import {
  type BudgetSnapshot,
  type LimitBalance,
  type Statement,
  type UnPriceBudgetError,
  isOutcomeOf,
  windowBounds,
} from "../../budgets"
import { type EntitlementService, resolveEntitlementLimit } from "../../entitlements"
import type { BudgetClient } from "./budget-client"
import { payerBudgetKey } from "./compile-payer-budget"

/** Why a feature is not usable right now. */
export const PAYER_ACCESS_DENIALS = ["NO_ENTITLEMENT", "LIMIT_EXCEEDED", "BUDGET_CLOSED"] as const

/** The window a quantity limit counts in, or the billing period a statement covers. */
export const payerQuotaWindowSchema = z.object({
  periodKey: z.string(),
  startAt: z.number().int(),
  /** Exclusive; null for a limit that never resets. */
  endAt: z.number().int().nullable(),
})

export type PayerQuotaWindow = z.infer<typeof payerQuotaWindowSchema>

export const checkPayerAccessInputSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  featureSlug: z.string().min(1),
  now: z.number().int(),
})

export const checkPayerAccessOutputSchema = z.object({
  featureSlug: z.string(),
  allowed: z.boolean(),
  rejectionReason: z.enum(PAYER_ACCESS_DENIALS).optional(),
  /** The payer budget meters the feature: usage and limit are live. */
  metered: z.boolean(),
  /** Quantity consumed in the limit's current window. */
  usage: z.number().optional(),
  /** The quantity limit, or the subscribed quantity of a seat or package; null when unlimited. */
  limit: z.number().nullable(),
  quotaWindow: payerQuotaWindowSchema.nullable(),
})

export type CheckPayerAccessInput = z.infer<typeof checkPayerAccessInputSchema>
export type CheckPayerAccessOutput = z.infer<typeof checkPayerAccessOutputSchema>

export type CheckPayerAccessDeps = {
  budgets: BudgetClient
  entitlements: Pick<EntitlementService, "getCustomerEntitlementsForCustomer">
}

/** A metered feature's access as its payer budget holds it. */
export type MeteredAccess = Readonly<{
  allowed: boolean
  rejectionReason?: (typeof PAYER_ACCESS_DENIALS)[number]
  usage?: number
  limit: number | null
  quotaWindow: PayerQuotaWindow | null
}>

/**
 * Whether a customer may use a feature now. A feature the payer budget meters answers from the
 * budget's balance: a hard quantity limit with no room, or a closed budget, denies it. The budget
 * holds metered features only, so any other feature (flat, seats, packages) answers from the
 * customer's entitlement in force.
 */
export async function checkPayerAccess(
  deps: CheckPayerAccessDeps,
  input: CheckPayerAccessInput
): Promise<Result<CheckPayerAccessOutput, UnPriceBudgetError | FetchError>> {
  const { projectId, customerId, featureSlug, now } = input
  const got = await deps.budgets.execute(
    { projectId, key: payerBudgetKey(customerId) },
    { type: "get" }
  )
  if (got.err && got.err.rejection.code !== "BUDGET_NOT_FOUND") return Err(got.err)
  if (got.val && isOutcomeOf(got.val, "get")) {
    const metered = meteredAccessOf(got.val.budget, featureSlug)
    if (metered) return Ok({ featureSlug, metered: true, ...metered })
  }

  const entitlements = await deps.entitlements.getCustomerEntitlementsForCustomer({
    customerId,
    projectId,
    now,
  })
  if (entitlements.err) return Err(entitlements.err)
  const entitlement = entitlements.val.find(
    (candidate) =>
      candidate.featurePlanVersion.feature.slug === featureSlug &&
      candidate.featurePlanVersion.featureType !== "usage"
  )
  if (!entitlement) {
    return Ok({
      featureSlug,
      allowed: false,
      rejectionReason: "NO_ENTITLEMENT",
      metered: false,
      limit: null,
      quotaWindow: null,
    })
  }
  return Ok({
    featureSlug,
    allowed: true,
    metered: false,
    limit: resolveEntitlementLimit({
      configuredLimit: entitlement.featurePlanVersion.limit ?? null,
      featureType: entitlement.featurePlanVersion.featureType,
      grants: entitlement.grants ?? [],
    }),
    quotaWindow: null,
  })
}

/**
 * A feature's access from its payer budget; null when the budget does not meter it. The feature's
 * quantity limit that binds is the hard one with the least room, else a soft one.
 */
export function meteredAccessOf(budget: BudgetSnapshot, featureSlug: string): MeteredAccess | null {
  if (!budget.pricing?.features.some((feature) => feature.slug === featureSlug)) return null
  const limit = bindingLimit(budget.balance.limits, featureSlug)
  const exhausted = limit?.enforce === "hard" && limit.remaining <= BigInt(0)
  const reason = budget.closed ? "BUDGET_CLOSED" : exhausted ? "LIMIT_EXCEEDED" : undefined
  return {
    allowed: reason === undefined,
    ...(reason && { rejectionReason: reason }),
    ...(limit && { usage: quantity(limit.consumed) }),
    limit: limit ? quantity(limit.amount) : null,
    quotaWindow: limit ? limitWindow(budget, limit) : null,
  }
}

/** The open statement of a feature that covers `at`, if billing registered one. */
export function statementAt(
  statements: readonly Statement[],
  featureSlug: string,
  at: number
): Statement | undefined {
  return statements.find(
    (statement) =>
      statement.featureSlug === featureSlug &&
      statement.state === "open" &&
      statement.start <= at &&
      at < statement.end
  )
}

export function statementWindow(statement: Statement): PayerQuotaWindow {
  return { periodKey: statement.periodId, startAt: statement.start, endAt: statement.end }
}

/** A budget quantity (base units) as the number of units it counts. */
export function quantity(amount: Amount | SignedAmount): number {
  return Number(formatAmount(amount))
}

function bindingLimit(limits: readonly LimitBalance[], featureSlug: string) {
  const own = limits.filter(
    (limit) => limit.measure.type === "quantity" && limit.measure.feature === featureSlug
  )
  const byRoom = (a: LimitBalance, b: LimitBalance) =>
    a.remaining < b.remaining ? -1 : a.remaining > b.remaining ? 1 : 0
  return (
    own.filter((limit) => limit.enforce === "hard").sort(byRoom)[0] ?? own.sort(byRoom)[0] ?? null
  )
}

function limitWindow(budget: BudgetSnapshot, limit: LimitBalance): PayerQuotaWindow {
  const anchor = budget.limits.find((configured) => configured.id === limit.id)?.anchor
  const bounds = windowBounds(
    { window: limit.window, ...(anchor !== undefined && { anchor }) },
    budget.balance.asOf
  )
  return { periodKey: limit.id, startAt: bounds.start, endAt: bounds.end }
}
