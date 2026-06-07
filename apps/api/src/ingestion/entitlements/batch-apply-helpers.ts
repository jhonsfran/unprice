import { computeMaxMarginalPriceMinor } from "@unprice/services/entitlements"
import {
  type ReservationPolicy,
  computeEffectiveWalletCost,
  computeRefillDecision,
  updateSpendVelocity,
} from "@unprice/services/wallet/reservation-sizing"
import type {
  ApplyBatchInput,
  ApplyBatchResultRow,
  ApplyInput,
  ApplyResult,
  BatchIdempotencyEntry,
  DeniedReason,
  EntitlementConfigInput,
  RefillTrigger,
  WalletReservationSnapshot,
} from "./contracts"

type ApplyBatchEventInput = ApplyBatchInput["events"][number]
type OpenWalletReservationSnapshot = NonNullable<WalletReservationSnapshot> & {
  reservationId: string
}

type WalletReservationSpendCost = ReturnType<typeof computeEffectiveWalletCost> & {
  currentRemaining: number
}

type WalletSpendVelocity = {
  lastRateSampledAtMs: number | null
  spendEwmaAmount: number
}

type WalletReservationRefillDecisionState = {
  refillDecision: ReturnType<typeof computeRefillDecision>
  spendVelocity: WalletSpendVelocity
}

type WalletReservationRefillPlan = {
  flushAmount: number
  flushQuantity: number
  refillAmount: number
  refillDecision: ReturnType<typeof computeRefillDecision>
  refillStateUpdate: WalletReservationRefillStateUpdate | null
  refillTrigger: RefillTrigger | null
  spendVelocity: WalletSpendVelocity
}

export type WalletReservationSpendPlan =
  | {
      clampedNegativeAmount: number
      currentRemaining: number
      effectiveCostAmount: number
      kind: "underfunded"
      totalCost: number
    }
  | {
      clampedNegativeAmount: number
      currentRemaining: number
      effectiveCostAmount: number
      flushAmount: number
      flushQuantity: number
      kind: "funded"
      refillAmount: number
      refillStateUpdate: WalletReservationRefillStateUpdate | null
      refillTrigger: RefillTrigger | null
      remainingAmount: number
      targetReservationAmount: number
      thresholdAmount: number
      totalCost: number
      walletStateUpdate: WalletReservationSpendStateUpdate
    }

export type WalletReservationSpendStateUpdate = {
  consumedAmount: number
  consumedQuantity: number
  lastEventAt: number
  lastRateSampledAtMs: number | null
  maxEventCostAmount: number
  spendEwmaAmount: number
  targetReservationAmount: number
}

export type WalletReservationRefillStateUpdate = {
  pendingFlushAmount: number
  pendingFlushQuantity: number
  pendingFlushFinal: false
  pendingFlushSeq: number
  pendingRefillAmount: number
  refillInFlight: true
}

export function buildBatchEventApplyInput(
  input: ApplyBatchInput,
  event: ApplyBatchEventInput
): ApplyInput {
  return {
    ...input,
    event: {
      id: event.id,
      slug: event.slug,
      timestamp: event.timestamp,
      properties: event.properties,
      source: event.source,
    },
    idempotencyKey: event.idempotencyKey,
    now: event.now,
  }
}

export function hasStagedBatchMutations(state: {
  idempotencyEntryCount: number
  meterStateDirty: boolean
  touchedGrantStateCount: number
  walletDirty: boolean
}): boolean {
  return (
    state.idempotencyEntryCount > 0 ||
    state.meterStateDirty ||
    state.touchedGrantStateCount > 0 ||
    state.walletDirty
  )
}

