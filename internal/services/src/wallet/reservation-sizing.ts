/**
 * Pure reservation policy arithmetic for entitlement wallet holds.
 *
 * All amounts are integer pgledger minor units. The default policy uses
 * scale-8 values ($1 = 100_000_000), matching the existing wallet ledger
 * scale. Keep this module free of DO, DB, WalletService, and logging imports.
 */

const BPS_DENOMINATOR = 10_000 // bps stands for basis points and represents a percentage

export const DEFAULT_MAX_COLD_START_AMOUNT = 100_000_000
export const DEFAULT_MAX_OUTSTANDING_AMOUNT = 3_000_000_000

export type ReservationPolicy = {
  /**
   * Primary tuning knob: how often an active entitlement should roughly refill.
   * Larger values reduce ledger writes; smaller values keep less money reserved.
   */
  targetRefillIntervalMs: number
  /** Cold-start runway before we know the actual spend velocity. */
  coldStartEventsToCover: number
  /** Ceiling for event-count cold start sizing. This is not a minimum floor. */
  maxColdStartAmount: number
  /** Optional product/operator floor. Defaults to 0 so micro-priced meters stay small. */
  softFloorAmount: number
  /** Hard safety cap for one entitlement window's outstanding local runway. */
  maxOutstandingAmount: number
  /** Remaining/target ratio that triggers a top-up check. */
  refillThresholdBps: number
  /** Extra spend buffer for time between deciding to refill and the ledger write landing. */
  refillLatencyBufferMs: number
  /** EWMA smoothing factor in basis points. Higher values react faster. */
  ewmaAlphaBps: number
  /** Smallest positive reservation/refill amount allowed by local policy. */
  minAtomicAmount: number
}

export const DEFAULT_RESERVATION_POLICY: ReservationPolicy = {
  targetRefillIntervalMs: 10 * 60_000, // 10 minutes
  coldStartEventsToCover: 25, // 25 events
  maxColdStartAmount: DEFAULT_MAX_COLD_START_AMOUNT,
  softFloorAmount: 0,
  maxOutstandingAmount: DEFAULT_MAX_OUTSTANDING_AMOUNT,
  refillThresholdBps: 2000, // 20% of target reservation amount
  refillLatencyBufferMs: 5_000,
  ewmaAlphaBps: 2000, // 20% of observed spend per target interval
  minAtomicAmount: 1,
}

export type InitialReservationInput = {
  pricePerEventAmount: number
  currentEventCostAmount: number
  policy?: ReservationPolicy
}

export type InitialReservationDecision = {
  requestedAmount: number
  targetReservationAmount: number
  canCoverCurrentEvent: boolean
  requiredAmount: number
}

export type SpendVelocityInput = {
  previousSpendEwmaAmount: number
  previousLastRateSampledAtMs: number | null
  flushAmount: number
  nowMs: number
  policy?: ReservationPolicy
}

export type SpendVelocityState = {
  spendEwmaAmount: number
  lastRateSampledAtMs: number
}

export type RefillDecisionInput = {
  allocationAmount: number
  consumedAmount: number
  flushedAmount: number
  targetReservationAmount: number
  spendEwmaAmount: number
  lastRateSampledAtMs: number | null
  maxEventCostAmount: number
  currentEventCostAmount: number
  pricePerEventAmount: number
  policy?: ReservationPolicy
}

export type RefillDecision = {
  targetReservationAmount: number
  watermarkAmount: number
  remainingAmount: number
  needsRefill: boolean
  refillAmount: number
  maxEventCostAmount: number
}

export type EffectiveWalletCostInput = {
  requestedCostAmount: number
  consumedAmount: number
  flushedAmount: number
  clampNegativeCostToUnflushed?: boolean
}

export type EffectiveWalletCost = {
  effectiveCostAmount: number
  clampedNegativeAmount: number
}

export type TopUpRefillInput = {
  remainingAmount: number
  targetReservationAmount: number
  maxOutstandingAmount: number
}

export type SyncGrowRefillInput = {
  remainingAmount: number
  currentEventCostAmount: number
  targetReservationAmount: number
  maxOutstandingAmount: number
}

/**
 * Computes the first wallet hold for an entitlement window.
 *
 * This deliberately does not apply a universal $1 minimum. The first target is
 * the larger of: current event cost, a small cold-start event count, and an
 * optional soft floor. The cold-start event count is capped, but the current
 * event cost can exceed that cap so expensive single events are still fundable
 * when maxOutstandingAmount allows it.
 */
