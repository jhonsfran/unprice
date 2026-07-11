import { UnPriceWalletError } from "@unprice/services/wallet"
import { describe, expect, it } from "vitest"
import type { RunBudgetProcessor } from "./processor"
import {
  RUN_BUDGET_TEST_NOW,
  createRunBudgetMeterFact,
  createRunBudgetProcessorHarness,
} from "./testing/harness"
import { InMemoryRunBudgetStore } from "./testing/in-memory-store"
import {
  type RunBudgetProcessorContractTarget,
  createRunBudgetApplyInput,
  createRunBudgetStartInput,
  describeRunBudgetProcessorContract,
} from "./testing/processor-contract"

describeRunBudgetProcessorContract("RunBudgetProcessor (in-memory contract)", async () => {
  const harness = createRunBudgetProcessorHarness()
  const asTarget = (processor: RunBudgetProcessor): RunBudgetProcessorContractTarget => ({
    startRun: (input) => processor.startRun(input),
    applySyncEvent: (input) => processor.applySyncEvent(input),
    endRun: (input) => processor.endRun(input),
    getRunStatus: (input) => processor.getRunStatus(input),
    flushCaptures: () => processor.flushCaptures(),
    alarm: () => processor.alarm(),
    advanceClock: (milliseconds) => {
      harness.state.now += milliseconds
    },
    setCaptureFailure: (failing) => {
      if (failing) {
        harness.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))
      } else {
        harness.captureReservationUsage.mockResolvedValue({ val: { capturedAmount: 0 } })
      }
    },
    failNextSchedulerCall: () => {
      harness.state.schedulerFailuresRemaining++
    },
    alarmAt: async () => harness.state.alarmAt,
    clockNow: () => harness.state.now,
    captureCallCount: () => harness.captureReservationUsage.mock.calls.length,
    captureAttemptCount: async () => {
      const intents = [
        ...(await harness.store.listRetryableCaptureIntents()),
        ...(await harness.store.findAbandonedCaptureIntents("run_1")),
      ]
      return intents[0]?.attemptCount ?? 0
    },
    pricingCallCount: () => harness.pricingApply.mock.calls.length,
  })
  return {
    target: asTarget(harness.processor),
    revive: async () => asTarget(harness.createProcessor()),
  }
})

