import { DEFAULT_RESERVATION_POLICY } from "@unprice/services/wallet/reservation-sizing"
import { describe, expect, it } from "vitest"
import {
  buildBatchEventApplyInput,
  computeBatchReservationHeadroom,
  computeBatchReservationRefillAmount,
  createAllowedBatchOutcome,
  createCachedBatchResult,
  createDeniedBatchOutcome,
  idempotencyEntryToApplyResult,
  planWalletReservationSpend,
} from "./batch-apply-helpers"
import type { ApplyBatchInput, BatchIdempotencyEntry, WalletReservationSnapshot } from "./contracts"

describe("batch apply helpers", () => {
  it("builds a single-event apply input from a batch event", () => {
    const input = createBatchInput()
    const event = input.events[0]!

    expect(buildBatchEventApplyInput(input, event)).toMatchObject({
      projectId: "proj_123",
      customerId: "cus_123",
      idempotencyKey: "idem_123",
      now: 123,
      event: {
        id: "evt_123",
        slug: "tokens_used",
        timestamp: 100,
        properties: { amount: 1 },
        source: {
          workspaceId: "ws_123",
          environment: "test",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      },
    })
  })

  it("converts idempotency entries back to apply results", () => {
    expect(
      idempotencyEntryToApplyResult({
        eventId: "idem_123",
        createdAt: 1,
        allowed: false,
        deniedReason: "LIMIT_EXCEEDED",
        denyMessage: "Limit exceeded",
        meterFacts: [],
      })
    ).toEqual({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: "Limit exceeded",
    })
  })

  it("creates denied batch outcomes", () => {
    const outcome = createDeniedBatchOutcome({
      correlationKey: "corr_123",
      createdAt: 1,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      idempotencyKey: "idem_123",
      message: "late",
    })

    expect(outcome.result).toMatchObject({
      allowed: false,
      correlationKey: "corr_123",
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      idempotencyKey: "idem_123",
      message: "late",
    })
    expect(outcome.entry).toMatchObject({
      eventId: "idem_123",
      allowed: false,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("creates allowed and cached batch result rows", () => {
    const allowed = createAllowedBatchOutcome({
      correlationKey: "corr_123",
      createdAt: 1,
      idempotencyKey: "idem_123",
      meterFacts: [],
    })

    expect(allowed.result).toEqual({
      allowed: true,
      correlationKey: "corr_123",
      idempotencyKey: "idem_123",
      meterFacts: [],
    })
    expect(
      createCachedBatchResult({
        correlationKey: "corr_456",
        entry: allowed.entry,
        idempotencyKey: "idem_456",
      })
    ).toEqual({
      allowed: true,
      correlationKey: "corr_456",
      idempotencyKey: "idem_456",
    })
  })

  it("marks reservation spend as underfunded when the event exceeds local allocation", () => {
    const plan = planWalletReservationSpend({
      createdAt: 1,
      entitlement: { featureConfig: {} },
      eventTimestamp: 100,
      policy: DEFAULT_RESERVATION_POLICY,
      totalCost: 20,
      totalUnits: 2,
      window: createOpenWalletReservation({ allocationAmount: 10 }),
    })

    expect(plan).toMatchObject({
      currentRemaining: 10,
      effectiveCostAmount: 20,
      kind: "underfunded",
      totalCost: 20,
    })
  })

  it("plans spend and refill state from the same reservation snapshot", () => {
    const plan = planWalletReservationSpend({
      createdAt: 1_000,
      entitlement: { featureConfig: {} },
      eventTimestamp: 900,
      policy: { ...DEFAULT_RESERVATION_POLICY, refillThresholdBps: 9000 },
      totalCost: 15,
      totalUnits: 3,
      window: createOpenWalletReservation({
        allocationAmount: 100,
        consumedAmount: 80,
        consumedQuantity: 8,
        flushedAmount: 70,
        flushedQuantity: 7,
        flushSeq: 3,
      }),
    })

    expect(plan).toMatchObject({
      effectiveCostAmount: 15,
      kind: "funded",
      walletStateUpdate: {
        consumedAmount: 95,
        consumedQuantity: 11,
        lastEventAt: 1_000,
      },
      refillStateUpdate: {
        pendingFlushAmount: 25,
        pendingFlushQuantity: 4,
        pendingFlushFinal: false,
        pendingFlushSeq: 4,
        refillInFlight: true,
      },
      refillTrigger: {
        effectiveAt: 900,
        flushAmount: 25,
        flushQuantity: 4,
        flushSeq: 4,
      },
    })
  })

  it("computes required headroom from staged wallet consumption plus current event cost", () => {
    const result = computeBatchReservationHeadroom({
      persistedConsumedAmount: 100,
      stagedConsumedAmount: 350,
      currentEventEffectiveCostAmount: 200,
    })

    expect(result).toEqual({
      stagedDeltaAmount: 250,
      requiredHeadroomAmount: 450,
    })
  })

  it("computes zero refill when current remaining already covers required batch headroom", () => {
    const refillAmount = computeBatchReservationRefillAmount({
      currentRemainingAmount: 500,
      requiredHeadroomAmount: 450,
      targetReservationAmount: 700,
      maxOutstandingAmount: 1_000,
    })

    expect(refillAmount).toBe(0)
  })

  it("computes a top-up that covers the required batch headroom and target runway", () => {
    const refillAmount = computeBatchReservationRefillAmount({
      currentRemainingAmount: 100,
      requiredHeadroomAmount: 450,
      targetReservationAmount: 700,
      maxOutstandingAmount: 1_000,
    })

    expect(refillAmount).toBe(600)
  })

  it("caps the batch refill amount by max outstanding amount", () => {
    const refillAmount = computeBatchReservationRefillAmount({
      currentRemainingAmount: 100,
      requiredHeadroomAmount: 900,
      targetReservationAmount: 1_500,
      maxOutstandingAmount: 1_000,
    })

    expect(refillAmount).toBe(900)
  })
})

function createOpenWalletReservation(
  overrides: Partial<NonNullable<WalletReservationSnapshot>> = {}
): NonNullable<WalletReservationSnapshot> & { reservationId: string } {
  return {
    allocationAmount: 100,
    billingPeriodId: "bp_123",
    consumedAmount: 0,
    consumedQuantity: 0,
    currency: "USD",
    customerId: "cus_123",
    cycleEndAt: null,
    cycleStartAt: null,
    deletionRequested: false,
    featurePlanVersionItemId: "item_123",
    featureSlug: "api_calls",
    flushedAmount: 0,
    flushedQuantity: 0,
    flushSeq: 0,
    lastEventAt: null,
    lastFlushedAt: null,
    lastRateSampledAtMs: null,
    maxEventCostAmount: 0,
    pendingFlushAmount: null,
    pendingFlushQuantity: null,
    pendingFlushFinal: false,
    pendingFlushSeq: null,
    pendingRefillAmount: 0,
    projectId: "proj_123",
    recoveryRequired: false,
    refillChunkAmount: 0,
    refillInFlight: false,
    refillThresholdBps: 2000,
    reservationEndAt: null,
    reservationId: "res_123",
    spendEwmaAmount: 0,
    statementKey: "stmt_123",
    targetReservationAmount: 100,
    ...overrides,
  }
}

function createBatchInput(): ApplyBatchInput {
  return {
    projectId: "proj_123",
    customerId: "cus_123",
    entitlement: {
      creditLinePolicy: "capped",
      customerEntitlementId: "ce_123",
      customerId: "cus_123",
      effectiveAt: 1,
      expiresAt: null,
      featureConfig: {},
      featurePlanVersionId: "fpv_123",
      featureSlug: "api_calls",
      featureType: "usage",
      meterConfig: {
        aggregationField: "amount",
        aggregationMethod: "sum",
        eventId: "meter_123",
        eventSlug: "tokens_used",
      },
      overageStrategy: "none",
      projectId: "proj_123",
      resetConfig: null,
    },
    grants: [
      {
        allowanceUnits: 100,
        effectiveAt: 1,
        expiresAt: null,
        grantId: "grant_123",
        priority: 1,
      },
    ],
    enforceLimit: true,
    events: [
      {
        correlationKey: "corr_123",
        id: "evt_123",
        idempotencyKey: "idem_123",
        now: 123,
        properties: { amount: 1 },
        source: {
          workspaceId: "ws_123",
          environment: "test",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
        slug: "tokens_used",
        timestamp: 100,
      },
    ],
  } as ApplyBatchInput
}
