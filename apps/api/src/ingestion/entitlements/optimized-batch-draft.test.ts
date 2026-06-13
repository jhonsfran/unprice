import { describe, expect, it } from "vitest"
import type { BatchIdempotencyEntry } from "./contracts"
import {
  createOptimizedBatchDraft,
  createOptimizedBatchWriteMetrics,
} from "./optimized-batch-draft"

function entry(eventId: string, allowed = true): BatchIdempotencyEntry {
  return {
    allowed,
    createdAt: 1_717_000_000_000,
    deniedReason: allowed ? null : "WALLET_EMPTY",
    denyMessage: allowed ? null : "Wallet empty",
    eventId,
    meterFacts: [],
  }
}

describe("optimized batch draft", () => {
  it("stages many event outcomes as one commit payload", () => {
    const draft = createOptimizedBatchDraft({
      grantStates: [],
      meterState: {
        createdAt: 1_717_000_000_000,
        dirty: false,
        exists: true,
        meterKey: "meter:tokens",
        updatedAt: null,
        usage: 0,
      },
      wallet: null,
    })

    draft.stageIdempotencyEntry(entry("evt_1"))
    draft.stageIdempotencyEntry(entry("evt_2", false))

    expect(draft.lookupStagedResult("evt_1")).toMatchObject({ eventId: "evt_1" })
    expect(draft.lookupStagedResult("evt_2")).toMatchObject({ allowed: false })
    expect(draft.hasDurableMutations()).toBe(true)
    expect(draft.toCommitPayload().idempotencyEntries).toHaveLength(2)
  })

  it("keeps retry-required wallet work outside the durable draft", () => {
    const draft = createOptimizedBatchDraft({
      grantStates: [],
      meterState: {
        createdAt: 1_717_000_000_000,
        dirty: false,
        exists: true,
        meterKey: "meter:tokens",
        updatedAt: null,
        usage: 0,
      },
      wallet: {
        allocationAmount: 100,
        billingPeriodId: "bp_123",
        consumedAmount: 80,
        consumedQuantity: 8,
        currency: "USD",
        customerId: "cus_123",
        cycleEndAt: 200,
        cycleStartAt: 100,
        deletionRequested: false,
        featurePlanVersionItemId: "item_123",
        featureSlug: "api_calls",
        flushedAmount: 0,
        flushedQuantity: 0,
        flushSeq: 1,
        lastEventAt: null,
        lastFlushedAt: null,
        lastRateSampledAtMs: null,
        maxEventCostAmount: 10,
        pendingFlushAmount: null,
        pendingFlushFinal: false,
        pendingFlushQuantity: null,
        pendingFlushSeq: null,
        pendingRefillAmount: 0,
        projectId: "proj_123",
        recoveryRequired: false,
        refillChunkAmount: 0,
        refillInFlight: false,
        refillThresholdBps: 5000,
        reservationEndAt: 200,
        reservationId: "res_123",
        spendEwmaAmount: 0,
        statementKey: "stmt_123",
        targetReservationAmount: 100,
      },
    })

    draft.walletDirty = true
    draft.stageIdempotencyEntry(entry("evt_before_retry"))

    expect(draft.hasDurableMutations()).toBe(true)
    expect(draft.toCommitPayload().idempotencyEntries).toHaveLength(1)
  })

  it("computes compact write metrics from the final draft shape", () => {
    const metrics = createOptimizedBatchWriteMetrics({
      idempotencyEntryCount: 100,
      meterStateDirty: true,
      meterStateExists: false,
      touchedGrantPeriodKeys: ["period_a", "period_a", "period_b"],
      walletDirty: true,
      walletPresent: true,
    })

    expect(metrics).toEqual({
      grant_window_write_count: 2,
      idempotency_event_count: 100,
      idempotency_insert_count: 1,
      meter_state_write_count: 2,
      outbox_fact_count: 0,
      outbox_insert_count: 0,
      wallet_reservation_write_count: 1,
    })
  })
})