describe("RunBudgetProcessor injected behavior", () => {
  it("returns the input timestamp when wallet reservation fails during start", async () => {
    const harness = createRunBudgetProcessorHarness()
    harness.createReservation.mockResolvedValueOnce({
      err: new UnPriceWalletError({ message: "WALLET_EMPTY" }),
    })

    await expect(harness.processor.startRun(createRunBudgetStartInput())).resolves.toMatchObject({
      runId: "run_1",
      status: "failed",
      endedAt: RUN_BUDGET_TEST_NOW,
      consumedAmount: 0,
      remainingAmount: 0,
      walletError: "WALLET_EMPTY",
    })
  })

  it("returns an existing run without creating a second reservation and restores its expiry alarm", async () => {
    const harness = createRunBudgetProcessorHarness()
    const input = createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW + 5_000 })
    const first = await harness.processor.startRun(input)
    harness.state.alarmAt = null
    const replay = await harness.processor.startRun(input)

    expect(replay).toEqual(first)
    expect(harness.createReservation).toHaveBeenCalledTimes(1)
    expect(harness.state.alarmAt).toBe(RUN_BUDGET_TEST_NOW + 5_000)
  })

  it("decorates priced meter facts with run analytics context", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(
      createRunBudgetStartInput({
        workloadType: "workflow",
        workloadId: "research",
        traceId: "trace_1",
        parentRunId: "run_parent",
      })
    )
    const decision = await harness.processor.applySyncEvent(createRunBudgetApplyInput())

    expect(decision.meterFacts[0]).toMatchObject({
      run_id: "run_1",
      trace_id: "trace_1",
      parent_run_id: "run_parent",
      workload_type: "workflow",
      workload_id: "research",
    })
  })

  it("rejects events for a terminal run without calling pricing", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.endRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "canceled",
      endedAt: RUN_BUDGET_TEST_NOW + 1,
    })
    harness.pricingApply.mockClear()

    await expect(
      harness.processor.applySyncEvent(createRunBudgetApplyInput())
    ).resolves.toMatchObject({
      allowed: false,
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      message: "Run is canceled, not running",
      budget: { status: "canceled", endedAt: RUN_BUDGET_TEST_NOW + 1 },
    })
    expect(harness.pricingApply).not.toHaveBeenCalled()
  })

  it("closes an already-expired run before pricing", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW }))
    harness.pricingApply.mockClear()

    await expect(
      harness.processor.applySyncEvent(createRunBudgetApplyInput())
    ).resolves.toMatchObject({
      allowed: false,
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      budget: { status: "expired", endedAt: RUN_BUDGET_TEST_NOW },
    })
    expect(harness.pricingApply).not.toHaveBeenCalled()
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
  })

  it("preserves entitlement-window denials without mutating run spend", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    harness.pricingApply.mockResolvedValueOnce({
      allowed: false,
      deniedReason: "LIMIT_EXCEEDED",
      message: "Feature limit exceeded",
      meterFacts: [],
    })

    await expect(
      harness.processor.applySyncEvent(createRunBudgetApplyInput())
    ).resolves.toMatchObject({
      allowed: false,
      rejectionReason: "LIMIT_EXCEEDED",
      message: "Feature limit exceeded",
      budget: { consumedAmount: 0 },
    })
  })

  it("rolls back run spend and buckets when idempotency persistence fails", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput())
    store.failNextIdempotencyWrite = true

    await expect(harness.processor.applySyncEvent(createRunBudgetApplyInput())).rejects.toThrow(
      "run idempotency insert failed"
    )
    await expect(
      harness.processor.getRunStatus({
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({ consumedAmount: 0, remainingAmount: 10_000 })
    expect(store.buckets.size).toBe(0)
    expect(store.idempotency.size).toBe(0)
  })

  it("repairs a failed post-commit alarm on cached replay without double spend", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store, schedulerFailures: 1 })
    await harness.processor.startRun(createRunBudgetStartInput())
    const input = createRunBudgetApplyInput()

    await expect(harness.processor.applySyncEvent(input)).rejects.toThrow("scheduler unavailable")
    expect(store.runs.get("run_1")).toMatchObject({ consumedAmount: 5_000, flushedAmount: 0 })
    expect(store.buckets.size).toBe(1)
    expect(store.idempotency.size).toBe(1)
    expect(harness.state.alarmAt).toBeNull()

    await expect(harness.processor.applySyncEvent(input)).resolves.toMatchObject({
      allowed: true,
      budget: { consumedAmount: 5_000, remainingAmount: 5_000 },
    })
    expect(harness.pricingApply).toHaveBeenCalledTimes(1)
    expect(store.runs.get("run_1")).toMatchObject({ consumedAmount: 5_000, flushedAmount: 0 })
    expect(harness.state.alarmAt).toBe(RUN_BUDGET_TEST_NOW + 10_000)
  })

  it("rejects missing billing-period context before calling pricing", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    const input = createRunBudgetApplyInput()

    await expect(
      harness.processor.applySyncEvent({
        ...input,
        entitlement: { ...input.entitlement, billingPeriods: [] },
      })
    ).resolves.toMatchObject({
      allowed: false,
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
    expect(harness.pricingApply).not.toHaveBeenCalled()
  })

  it("creates a fresh wallet graph for start, capture, and release", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    await harness.processor.endRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: RUN_BUDGET_TEST_NOW + 1_000,
    })

    expect(harness.walletCreate).toHaveBeenCalledTimes(3)
    expect(harness.createReservation).toHaveBeenCalledTimes(1)
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
  })

  it("schedules a capture alarm after accepted spend", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    expect(harness.state.alarmAt).toBe(RUN_BUDGET_TEST_NOW + 10_000)
  })

  it("retries an immutable persisted capture before opening a later range", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    harness.captureReservationUsage.mockRejectedValueOnce(new Error("wallet unavailable"))

    await harness.processor.flushCaptures()
    await harness.processor.applySyncEvent(
      createRunBudgetApplyInput({
        idempotencyKey: "idem_after_retryable_capture",
        event: {
          ...createRunBudgetApplyInput().event,
          id: "evt_after_retryable_capture",
        },
      })
    )
    await harness.processor.flushCaptures()

    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(3)
    const first = harness.captureReservationUsage.mock.calls[0]?.[0]
    const second = harness.captureReservationUsage.mock.calls[1]?.[0]
    const third = harness.captureReservationUsage.mock.calls[2]?.[0]
    expect(second).toEqual(first)
    expect(third).toMatchObject({ amount: 5_000 })
    expect(third?.flushSeq).toBeGreaterThan(second?.flushSeq ?? 0)
  })

  it("rolls back partial capture success bookkeeping and recovers on retry", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    store.failNextCaptureSuccessAfterBucketWrite = true

    await harness.processor.flushCaptures()
    expect(store.runs.get("run_1")).toMatchObject({ flushedAmount: 0 })
    expect([...store.buckets.values()][0]).toMatchObject({ flushedAmount: 0 })
    expect([...store.intents.values()][0]).toMatchObject({ status: "failed", attemptCount: 1 })

    await harness.processor.flushCaptures()
    expect(store.runs.get("run_1")).toMatchObject({ flushedAmount: 5_000 })
    expect([...store.buckets.values()][0]).toMatchObject({ flushedAmount: 5_000 })
    expect([...store.intents.values()][0]).toMatchObject({ status: "captured" })
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(2)
  })

  it("uses run currency for spend buckets when producer fact currency differs", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput({ currency: "USD" }))
    harness.pricingApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [createRunBudgetMeterFact({ currency: "EUR" })],
    })

    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    expect([...store.buckets.values()][0]).toMatchObject({ currency: "USD", consumedAmount: 5_000 })
  })

  it("flushes only invoice-matching statement buckets", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(createRunBudgetStartInput({ budgetAmount: 20_000 }))
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())

    const secondAt = RUN_BUDGET_TEST_NOW + 100_000
    harness.pricingApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [
        createRunBudgetMeterFact({
          event_id: "evt_2",
          idempotency_key: "idem_consume_2:ew",
          timestamp: secondAt,
          period_key: "period_2",
        }),
      ],
    })
    const second = createRunBudgetApplyInput({
      idempotencyKey: "idem_consume_2",
      event: { ...createRunBudgetApplyInput().event, id: "evt_2", timestamp: secondAt },
    })
    await harness.processor.applySyncEvent({
      ...second,
      entitlement: {
        ...second.entitlement,
        billingPeriods: [
          {
            billingPeriodId: "bp_2",
            cycleStartAt: RUN_BUDGET_TEST_NOW + 50_000,
            cycleEndAt: RUN_BUDGET_TEST_NOW + 150_000,
            featurePlanVersionItemId: "item_2",
            statementKey: "stmt_2",
          },
        ],
      },
    })

    await expect(
      harness.processor.flushCapturesForInvoicing({ statementKey: "stmt_1", billingPeriodIds: [] })
    ).resolves.toEqual({ ok: true, flushed: 1, skipped: 0 })
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(1)
    expect(harness.captureReservationUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ statementKey: "stmt_1", billingPeriodId: "bp_1" })
    )
    await harness.processor.flushCaptures()
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(2)
  })

  it("defers expiry while a capture is unresolved, then closes after recovery", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(
      createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW + 1 })
    )
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    harness.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))
    harness.state.now += 1

    await harness.processor.alarm()
    await expect(
      harness.processor.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
    ).resolves.toMatchObject({ status: "running", consumedAmount: 5_000 })
    expect(harness.releaseReservation).not.toHaveBeenCalled()
    expect(harness.state.alarmAt).toBeGreaterThan(harness.state.now)

    harness.captureReservationUsage.mockResolvedValue({ val: { capturedAmount: 0 } })
    await harness.processor.alarm()
    await expect(
      harness.processor.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
    ).resolves.toMatchObject({ status: "expired" })
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
  })

  it("rejects post-expiry usage while capture recovery is pending without adding spend", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(
      createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW + 1 })
    )
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    harness.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))
    harness.state.now += 1

    const late = createRunBudgetApplyInput({
      idempotencyKey: "idem_late",
      now: RUN_BUDGET_TEST_NOW + 1,
      event: {
        ...createRunBudgetApplyInput().event,
        id: "evt_late",
        timestamp: RUN_BUDGET_TEST_NOW + 1,
      },
    })
    await expect(harness.processor.applySyncEvent(late)).resolves.toMatchObject({
      allowed: false,
      rejectionReason: "RUN_BUDGET_EXCEEDED",
      budget: { status: "running", consumedAmount: 5_000 },
    })
    expect(harness.pricingApply).toHaveBeenCalledTimes(1)
    await expect(
      harness.processor.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
    ).resolves.toMatchObject({ consumedAmount: 5_000 })
  })

  it("abandons exhausted captures, flags reconciliation, and stops retrying", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(
      createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW + 1 })
    )
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    harness.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))
    harness.state.now += 1

    await harness.processor.alarm()
    await harness.processor.alarm()
    await harness.processor.alarm()

    await expect(
      harness.processor.getRunStatus({ runId: "run_1", customerId: "cus_1", projectId: "proj_1" })
    ).resolves.toMatchObject({ status: "expired", reconciliationNeeded: true })
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(5)
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
    expect(harness.logger.error).toHaveBeenCalledWith(
      "run closed with abandoned captures requiring reconciliation",
      expect.objectContaining({ abandoned_capture_count: 1, abandoned_amount: 5_000 })
    )
    await harness.processor.alarm()
    expect(harness.captureReservationUsage).toHaveBeenCalledTimes(5)
  })

  it("repairs only a missing terminal endedAt on cached rolling-deploy decisions", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput())
    await harness.processor.endRun({
      runId: "run_1",
      customerId: "cus_1",
      projectId: "proj_1",
      status: "completed",
      endedAt: RUN_BUDGET_TEST_NOW + 10,
    })
    const input = createRunBudgetApplyInput()
    await harness.processor.applySyncEvent(input)
    const cached = store.idempotency.get(input.idempotencyKey)
    expect(cached).toBeDefined()
    const decision = JSON.parse(cached!.decisionJson)
    delete decision.budget.endedAt
    decision.budget.consumedAmount = 123
    cached!.decisionJson = JSON.stringify(decision)

    await expect(harness.processor.applySyncEvent(input)).resolves.toMatchObject({
      budget: { endedAt: RUN_BUDGET_TEST_NOW + 10, consumedAmount: 123 },
    })
  })

  it("schedules the earliest expiry and finalizes it through the alarm", async () => {
    const harness = createRunBudgetProcessorHarness()
    await harness.processor.startRun(
      createRunBudgetStartInput({ expiresAt: RUN_BUDGET_TEST_NOW + 1_000 })
    )
    expect(harness.state.alarmAt).toBe(RUN_BUDGET_TEST_NOW + 1_000)

    harness.state.now += 1_000
    await harness.processor.alarm()
    await expect(
      harness.processor.getRunStatus({
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).resolves.toMatchObject({ status: "expired", endedAt: RUN_BUDGET_TEST_NOW + 1_000 })
    await harness.processor.alarm()
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
    await expect(
      harness.processor.endRun({
        runId: "run_1",
        customerId: "cus_1",
        projectId: "proj_1",
        status: "completed",
        endedAt: RUN_BUDGET_TEST_NOW + 2_000,
      })
    ).resolves.toMatchObject({ status: "expired", endedAt: RUN_BUDGET_TEST_NOW + 1_000 })
  })

  it("throws RUN_NOT_FOUND for an unknown run status", async () => {
    const harness = createRunBudgetProcessorHarness()
    await expect(
      harness.processor.getRunStatus({
        runId: "missing",
        customerId: "cus_1",
        projectId: "proj_1",
      })
    ).rejects.toThrow("RUN_NOT_FOUND")
  })
})