export function planWalletReservationSpend(params: {
  createdAt: number
  entitlement: Pick<EntitlementConfigInput, "featureConfig">
  eventTimestamp: number
  policy: ReservationPolicy
  totalCost: number
  totalUnits: number
  window: OpenWalletReservationSnapshot
}): WalletReservationSpendPlan {
  const { createdAt, entitlement, eventTimestamp, policy, totalCost, totalUnits, window } = params
  const spendCost = computeWalletReservationSpendCost({ totalCost, window })

  if (spendCost.effectiveCostAmount > spendCost.currentRemaining) {
    return {
      clampedNegativeAmount: spendCost.clampedNegativeAmount,
      currentRemaining: spendCost.currentRemaining,
      effectiveCostAmount: spendCost.effectiveCostAmount,
      kind: "underfunded",
      totalCost,
    }
  }

  const nextConsumedAmount = window.consumedAmount + spendCost.effectiveCostAmount
  const nextConsumedQuantity = window.consumedQuantity + Math.max(0, totalUnits)
  const refillPlan = planWalletReservationRefill({
    createdAt,
    entitlement,
    eventTimestamp,
    nextConsumedAmount,
    nextConsumedQuantity,
    policy,
    totalCost,
    window,
  })

  return {
    clampedNegativeAmount: spendCost.clampedNegativeAmount,
    currentRemaining: spendCost.currentRemaining,
    effectiveCostAmount: spendCost.effectiveCostAmount,
    flushAmount: refillPlan.flushAmount,
    flushQuantity: refillPlan.flushQuantity,
    kind: "funded",
    refillAmount: refillPlan.refillAmount,
    refillStateUpdate: refillPlan.refillStateUpdate,
    refillTrigger: refillPlan.refillTrigger,
    remainingAmount: refillPlan.refillDecision.remainingAmount,
    targetReservationAmount: refillPlan.refillDecision.targetReservationAmount,
    thresholdAmount: refillPlan.refillDecision.watermarkAmount,
    totalCost,
    walletStateUpdate: {
      consumedAmount: nextConsumedAmount,
      consumedQuantity: nextConsumedQuantity,
      targetReservationAmount: refillPlan.refillDecision.targetReservationAmount,
      spendEwmaAmount: refillPlan.spendVelocity.spendEwmaAmount,
      lastRateSampledAtMs: refillPlan.spendVelocity.lastRateSampledAtMs,
      maxEventCostAmount: refillPlan.refillDecision.maxEventCostAmount,
      lastEventAt: createdAt,
    },
  }
}

function computeWalletReservationSpendCost(params: {
  totalCost: number
  window: OpenWalletReservationSnapshot
}): WalletReservationSpendCost {
  const { totalCost, window } = params
  return {
    ...computeEffectiveWalletCost({
      requestedCostAmount: totalCost,
      consumedAmount: window.consumedAmount,
      flushedAmount: window.flushedAmount,
    }),
    currentRemaining: Math.max(0, window.allocationAmount - window.consumedAmount),
  }
}

function planWalletReservationRefill(params: {
  createdAt: number
  entitlement: Pick<EntitlementConfigInput, "featureConfig">
  eventTimestamp: number
  nextConsumedAmount: number
  nextConsumedQuantity: number
  policy: ReservationPolicy
  totalCost: number
  window: OpenWalletReservationSnapshot
}): WalletReservationRefillPlan {
  const {
    createdAt,
    entitlement,
    eventTimestamp,
    nextConsumedAmount,
    nextConsumedQuantity,
    policy,
    totalCost,
    window,
  } = params
  const flushAmount = Math.max(0, nextConsumedAmount - window.flushedAmount)
  const flushQuantity = Math.max(0, nextConsumedQuantity - window.flushedQuantity)
  const hasPendingNonFinalFlush = hasPendingNonFinalReservationFlush(window)
  const { refillDecision, spendVelocity } = resolveWalletReservationRefillDecisionState({
    createdAt,
    entitlement,
    flushAmount,
    flushQuantity,
    hasPendingNonFinalFlush,
    nextConsumedAmount,
    policy,
    totalCost,
    window,
  })
  const refillStateUpdate = createWalletReservationRefillStateUpdate({
    flushAmount,
    flushQuantity,
    hasPendingNonFinalFlush,
    refillDecision,
    window,
  })

  return {
    flushAmount,
    flushQuantity,
    refillAmount: refillDecision.refillAmount,
    refillDecision,
    refillStateUpdate,
    refillTrigger: createWalletReservationRefillTrigger(refillStateUpdate, eventTimestamp),
    spendVelocity,
  }
}

