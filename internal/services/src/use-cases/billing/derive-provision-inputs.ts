import type { Database } from "@unprice/db"
import type {
  CreditLinePolicy,
  Currency,
  PlanVersionFeature,
  PlanVersionMetadata,
  RateRow,
} from "@unprice/db/validators"
import { parseAmount } from "@unprice/money"
import { priceQuantity } from "../../pricing"
import type { RateCardService } from "../../rate-cards"
import type { ActivationGrant } from "./provision-period"

export type DeriveActivationInputsDeps = {
  db: Database
  rateCards: Pick<RateCardService, "rowsForVersions">
}

type AllowanceFeature = Pick<PlanVersionFeature, "featureType" | "limit" | "included"> & {
  feature: { slug: string }
}

type SubscriptionRow = {
  id: string
  projectId: string
  customer: { id: string; defaultCurrency: string } | null
  phases: Array<{
    creditLinePolicy: CreditLinePolicy
    creditLineAmount: number | null
    planVersion: {
      id: string
      currency: Currency
      metadata: PlanVersionMetadata | null
      planFeatures: AllowanceFeature[]
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
 *    finite, priced usage limits by pricing each usage feature's limit, past
 *    its included units, with the dearest row of the plan version's rate card
 *    (ADR-0008 D2).
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
  deps: DeriveActivationInputsDeps,
  input: { subscriptionId: string; projectId: string; phaseId?: string }
): Promise<DerivedActivationInputs | null> {
  const phaseId = input.phaseId
  const sub = (await deps.db.query.subscriptions.findFirst({
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
                  limit: true,
                  included: true,
                },
                with: { feature: { columns: { slug: true } } },
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

  const { planVersion } = phase
  const rows =
    phase.creditLinePolicy === "capped" && phase.creditLineAmount === null
      ? ((await deps.rateCards.rowsForVersions(input.projectId, [planVersion], Date.now())).get(
          planVersion.id
        ) ?? [])
      : []
  const allowanceAmount = derivePeriodUsageAllowanceAmount({
    ...phase,
    planVersion: { ...phase.planVersion, rows },
  })

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
    planFeatures?: AllowanceFeature[]
    /** The plan version's card rows in effect now. */
    rows?: readonly RateRow[]
  } | null
}): number {
  if (phase.creditLinePolicy === "uncapped") return 0
  if (phase.creditLineAmount !== null) return phase.creditLineAmount

  const rows = phase.planVersion?.rows ?? []
  return (phase.planVersion?.planFeatures ?? []).reduce((total, feature) => {
    if (feature.featureType !== "usage") return total
    if (!Number.isFinite(feature.limit) || !feature.limit || feature.limit <= 0) return total

    const included = feature.included ? parseAmount(feature.included) : null
    const limit = parseAmount(String(feature.limit))
    if (!limit.ok) return total
    const billable = included?.ok ? limit.amount - included.amount : limit.amount
    if (billable <= BigInt(0)) return total

    const amount = rows
      .filter((row) => row.featureSlug === feature.feature.slug && row.price.type !== "flat")
      .reduce((dearest, row) => {
        const priced = priceQuantity(row, billable)
        return priced > dearest ? priced : dearest
      }, BigInt(0))
    return amount > BigInt(0) ? total + Number(amount) : total
  }, 0)
}
