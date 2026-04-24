import type { Database } from "@unprice/db"
import type {
  ActivationPlanCredit,
  ActivationReservationSpec,
} from "./activate"

/**
 * Reservation sizing constants from the plan §"Reservation Sizing".
 * All values at pgledger scale 8 ($1 = 100_000_000 minor units).
 *
 * The formula:
 *   initial_allocation_amount = clamp(price_per_event * 1000, $1, $10)
 *
 * Rationale (from the plan doc):
 *   - 1000 events of headroom is a sane default for most meters.
 *   - The $1 floor avoids churning the ledger on meters priced in
 *     sub-cent increments (e.g. $0.0001 per API call × 1000 = $0.10
 *     would otherwise trigger a flush every few seconds).
 *   - The $10 ceiling bounds the blast radius of a single
 *     customer-empty event — we never lock more than $10 of a
 *     customer's money on a per-meter basis.
 */
export const MINIMUM_FLOOR_AMOUNT = 100_000_000 // $1
export const CEILING_AMOUNT = 1_000_000_000 // $10

/**
 * Default refill threshold: when `remaining < 20% of allocation`, the
 * DO triggers a flush-and-refill. 2000 basis points = 20%. Hot meters
 * should bump this to 50% (5000 bps) via the caller's override.
 */
export const DEFAULT_REFILL_THRESHOLD_BPS = 2000

/**
 * Derives `requestedAmount`, `refillThresholdBps`, and
 * `refillChunkAmount` for a single metered entitlement from its
 * per-event price. Pure arithmetic — no I/O.
 */
export function sizeReservation(pricePerEventAmount: number): {
  requestedAmount: number
  refillThresholdBps: number
  refillChunkAmount: number
} {
  const rawAllocation = Math.max(pricePerEventAmount * 1000, MINIMUM_FLOOR_AMOUNT)
  const requestedAmount = Math.min(rawAllocation, CEILING_AMOUNT)
  return {
    requestedAmount,
    refillThresholdBps: DEFAULT_REFILL_THRESHOLD_BPS,
    refillChunkAmount: Math.max(1, Math.floor(requestedAmount / 4)),
  }
}

type PlanFeatureRow = {
  id: string
  featureType: string
  // Feature pricing config — shape varies by featureType (flat, tier,
  // usage, package). We only read `price.dinero.amount` when present;
  // any missing fields default to 0.
  config: {
    price?: { dinero?: { amount?: number } }
  }
}

type SubscriptionRow = {
  id: string
  projectId: string
  customer: { id: string; defaultCurrency: string } | null
  phases: Array<{
    planVersion: {
      planFeatures: PlanFeatureRow[]
    } | null
  }>
}

export interface DerivedActivationInputs {
  baseFeeAmount: number
  planIncludedCredits: ActivationPlanCredit[]
  reservations: ActivationReservationSpec[]
}

/**
 * Best-effort derivation of activation money movements from a
 * subscription's plan. Loads the subscription + active phase +
 * plan_version.planFeatures and reads their pricing config.
 *
 * Conventions:
 * - **Base fee** = sum of `config.price.dinero.amount` across
 *   every `featureType: "flat"` feature on the phase's plan. A plan
 *   typically has exactly one flat "Base Plan" feature; this sums
 *   them defensively in case there are several.
 * - **Reservations** = one spec per `featureType: "usage"` feature,
 *   sized per the plan's formula using `config.price.dinero.amount`
 *   as the per-event price. `entitlementId` resolves to the plan
 *   feature id (stable per plan version). Usage features without a
 *   price (e.g. package or tier mode) are skipped and should be
 *   handled explicitly by the caller if pricing applies.
 * - **Plan-included credits** — not a first-class field yet. This
 *   helper returns `[]`; callers can splice in credits derived from
 *   plan metadata or promotional inputs.
 *
 * Returns `null` when the subscription is missing, has no active
 * phase, or has no plan version wired in.
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
            with: {
              planFeatures: true,
            },
          },
        },
        // Heuristic: first phase is the active one for a newly-created
        // subscription about to be activated. Callers with multi-phase
        // scenarios should supply explicit specs rather than relying
        // on this derivation.
        limit: 1,
      },
    },
    where: (s, { and, eq }) =>
      and(eq(s.id, input.subscriptionId), eq(s.projectId, input.projectId)),
  })) as SubscriptionRow | undefined

  if (!sub || !sub.customer) return null
  const phase = sub.phases[0]
  if (!phase || !phase.planVersion) return null

  const features = phase.planVersion.planFeatures ?? []

  let baseFeeAmount = 0
  const reservations: ActivationReservationSpec[] = []

  for (const feature of features) {
    const priceAmount = feature.config?.price?.dinero?.amount ?? 0

    if (feature.featureType === "flat") {
      baseFeeAmount += priceAmount
      continue
    }

    if (feature.featureType === "usage") {
      if (priceAmount <= 0) continue
      const sizing = sizeReservation(priceAmount)
      reservations.push({
        entitlementId: feature.id,
        requestedAmount: sizing.requestedAmount,
        refillThresholdBps: sizing.refillThresholdBps,
        refillChunkAmount: sizing.refillChunkAmount,
      })
    }

    // tier / package: price model doesn't map cleanly to a per-event
    // reservation. Left to the caller if needed.
  }

  return {
    baseFeeAmount,
    planIncludedCredits: [],
    reservations,
  }
}