describe("RunBudgetProcessor capture sequence regressions", () => {
  it("assigns distinct wallet command sequences to distinct buckets created in one millisecond", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput({ budgetAmount: 20_000 }))
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())

    const secondAt = RUN_BUDGET_TEST_NOW + 100_000
    harness.pricingApply.mockResolvedValueOnce({
      allowed: true,
      meterFacts: [
        createRunBudgetMeterFact({
          event_id: "evt_sequence_2",
          idempotency_key: "idem_sequence_2:ew",
          period_key: "period_2",
          timestamp: secondAt,
        }),
      ],
    })
    const second = createRunBudgetApplyInput({
      idempotencyKey: "idem_sequence_2",
      event: {
        ...createRunBudgetApplyInput().event,
        id: "evt_sequence_2",
        timestamp: secondAt,
      },
    })
    await harness.processor.applySyncEvent({
      ...second,
      entitlement: {
        ...second.entitlement,
        billingPeriods: [
          {
            billingPeriodId: "bp_2",
            cycleStartAt: RUN_BUDGET_TEST_NOW + 50_000,
            cycleEndAt: RUN_BUDGET_TEST_NOW + 150_000,
            featurePlanVersionItemId: "item_2",
            statementKey: "stmt_2",
          },
        ],
      },
    })

    const walletCommands = new Map<string, string>()
    harness.captureReservationUsage.mockImplementation(async (input) => {
      const commandKey = `capture:${input.reservationId}:${input.flushSeq}`
      const payload = JSON.stringify({
        amount: input.amount,
        billingPeriodId: input.billingPeriodId,
        metadata: input.metadata,
        statementKey: input.statementKey,
      })
      const existing = walletCommands.get(commandKey)
      if (existing !== undefined && existing !== payload) {
        throw new UnPriceWalletError({ message: "WALLET_IDEMPOTENCY_CONFLICT" })
      }
      walletCommands.set(commandKey, payload)
      return { val: { capturedAmount: input.amount } }
    })

    await harness.processor.flushCaptures()

    expect(walletCommands.size).toBe(2)
    expect([...store.buckets.values()].map((bucket) => bucket.flushedAmount)).toEqual([
      5_000, 5_000,
    ])
  })

  it("creates a fresh capture range when later spend follows an abandoned range", async () => {
    const store = new InMemoryRunBudgetStore()
    const harness = createRunBudgetProcessorHarness({ store })
    await harness.processor.startRun(createRunBudgetStartInput({ budgetAmount: 20_000 }))
    await harness.processor.applySyncEvent(createRunBudgetApplyInput())
    harness.captureReservationUsage.mockRejectedValue(new Error("wallet unavailable"))

    for (let attempt = 0; attempt < 5; attempt++) {
      await harness.processor.flushCaptures()
    }
    expect([...store.intents.values()][0]).toMatchObject({
      amount: 5_000,
      attemptCount: 5,
      status: "abandoned",
    })

    harness.captureReservationUsage.mockResolvedValue({ val: { capturedAmount: 5_000 } })
    await harness.processor.applySyncEvent(
      createRunBudgetApplyInput({
        idempotencyKey: "idem_after_abandonment",
        event: {
          ...createRunBudgetApplyInput().event,
          id: "evt_after_abandonment",
        },
      })
    )
    await harness.processor.flushCaptures()

    expect(store.intents.size).toBe(2)
    expect([...store.intents.values()]).toEqual([
      expect.objectContaining({ rangeStartAmount: 0, targetAmount: 5_000 }),
      expect.objectContaining({ rangeStartAmount: 5_000, targetAmount: 10_000 }),
    ])
    expect([...store.buckets.values()][0]).toMatchObject({
      consumedAmount: 10_000,
      flushedAmount: 5_000,
    })
  })
})
