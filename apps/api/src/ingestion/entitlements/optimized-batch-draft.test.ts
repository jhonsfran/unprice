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