function hasPendingNonFinalReservationFlush(window: OpenWalletReservationSnapshot): boolean {
  return (
    !window.pendingFlushFinal &&
    window.pendingFlushSeq !== null &&
    window.pendingFlushSeq !== undefined &&
    window.pendingFlushSeq > window.flushSeq
  )
}

function resolveWalletReservationRefillDecisionState(params: {
  createdAt: number
  entitlement: Pick<EntitlementConfigInput, "featureConfig">
  flushAmount: number
  flushQuantity: number
  hasPendingNonFinalFlush: boolean
  nextConsumedAmount: number
  policy: ReservationPolicy
  totalCost: number
  window: OpenWalletReservationSnapshot
}): WalletReservationRefillDecisionState {
  const {
    createdAt,
    entitlement,
    flushAmount,
    hasPendingNonFinalFlush,
    nextConsumedAmount,
    policy,
    totalCost,
    window,
  } = params
  const currentEventCostAmount = Math.max(0, totalCost)
  const pricePerEventAmount = Math.max(
    currentEventCostAmount,
    computeMaxMarginalPriceMinor(entitlement.featureConfig)
  )
  let spendVelocity: WalletSpendVelocity = {
    spendEwmaAmount: window.spendEwmaAmount,
    lastRateSampledAtMs: window.lastRateSampledAtMs,
  }
  let refillDecision = computeWalletReservationRefillDecision({
    currentEventCostAmount,
    nextConsumedAmount,
    policy,
    pricePerEventAmount,
    spendVelocity,
    window,
  })

  if (
    refillDecision.needsRefill &&
    !window.refillInFlight &&
    !hasPendingNonFinalFlush &&
    flushAmount > 0
  ) {
    spendVelocity = updateSpendVelocity({
      previousSpendEwmaAmount: window.spendEwmaAmount,
      previousLastRateSampledAtMs: window.lastRateSampledAtMs,
      flushAmount,
      nowMs: createdAt,
      policy,
    })
    refillDecision = computeWalletReservationRefillDecision({
      currentEventCostAmount,
      nextConsumedAmount,
      policy,
      pricePerEventAmount,
      spendVelocity,
      window,
    })
  }

  return { refillDecision, spendVelocity }
}

function computeWalletReservationRefillDecision(params: {
  currentEventCostAmount: number
  nextConsumedAmount: number
  policy: ReservationPolicy
  pricePerEventAmount: number
  spendVelocity: WalletSpendVelocity
  window: OpenWalletReservationSnapshot
}): ReturnType<typeof computeRefillDecision> {
  const {
    currentEventCostAmount,
    nextConsumedAmount,
    policy,
    pricePerEventAmount,
    spendVelocity,
    window,
  } = params
  return computeRefillDecision({
    allocationAmount: window.allocationAmount,
    consumedAmount: nextConsumedAmount,
    flushedAmount: window.flushedAmount,
    targetReservationAmount: window.targetReservationAmount,
    spendEwmaAmount: spendVelocity.spendEwmaAmount,
    lastRateSampledAtMs: spendVelocity.lastRateSampledAtMs,
    maxEventCostAmount: window.maxEventCostAmount,
    currentEventCostAmount,
    pricePerEventAmount,
    policy,
  })
}

function createWalletReservationRefillStateUpdate(params: {
  flushAmount: number
  flushQuantity: number
  hasPendingNonFinalFlush: boolean
  refillDecision: ReturnType<typeof computeRefillDecision>
  window: OpenWalletReservationSnapshot
}): WalletReservationRefillStateUpdate | null {
  const { flushAmount, flushQuantity, hasPendingNonFinalFlush, refillDecision, window } = params
  if (
    window.refillInFlight ||
    (!hasPendingNonFinalFlush && (!refillDecision.needsRefill || refillDecision.refillAmount <= 0))
  ) {
    return null
  }

  const nextSeq = hasPendingNonFinalFlush ? window.pendingFlushSeq! : window.flushSeq + 1
  const pendingFlushAmount = hasPendingNonFinalFlush
    ? (window.pendingFlushAmount ?? flushAmount)
    : flushAmount
  const pendingFlushQuantity = hasPendingNonFinalFlush
    ? (window.pendingFlushQuantity ?? flushQuantity)
    : flushQuantity
  const refillAmount = hasPendingNonFinalFlush
    ? window.pendingRefillAmount
    : refillDecision.refillAmount

  return {
    refillInFlight: true,
    pendingFlushSeq: nextSeq,
    pendingFlushFinal: false,
    pendingFlushAmount,
    pendingFlushQuantity,
    pendingRefillAmount: refillAmount,
  }
}

