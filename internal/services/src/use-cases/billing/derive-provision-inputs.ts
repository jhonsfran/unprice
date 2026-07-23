import type { Database } from "@unprice/db"
import {
  type CreditLinePolicy,
  type PlanVersionFeature,
  type PlanVersionMetadata,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { toLedgerMinor } from "@unprice/money"
import type { ActivationGrant } from "./provision-period"

type SubscriptionRow = {
  id: string
  projectId: string
  customer: { id: string; defaultCurrency: string } | null
  phases: Array<{
    creditLinePolicy: CreditLinePolicy
    creditLineAmount: number | null
    planVersion: {
      metadata: PlanVersionMetadata | null
      planFeatures: Array<Pick<PlanVersionFeature, "featureType" | "config" | "limit">>
    } | null
  }>
}

export interface DerivedActivationInputs {
  grants: ActivationGrant[]
  creditLinePolicy: CreditLinePolicy
}

/**
 * Derives the activation grants for a subscription's billing period.
 *
 * Plan-included credits come from the plan version
 * (`metadata.includedCreditAmount`): the plan promises the same credit to
 * every subscriber, re-issued each period and expiring at period end.
 *
 * Credit line policy is a subscription-phase decision, not a plan-version
 * default. A plan describes the public package; the phase describes the
 * customer-specific contract for this period.
 *
 *  - **`capped + creditLineAmount > 0`**: issue exactly that amount as the
 *    period usage runway.
 *
 *  - **`capped + creditLineAmount = null`**: derive a conservative cap from
 *    finite, priced usage limits by rating each usage feature at its limit.
 *
 *  - **`capped + creditLineAmount = 0`**: issue no runway; paid usage denies
 *    with `WALLET_EMPTY` unless purchased wallet balance exists.
 *
 *  - **`uncapped`**: issue no `credit_line` wallet grant. The entitlement DO
 *    receives the phase policy and skips wallet reservation enforcement for
 *    priced events; invoicing still rates consumed usage at period end.
 *
 * Returns `null` when the subscription / phase / plan version is missing.
 */
export async function deriveActivationInputsFromPlan(
  db: Database,
  input: { subscriptionId: string; projectId: string; phaseId?: string }
): Promise<DerivedActivationInputs | null> {
  const phaseId = input.phaseId
  const sub = (await db.query.subscriptions.findFirst({
    with: {
      customer: { columns: { id: true, defaultCurrency: true } },
      phases: {
        columns: {
          creditLinePolicy: true,
          creditLineAmount: true,
        },
        with: {
          planVersion: {
            with: {
              planFeatures: {
                columns: {
                  featureType: true,
                  config: true,
                  limit: true,
                },
              },
            },
          },
        },
        // The subscription machine passes its current phase id so renewals
        // and plan changes derive from the phase that is actually active.
        // Callers without a phase id keep the single-phase heuristic: the
        // first phase is the active one for a newly-created subscription.
        ...(phaseId ? { where: (p, { eq }) => eq(p.id, phaseId) } : {}),
        limit: 1,
      },
    },
    where: (s, { and, eq }) =>
      and(eq(s.id, input.subscriptionId), eq(s.projectId, input.projectId)),
  })) as SubscriptionRow | undefined

  if (!sub || !sub.customer) return null
  const phase = sub.phases[0]
  if (!phase || !phase.planVersion) return null

  const grants: ActivationGrant[] = []

  const includedCreditAmount = phase.planVersion.metadata?.includedCreditAmount ?? 0
  if (includedCreditAmount > 0) {
    grants.push({
      amount: includedCreditAmount,
      source: "plan_included",
      reason: "Plan included credits",
    })
  }

  const allowanceAmount = derivePeriodUsageAllowanceAmount(phase)

  if (allowanceAmount > 0) {
    grants.push({
      amount: allowanceAmount,
      source: "credit_line",
      reason: "Period usage allowance",
    })
  }

  return { grants, creditLinePolicy: phase.creditLinePolicy }
}

export function derivePeriodUsageAllowanceAmount(phase: {
  creditLinePolicy: CreditLinePolicy
  creditLineAmount: number | null
  planVersion?: {
    planFeatures?: Array<Pick<PlanVersionFeature, "featureType" | "config" | "limit">>
  } | null
}): number {
  if (phase.creditLinePolicy === "uncapped") return 0
  if (phase.creditLineAmount !== null) return phase.creditLineAmount

  return (phase.planVersion?.planFeatures ?? []).reduce((total, feature) => {
    if (feature.featureType !== "usage") return total
    if (!Number.isFinite(feature.limit) || !feature.limit || feature.limit <= 0) return total

    const price = calculatePricePerFeature({
      config: feature.config,
      featureType: "usage",
      quantity: feature.limit,
    })

    if (price.err) return total

    const amount = toLedgerMinor(price.val.totalPrice.dinero)
    return amount > 0 ? total + amount : total
  }, 0)
}
