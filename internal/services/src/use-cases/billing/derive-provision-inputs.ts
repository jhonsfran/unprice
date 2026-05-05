import type { Database } from "@unprice/db"
import { type PlanVersionFeature, calculatePricePerFeature } from "@unprice/db/validators"
import { toLedgerMinor } from "@unprice/money"
import type { ActivationGrant } from "./provision-period"

// Re-exports for callers that already import sizing constants from this
// module. The canonical home is `wallet/reservation-sizing` so the DO can
// import it without pulling the use-cases barrel (which transitively
// imports drizzle relations and breaks the DO test stack).
export {
  MINIMUM_FLOOR_AMOUNT,
  CEILING_AMOUNT,
  DEFAULT_REFILL_THRESHOLD_BPS,
  sizeReservation,
} from "../../wallet/reservation-sizing"

type SubscriptionRow = {
  id: string
  projectId: string
  customer: { id: string; defaultCurrency: string } | null
  phases: Array<{
    planVersion: {
      whenToBill: string
      creditLineAmount: number
      planFeatures: Array<Pick<PlanVersionFeature, "featureType" | "config" | "limit">>
    } | null
  }>
}

export interface DerivedActivationInputs {
  grants: ActivationGrant[]
}

/**
 * Derives the activation grant for a subscription's billing period.
 *
 * Unified semantic: the persisted `creditLineAmount` field is the explicit
 * **period usage allowance**. The wallet / DO / reservation flow is the same
 * regardless of `whenToBill`; only invoice timing differs.
 *
 *  - **`pay_in_advance`**: the flat-features sum is invoiced and paid
 *    upfront — that's the "subscription fee", separate from usage. The
 *    credit_line grant materializes the customer's usage allowance for the
 *    period; the DO drains it on each priced event. Period-end invoicing
 *    rates actual consumed usage and charges the saved card (advance for
 *    flat, arrears for usage — the natural shape).
 *
 *  - **`pay_in_arrear`**: nothing prepaid. The credit_line grant is the
 *    spending cap. Period-end invoicing produces a single invoice for
 *    `flat + consumed`, charged to the saved card. If no explicit allowance
 *    is configured, we derive a conservative default from finite, priced usage
 *    features by rating each feature at its configured `limit`.
 *
 * In both modes the grant `source` is `credit_line` — the platform is
 * extending credit that gets settled (or not) at period end. Failed
 * settlement → `past_due`, no reissue next period.
 *
 * For plans where the explicit allowance is 0 and no finite priced usage limit
 * exists: no usage allowance is granted at activation. Paid usage events deny
 * with `WALLET_EMPTY` until the customer tops up `purchased` balance directly
 * or the plan/customer gets an explicit allowance.
 *
 * Returns `null` when the subscription / phase / plan version is missing.
 */
export async function deriveActivationInputsFromPlan(
  db: Database,
  input: { subscriptionId: string; projectId: string }
): Promise<DerivedActivationInputs | null> {
  const sub = (await db.query.subscriptions.findFirst({
    with: {
      customer: { columns: { id: true, defaultCurrency: true } },
      phases: {
        with: {
          planVersion: {
            columns: {
              whenToBill: true,
              creditLineAmount: true,
            },
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
        // Heuristic: first phase is the active one for a newly-created or
        // newly-renewed subscription about to be activated. Multi-phase
        // scenarios should call `activateSubscription` directly with explicit
        // grants rather than relying on this derivation.
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
  const allowanceAmount = derivePeriodUsageAllowanceAmount(phase.planVersion)

  if (allowanceAmount > 0) {
    grants.push({
      amount: allowanceAmount,
      source: "credit_line",
      reason: "Period usage allowance",
    })
  }

  return { grants }
}

export function derivePeriodUsageAllowanceAmount(planVersion: {
  whenToBill: string
  creditLineAmount: number
  planFeatures?: Array<Pick<PlanVersionFeature, "featureType" | "config" | "limit">>
}): number {
  if (planVersion.creditLineAmount > 0) return planVersion.creditLineAmount
  if (planVersion.whenToBill !== "pay_in_arrear") return 0

  return (planVersion.planFeatures ?? []).reduce((total, feature) => {
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