export function computeInitialReservation(
  input: InitialReservationInput
): InitialReservationDecision {
  const policy = input.policy ?? DEFAULT_RESERVATION_POLICY
  const pricePerEventAmount = positiveInt(input.pricePerEventAmount)
  const currentEventCostAmount = positiveInt(input.currentEventCostAmount)

  if (currentEventCostAmount <= 0 && pricePerEventAmount <= 0) {
    return {
      requestedAmount: 0,
      targetReservationAmount: 0,
      canCoverCurrentEvent: true,
      requiredAmount: 0,
    }
  }

  const coldStartByEvents = multiplyAmount(
    pricePerEventAmount,
    positiveInt(policy.coldStartEventsToCover)
  )
  const coldStartPreferred = Math.min(coldStartByEvents, positiveInt(policy.maxColdStartAmount))
  const requiredAmount = Math.max(
    currentEventCostAmount,
    coldStartPreferred,
    positiveInt(policy.softFloorAmount)
  )

  const rawTarget =
    requiredAmount > 0 ? Math.max(requiredAmount, positiveInt(policy.minAtomicAmount)) : 0
  const requestedAmount = Math.min(rawTarget, positiveInt(policy.maxOutstandingAmount))

  return {
    requestedAmount,
    targetReservationAmount: requestedAmount,
    canCoverCurrentEvent: requestedAmount >= currentEventCostAmount,
    requiredAmount,
  }
}

/**
 * Updates spend velocity as "estimated spend per target refill interval".
 *
 * Storing interval spend instead of a floating-point rate keeps money math in
 * integer minor units. A flush of 100 units over 1 second with the default
 * 10-minute target interval becomes an observed interval spend of 60_000 units.
 */
export function updateSpendVelocity(input: SpendVelocityInput): SpendVelocityState {
  const policy = input.policy ?? DEFAULT_RESERVATION_POLICY
  const previousSpendEwmaAmount = positiveInt(input.previousSpendEwmaAmount)

  if (input.flushAmount <= 0) {
    return {
      spendEwmaAmount: previousSpendEwmaAmount,
      lastRateSampledAtMs: finiteInt(input.nowMs),
    }
  }

  const nowMs = finiteInt(input.nowMs)
  const previousSampleAt =
    input.previousLastRateSampledAtMs === null
      ? nowMs - positiveInt(policy.targetRefillIntervalMs)
      : finiteInt(input.previousLastRateSampledAtMs)
  const elapsedMs = Math.max(1, nowMs - previousSampleAt)
  const observedSpendPerTargetInterval = ceilMulDiv(
    positiveInt(input.flushAmount),
    positiveInt(policy.targetRefillIntervalMs),
    elapsedMs
  )
  const alphaBps = clamp(positiveInt(policy.ewmaAlphaBps), 0, BPS_DENOMINATOR)
  const spendEwmaAmount =
    previousSpendEwmaAmount <= 0
      ? observedSpendPerTargetInterval
      : ceilMulDiv(observedSpendPerTargetInterval, alphaBps, BPS_DENOMINATOR) +
        Math.floor((previousSpendEwmaAmount * (BPS_DENOMINATOR - alphaBps)) / BPS_DENOMINATOR)

  return {
    spendEwmaAmount,
    lastRateSampledAtMs: nowMs,
  }
}

/**
 * Decides whether the local reservation should be topped up after an event.
 *
 * The target is velocity over targetRefillIntervalMs plus a safety buffer. The
 * refill amount is a top-up from current remaining runway to that target, capped
 * by maxOutstandingAmount. The watermark is based on targetReservationAmount,
 * not cumulative allocationAmount, so repeated refills do not make the trigger
 * threshold grow forever.
 */
export function computeRefillDecision(input: RefillDecisionInput): RefillDecision {
  const policy = input.policy ?? DEFAULT_RESERVATION_POLICY
  const remainingAmount = Math.max(
    0,
    finiteInt(input.allocationAmount) - finiteInt(input.consumedAmount)
  )
  const currentEventCostAmount = positiveInt(input.currentEventCostAmount)
  const pricePerEventAmount = positiveInt(input.pricePerEventAmount)
  const spendEwmaAmount = positiveInt(input.spendEwmaAmount)
  const maxEventCostAmount = Math.max(positiveInt(input.maxEventCostAmount), currentEventCostAmount)
  const expectedSpendDuringLatency = ceilMulDiv(
    spendEwmaAmount,
    positiveInt(policy.refillLatencyBufferMs),
    Math.max(1, positiveInt(policy.targetRefillIntervalMs))
  )
  const safetyBuffer = Math.max(
    currentEventCostAmount,
    maxEventCostAmount,
    expectedSpendDuringLatency
  )
  const minimumUsefulAmount = Math.max(
    currentEventCostAmount,
    pricePerEventAmount,
    positiveInt(policy.softFloorAmount),
    currentEventCostAmount > 0 || pricePerEventAmount > 0 || spendEwmaAmount > 0
      ? positiveInt(policy.minAtomicAmount)
      : 0
  )
  const rawTarget = Math.max(minimumUsefulAmount, spendEwmaAmount + safetyBuffer)
  const targetReservationAmount = Math.min(rawTarget, positiveInt(policy.maxOutstandingAmount))
  const watermarkAmount = Math.max(
    thresholdFromBps(targetReservationAmount, policy.refillThresholdBps),
    currentEventCostAmount,
    expectedSpendDuringLatency
  )
  const needsRefill = remainingAmount <= watermarkAmount
  const refillAmount = needsRefill
    ? computeTopUpRefillAmount({
        remainingAmount,
        targetReservationAmount,
        maxOutstandingAmount: policy.maxOutstandingAmount,
      })
    : 0

  return {
    targetReservationAmount,
    watermarkAmount,
    remainingAmount,
    needsRefill,
    refillAmount,
    maxEventCostAmount,
  }
}

