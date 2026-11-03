import type { WalletReservationSnapshot } from "../contracts"
import {
  createApplyInput as createFixtureApplyInput,
  createGrantSnapshot as createFixtureGrantSnapshot,
} from "../entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./processor-contract"
export { createEntitlementWindowWalletHarness as createWalletHarness } from "./wallet-harness"

export const BASE_NOW = Date.now()

export function createGrantSnapshot(overrides: Record<string, unknown> = {}) {
  return createFixtureGrantSnapshot({
    cadenceEffectiveAt: BASE_NOW - 60_000,
    cadenceExpiresAt: BASE_NOW + 60_000,
    effectiveAt: BASE_NOW - 60_000,
    expiresAt: BASE_NOW + 60_000,
    ...overrides,
  })
}

export function createApplyInput(overrides: Record<string, unknown> = {}) {
  const now = typeof overrides.now === "number" ? overrides.now : BASE_NOW
  const event = (overrides.event as Record<string, unknown> | undefined) ?? {}
  return createFixtureApplyInput({
    periodStartAt: now - 60_000,
    periodEndAt: now + 60_000,
    ...overrides,
    event: { timestamp: now, ...event },
  })
}

export function createHarness(
  params: Parameters<
    typeof createEntitlementWindowProcessorHarness<InMemoryEntitlementWindowStore>
  >[0]
) {
  let invalidateEnforcementStateCache = () => {}
  const store =
    params.store ?? new InMemoryEntitlementWindowStore(() => invalidateEnforcementStateCache())
  const harness = createEntitlementWindowProcessorHarness({ ...params, store })
  invalidateEnforcementStateCache = () => harness.processor.invalidateEnforcementStateCache()
  return harness
}

export function seedWallet(
  store: InMemoryEntitlementWindowStore,
  overrides: Partial<NonNullable<WalletReservationSnapshot>> = {}
) {
  store.walletRow = {
    projectId: "proj_123",
    customerId: "cus_123",
    currency: "USD",
    reservationEndAt: BASE_NOW + 60_000,
    billingPeriodId: "bp_123",
    cycleEndAt: BASE_NOW + 60_000,
    cycleStartAt: BASE_NOW - 60_000,
    featurePlanVersionItemId: "item_123",
    featureSlug: "api_calls",
    statementKey: "stmt_123",
    reservationId: "res_seeded",
    allocationAmount: 1_000_000_000,
    consumedAmount: 0,
    flushedAmount: 0,
    consumedQuantity: 0,
    flushedQuantity: 0,
    refillThresholdBps: 2000,
    refillChunkAmount: 200_000_000,
    targetReservationAmount: 1_000_000_000,
    spendEwmaAmount: 0,
    lastRateSampledAtMs: null,
    maxEventCostAmount: 0,
    pendingRefillAmount: 0,
    pendingFlushAmount: null,
    pendingFlushQuantity: null,
    refillInFlight: false,
    flushSeq: 0,
    pendingFlushSeq: null,
    pendingFlushFinal: false,
    lastEventAt: BASE_NOW,
    lastFlushedAt: BASE_NOW,
    deletionRequested: false,
    recoveryRequired: false,
    ...overrides,
  }
}

export function createBatchInput(
  input: ReturnType<typeof createApplyInput>,
  amounts: number[],
  idPrefix = "batch"
) {
  return {
    customerId: input.customerId,
    entitlement: input.entitlement,
    enforceLimit: input.enforceLimit,
    events: amounts.map((amount, index) => ({
      ...input.event,
      correlationKey: `${idPrefix}_${index}`,
      id: `evt_${idPrefix}_${index}`,
      idempotencyKey: `idem_${idPrefix}_${index}`,
      now: input.now + index,
      properties: { amount },
      timestamp: input.event.timestamp + index,
    })),
    grants: input.grants,
    projectId: input.projectId,
  }
}
