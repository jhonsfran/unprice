/**
 * Reservation sizing constants and the pure sizing function used by both
 * the EntitlementWindowDO (lazy reservation bootstrap) and any
 * reconciler / tooling that needs to derive a reservation shape from a
 * per-event price. All values at pgledger scale 8.
 *
 * Lifted out of `use-cases/subscription/derive-activation-inputs` so the
 * DO can import without pulling the full use-cases barrel — the barrel
 * transitively imports drizzle-orm relations, which the DO test stack
 * doesn't (and shouldn't) mock.
 *
 * Formula:
 *   initial_allocation_amount = clamp(price_per_event * 1000, $1, $10)
 *
 * Rationale:
 *   - 1000 events of headroom is a sane default for most meters.
 *   - The $1 floor avoids churning the ledger on meters priced in
 *     sub-cent increments (e.g. $0.0001 per API call × 1000 = $0.10
 *     would otherwise trigger a flush every few seconds).
 *   - The $10 ceiling bounds the blast radius of a single
 *     customer-empty event — never lock more than $10 of a customer's
 *     money on a per-meter basis.
 */
export const MINIMUM_FLOOR_AMOUNT = 100_000_000 // $1
export const CEILING_AMOUNT = 1_000_000_000 // $10

/**
 * Default refill threshold: when `remaining < 20% of allocation`, the DO
 * triggers a flush-and-refill. 2000 basis points = 20%. Hot meters
 * should bump this to 50% (5000 bps) via the caller's override.
 */
export const DEFAULT_REFILL_THRESHOLD_BPS = 2000

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
