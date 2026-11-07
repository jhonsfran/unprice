import type { Database } from "@unprice/db"
import { RECORD_ACCEPT_WINDOW_MS } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { UnPriceBudgetError } from "../../budgets"
import type { ServiceContext } from "../../context"
import {
  type PayerBudgetSource,
  type UnPricePayerBudgetError,
  compilePayerBudget,
} from "./compile-payer-budget"
import { type ExecuteBudgetCommandDeps, executeBudgetCommand } from "./execute-budget-command"

export const syncPayerBudgetInputSchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
})

export const syncPayerBudgetOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    key: z.string(),
    version: z.number().int(),
    /** The config changes the upsert made; empty when the budget already matched. */
    changes: z.array(z.string()),
    statements: z.number().int().nonnegative(),
  }),
  /**
   * The pricing or unit change waits for open holds and leases (RESERVATIONS_OPEN); nothing was
   * written. The caller retries, or leaves it to the next billing job.
   */
  z.object({ status: z.literal("reservations_open"), key: z.string() }),
])

export type SyncPayerBudgetInput = z.infer<typeof syncPayerBudgetInputSchema>
export type SyncPayerBudgetOutput = z.infer<typeof syncPayerBudgetOutputSchema>

export type SyncPayerBudgetDeps = Omit<ExecuteBudgetCommandDeps, "services"> & {
  db: Database
  services: Pick<ServiceContext, "budgetCatalog" | "rateCards">
  logger: Logger
  /** The compile's clock; tests pass a fake one. */
  now?: () => number
}

/**
 * Compiles the customer's subscription into its payer budget and sends it straight to the budget
 * (ADR-0008 D1): the upsert sets pricing and may loosen, then the billing periods register as
 * statements. One attempt: a pricing change refused while holds are open answers
 * `reservations_open` and writes nothing, so the caller decides whether to wait
 * (`syncPayerBudgetWithRetry`). Any other failure is logged at error level and returned.
 */
export async function syncPayerBudget(
  deps: SyncPayerBudgetDeps,
  input: SyncPayerBudgetInput
): Promise<Result<SyncPayerBudgetOutput, UnPriceBudgetError | UnPricePayerBudgetError>> {
  const now = deps.now ?? Date.now
  const { projectId, customerId } = input
  const context = { projectId, customerId }

  const source = await loadPayerBudgetSource(deps, { projectId, customerId, now: now() })
  const compiled = compilePayerBudget(source)
  if (compiled.err) {
    deps.logger.error(compiled.err, { context: "payer budget compile failed", ...context })
    return compiled
  }
  const { budget, statements } = compiled.val
  const address = { projectId, key: budget.key }
  const upserted = await executeBudgetCommand(deps, {
    ...address,
    request: {
      type: "upsert",
      unit: budget.unit,
      config: budget.config,
      mayLoosen: true,
      setsPricing: true,
    },
  })
  if (upserted.err?.rejection.code === "RESERVATIONS_OPEN") {
    return Ok({ status: "reservations_open", key: budget.key })
  }
  if (upserted.err) {
    deps.logger.error(upserted.err, { context: "payer budget upsert failed", ...context })
    return Err(upserted.err)
  }

  if (statements.length > 0) {
    const registered = await executeBudgetCommand(deps, {
      ...address,
      request: { type: "registerStatements", statements },
    })
    if (registered.err) {
      deps.logger.error(registered.err, {
        context: "payer budget statement registration failed",
        ...context,
      })
      return Err(registered.err)
    }
  }

  const { budget: stored, changes } = upserted.val
  return Ok({
    status: "synced",
    key: budget.key,
    version: stored.version,
    changes: changes.map((change) => change.change),
    statements: statements.length,
  })
}

/**
 * The customer's phases that still matter at `now` (open, or ended recently enough for a late
 * record), their metered items with billing periods, the plan version's card per phase currency,
 * and the customer's grants in force.
 */
