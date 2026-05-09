/**
 * Pure hot-path reservation arithmetic for the EntitlementWindowDO.
 *
 * All amounts are pgledger scale-8 minor units (`$1 = 100_000_000`).
 * JS Number.MAX_SAFE_INTEGER gives ~$90M per value — sufficient for
 * per-event costs and per-period cumulative consumption. If a single
 * customer's cumulative consumed ever approaches $90M in one billing
 * period, widen to bigint.
 *
 * No imports beyond types. No I/O. No mutation — callers persist the
 * returned `newState` synchronously before any `await`.
 */

export interface ReservationState {
  /** Total money ever moved into `customer.{cid}.reserved` for this window. */
  allocationAmount: number
  /** Total money burned against the allocation (cumulative). */
  consumedAmount: number
}

export interface UsageResult {
  newState: ReservationState
  isAllowed: boolean
  needsRefill: boolean
  /** Zero when a refill isn't warranted. */
  refillRequestAmount: number
}

export interface CaptureMath {
  totalConsumedAmount: number
  totalRefundAmount: number
}

/**
 * Convert a refill threshold expressed in basis points (10_000 bps = 100%)
 * of the current allocation into an absolute scale-8 amount. Used by the DO
 * when instantiating `LocalReservation`: thresholds are configured as bps
 * so they stay sensible as allocation grows via refills, while the hot
 * path compares against an absolute `remaining < thresholdAmount`. This keeps the math safe
 */
export function thresholdFromBps(allocationAmount: number, bps: number): number {
  if (allocationAmount <= 0 || bps <= 0) return 0
  return Math.floor((allocationAmount * bps) / 10_000)
}

export class LocalReservation {
  constructor(
    private readonly thresholdAmount: number,
    private readonly chunkAmount: number
  ) {}

  /**
   * Apply a priced event's cost against the current reservation state.
   *
   * Denial is explicit — the caller (DO) must surface `WALLET_EMPTY` and
   * skip the SQLite write when `isAllowed === false`. `needsRefill` is
   * only meaningful on the allowed path; the DO uses it to gate a single
   * in-flight flush+refill request via `ctx.waitUntil`.
   */
  public applyUsage(state: ReservationState, cost: number): UsageResult {
    const remaining = state.allocationAmount - state.consumedAmount

    if (cost > remaining) {
      return {
        newState: state,
        isAllowed: false,
        needsRefill: true,
        refillRequestAmount: this.chunkAmount,
      }
    }

    const newState: ReservationState = {
      allocationAmount: state.allocationAmount,
      consumedAmount: state.consumedAmount + cost,
    }

    const newRemaining = newState.allocationAmount - newState.consumedAmount
    const needsRefill = newRemaining < this.thresholdAmount

    return {
      newState,
      isAllowed: true,
      needsRefill,
      refillRequestAmount: needsRefill ? this.chunkAmount : 0,
    }
  }

  /**
   * A successful refill extends allocation without touching consumed — the
   * ledger has already moved `grantedAmount` from `available.*` into
   * `reserved`, and the DO reflects that by raising its local allocation.
   */
  public applyRefill(state: ReservationState, grantedAmount: number): ReservationState {
    return {
      allocationAmount: state.allocationAmount + grantedAmount,
      consumedAmount: state.consumedAmount,
    }
  }

  /**
   * Final-flush math: what to recognize as consumed and what to refund
   * back to `available.purchased`. Used by the DO alarm path.
   */
  public getCaptureMath(state: ReservationState): CaptureMath {
    const refund = state.allocationAmount - state.consumedAmount
    return {
      totalConsumedAmount: state.consumedAmount,
      totalRefundAmount: Math.max(0, refund),
    }
  }
}