function createWalletReservationRefillTrigger(
  refillStateUpdate: WalletReservationRefillStateUpdate | null,
  eventTimestamp: number
): RefillTrigger | null {
  if (!refillStateUpdate) {
    return null
  }

  return {
    flushSeq: refillStateUpdate.pendingFlushSeq,
    flushAmount: refillStateUpdate.pendingFlushAmount,
    flushQuantity: refillStateUpdate.pendingFlushQuantity,
    refillAmount: refillStateUpdate.pendingRefillAmount,
    effectiveAt: eventTimestamp,
  }
}

export function idempotencyEntryToApplyResult(entry: BatchIdempotencyEntry): ApplyResult {
  const result: ApplyResult = {
    allowed: entry.allowed,
  }
  const meterFacts = nonEmptyMeterFacts(entry.meterFacts)
  if (entry.deniedReason !== null) {
    result.deniedReason = entry.deniedReason
  }
  if (entry.denyMessage !== null) {
    result.message = entry.denyMessage
  }
  if (meterFacts) {
    result.meterFacts = meterFacts
  }
  return result
}

export function createCachedBatchResult(params: {
  correlationKey: string
  entry: BatchIdempotencyEntry
  idempotencyKey: string
}): ApplyBatchResultRow {
  return {
    ...idempotencyEntryToApplyResult(params.entry),
    correlationKey: params.correlationKey,
    idempotencyKey: params.idempotencyKey,
  }
}

export function createDeniedBatchOutcome(params: {
  correlationKey: string
  createdAt: number
  deniedReason?: DeniedReason
  idempotencyKey: string
  message?: string
}): { entry: BatchIdempotencyEntry; result: ApplyBatchResultRow } {
  const result: ApplyBatchResultRow = {
    allowed: false,
    correlationKey: params.correlationKey,
    idempotencyKey: params.idempotencyKey,
  }
  if (params.deniedReason) {
    result.deniedReason = params.deniedReason
  }
  if (params.message) {
    result.message = params.message
  }

  return {
    entry: {
      eventId: params.idempotencyKey,
      createdAt: params.createdAt,
      allowed: false,
      deniedReason: result.deniedReason ?? null,
      denyMessage: result.message ?? null,
      meterFacts: [],
    },
    result,
  }
}

export function createAllowedBatchOutcome(params: {
  correlationKey: string
  createdAt: number
  idempotencyKey: string
  meterFacts: BatchIdempotencyEntry["meterFacts"]
}): { entry: BatchIdempotencyEntry; result: ApplyBatchResultRow } {
  return {
    entry: {
      eventId: params.idempotencyKey,
      createdAt: params.createdAt,
      allowed: true,
      deniedReason: null,
      denyMessage: null,
      meterFacts: params.meterFacts,
    },
    result: {
      allowed: true,
      correlationKey: params.correlationKey,
      idempotencyKey: params.idempotencyKey,
      meterFacts: params.meterFacts,
    },
  }
}

export function stageBatchIdempotencyEntry(params: {
  entries: BatchIdempotencyEntry[]
  entry: BatchIdempotencyEntry
  stagedResultsByKey: Map<string, BatchIdempotencyEntry>
}): void {
  params.entries.push(params.entry)
  params.stagedResultsByKey.set(params.entry.eventId, params.entry)
}

function nonEmptyMeterFacts(
  facts: BatchIdempotencyEntry["meterFacts"] | undefined
): BatchIdempotencyEntry["meterFacts"] | undefined {
  return facts && facts.length > 0 ? facts : undefined
}