async function loadPayerBudgetSource(
  deps: Pick<SyncPayerBudgetDeps, "db" | "services">,
  input: { projectId: string; customerId: string; now: number }
): Promise<PayerBudgetSource> {
  const { projectId, customerId, now } = input
  const cutoff = now - RECORD_ACCEPT_WINDOW_MS
  const subscriptions = await deps.db.query.subscriptions.findMany({
    where: (subscription, ops) =>
      ops.and(
        ops.eq(subscription.projectId, projectId),
        ops.eq(subscription.customerId, customerId)
      ),
    with: {
      phases: {
        where: (phase, ops) => ops.or(ops.isNull(phase.endAt), ops.gt(phase.endAt, cutoff)),
        with: {
          planVersion: { columns: { currency: true } },
          items: {
            with: { featurePlanVersion: { with: { feature: { columns: { slug: true } } } } },
          },
          periods: { where: (period, ops) => ops.gt(period.cycleEndAt, cutoff) },
        },
      },
    },
  })

  const phases: PayerBudgetSource["phases"] = []
  const inForce = subscriptions.flatMap((subscription) =>
    subscription.phases.map((phase) => ({ phase, subscriptionEndsAt: endOf(subscription) }))
  )
  for (const { phase, subscriptionEndsAt } of inForce) {
    const { currency } = phase.planVersion
    const card = await deps.services.rateCards.cardForPlanVersion(
      projectId,
      phase.planVersionId,
      currency
    )
    phases.push({
      id: phase.id,
      startAt: phase.startAt,
      endAt: phase.endAt,
      subscriptionEndsAt,
      billingAnchor: phase.billingAnchor,
      creditLinePolicy: phase.creditLinePolicy,
      currency,
      card: card && { id: card.cardId, unit: card.unit },
      items: phase.items.map((item) => {
        const planFeature = item.featurePlanVersion
        return {
          feature: {
            slug: planFeature.feature.slug,
            featureType: planFeature.featureType,
            meterConfig: planFeature.meterConfig ?? null,
            included: planFeature.included,
            billingConfig: planFeature.billingConfig,
            resetConfig: planFeature.resetConfig ?? null,
            overageStrategy: planFeature.metadata?.overageStrategy ?? "none",
          },
          billingPeriods: phase.periods
            .filter((period) => period.subscriptionItemId === item.id)
            .map((period) => ({
              id: period.id,
              statementKey: period.statementKey,
              start: period.cycleStartAt,
              end: period.cycleEndAt,
              trial: period.type === "trial",
            })),
        }
      }),
    })
  }

  const entitlements = await deps.db.query.customerEntitlements.findMany({
    where: (entitlement, ops) =>
      ops.and(
        ops.eq(entitlement.projectId, projectId),
        ops.eq(entitlement.customerId, customerId),
        ops.or(ops.isNull(entitlement.expiresAt), ops.gt(entitlement.expiresAt, now))
      ),
    with: {
      grants: true,
      featurePlanVersion: { with: { feature: { columns: { slug: true } } } },
    },
  })
  const grants = entitlements.flatMap((entitlement) =>
    entitlement.grants.map((grant) => ({
      featureSlug: entitlement.featurePlanVersion.feature.slug,
      allowanceUnits: grant.allowanceUnits,
      effectiveAt: grant.effectiveAt,
      expiresAt: grant.expiresAt,
    }))
  )

  return { projectId, customerId, now, phases, grants }
}

/**
 * When a subscription stops: its end, or the time a cancel recorded, whichever comes first; null
 * while it runs.
 */
function endOf(subscription: {
  status: string
  endAt: number | null
  metadata: { dates?: { cancelAt?: number } } | null
}): number | null {
  const canceledAt =
    subscription.status === "canceled" ? subscription.metadata?.dates?.cancelAt : undefined
  const ends = [subscription.endAt, canceledAt].filter((at): at is number => typeof at === "number")
  return ends.length === 0 ? null : Math.min(...ends)
}