/**
 * Converts a raw event cost into the amount that may be applied locally.
 *
 * Positive costs pass through. Negative corrections are allowed only down to
 * flushedAmount, because already-flushed consumption has been recognized in the
 * wallet ledger and cannot be undone by local SQLite state alone.
 */
export function computeEffectiveWalletCost(input: EffectiveWalletCostInput): EffectiveWalletCost {
  const clampNegativeCostToUnflushed = input.clampNegativeCostToUnflushed ?? true
  const requestedCostAmount = finiteInt(input.requestedCostAmount)

  if (requestedCostAmount >= 0 || !clampNegativeCostToUnflushed) {
    return {
      effectiveCostAmount: requestedCostAmount,
      clampedNegativeAmount: 0,
    }
  }

  const consumedAmount = finiteInt(input.consumedAmount)
  const flushedAmount = finiteInt(input.flushedAmount)
  const desiredConsumed = consumedAmount + requestedCostAmount
  const clampedConsumed = Math.max(flushedAmount, desiredConsumed)

  return {
    effectiveCostAmount: clampedConsumed - consumedAmount,
    clampedNegativeAmount: desiredConsumed - clampedConsumed,
  }
}

/**
 * Computes a top-up amount, not a new absolute reservation size.
 *
 * Example: target=10, remaining=2 -> refill=8. If maxOutstanding=10 and
 * remaining=9, only 1 unit can be requested.
 */
export function computeTopUpRefillAmount(input: TopUpRefillInput): number {
  const remainingAmount = positiveInt(input.remainingAmount)
  const targetReservationAmount = positiveInt(input.targetReservationAmount)
  const maxOutstandingAmount = positiveInt(input.maxOutstandingAmount)
  const desiredTopUp = targetReservationAmount - remainingAmount
  const capRoom = maxOutstandingAmount - remainingAmount
  return Math.max(0, Math.min(desiredTopUp, capRoom))
}

/**
 * Computes the synchronous grow amount when the current event cannot fit.
 *
 * This path is intentionally more aggressive than "exact shortage": after a
 * synchronous ledger call, the DO should have enough runway for the current
 * event plus the normal target buffer, otherwise hot meters can fall into a
 * ledger call per event.
 */
export function computeSyncGrowRefillAmount(input: SyncGrowRefillInput): number {
  const remainingAmount = positiveInt(input.remainingAmount)
  const currentEventCostAmount = positiveInt(input.currentEventCostAmount)
  const targetReservationAmount = positiveInt(input.targetReservationAmount)
  const maxOutstandingAmount = positiveInt(input.maxOutstandingAmount)
  const shortage = Math.max(0, currentEventCostAmount - remainingAmount)
  const desiredRefill = Math.max(
    shortage,
    currentEventCostAmount + targetReservationAmount - remainingAmount
  )
  const allowedRefill = Math.max(0, maxOutstandingAmount - remainingAmount)
  return Math.max(0, Math.min(desiredRefill, allowedRefill))
}

/** Converts basis points into an integer amount using floor rounding. */
export function thresholdFromBps(amount: number, bps: number): number {
  if (amount <= 0 || bps <= 0) return 0
  return Math.floor((positiveInt(amount) * positiveInt(bps)) / BPS_DENOMINATOR)
}

/**
 * Integer ceil(amount * multiplier / divisor), using BigInt for the product.
 *
 * This avoids floating-point money arithmetic while still returning a number,
 * matching the rest of the wallet code's pgledger minor-unit representation.
 */
export function ceilMulDiv(amount: number, multiplier: number, divisor: number): number {
  const safeAmount = positiveInt(amount)
  const safeMultiplier = positiveInt(multiplier)
  const safeDivisor = positiveInt(divisor)
  if (safeAmount === 0 || safeMultiplier === 0) return 0
  if (safeDivisor <= 0) {
    throw new Error("ceilMulDiv divisor must be positive")
  }

  const numerator = BigInt(safeAmount) * BigInt(safeMultiplier)
  const denominator = BigInt(safeDivisor)
  const value = (numerator + denominator - BigInt(1)) / denominator
  return bigintToSafeNumber(value)
}

function multiplyAmount(amount: number, multiplier: number): number {
  return bigintToSafeNumber(BigInt(positiveInt(amount)) * BigInt(positiveInt(multiplier)))
}

function bigintToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER
  }
  return Number(value)
}

function finiteInt(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.trunc(value)
}

function positiveInt(value: number): number {
  return Math.max(0, finiteInt(value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
