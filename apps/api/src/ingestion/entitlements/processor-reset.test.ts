import { LATE_EVENT_GRACE_MS } from "@unprice/services/entitlements"
import { describe, expect, it, vi } from "vitest"
import type { ApplyResult } from "./contracts"
import {
  createApplyInput,
  createBatchInput,
  createHarness,
} from "./testing/processor-regression-fixtures"

describe("reset-scoped aggregation correctness", () => {
  it.each([
    ["max", "single"],
    ["max", "batch"],
    ["latest", "single"],
    ["latest", "batch"],
  ] as const)(
    "isolates %s state across daily resets through %s apply",
    async (aggregationMethod, mode) => {
      const dayStart = Date.UTC(2026, 9, 27)
      const now = dayStart + 100
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: dayStart - 86_400_000,
          periodEndAt: dayStart + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          meterConfig: {
            aggregationField: "amount",
            aggregationMethod,
            eventId: "daily-meter",
            eventSlug: "tokens_used",
          },
        })
        const events = [
          { amount: 10, timestamp: dayStart - 100 },
          { amount: 6, timestamp: dayStart + 1 },
          { amount: 12, timestamp: dayStart - 1 },
          { amount: 8, timestamp: dayStart + 2 },
        ].map(({ amount, timestamp }, index) => ({
          ...base.event,
          properties: { amount },
          timestamp,
          id: `reset-event-${index}`,
          idempotencyKey: `reset-key-${index}`,
          correlationKey: `reset-${index}`,
          now,
        }))
        const results: ApplyResult[] = []
        if (mode === "batch") {
          results.push(
            ...(
              await harness.processor.applyBatch({
                customerId: base.customerId,
                projectId: base.projectId,
                entitlement: base.entitlement,
                enforceLimit: base.enforceLimit,
                grants: base.grants,
                events,
              })
            ).results
          )
        } else {
          for (const event of events) {
            results.push(
              await harness.processor.apply({
                ...base,
                idempotencyKey: event.idempotencyKey,
                event,
              })
            )
          }
        }
        expect(
          results.map((result) =>
            result.meterFacts?.map((fact) => ({
              delta: fact.delta,
              valueAfter: fact.value_after,
              amount: fact.amount,
              periodKey: fact.period_key,
            }))
          )
        ).toEqual([
          [
            {
              delta: 10,
              valueAfter: 10,
              amount: 1_000_000_000,
              periodKey: `day:${dayStart - 86_400_000}`,
            },
          ],
          [{ delta: 6, valueAfter: 6, amount: 600_000_000, periodKey: `day:${dayStart}` }],
          [
            {
              delta: 2,
              valueAfter: 12,
              amount: 200_000_000,
              periodKey: `day:${dayStart - 86_400_000}`,
            },
          ],
          [{ delta: 2, valueAfter: 8, amount: 200_000_000, periodKey: `day:${dayStart}` }],
        ])
        await expect(
          harness.processor.getEnforcementState({
            entitlement: base.entitlement,
            grants: base.grants,
            now,
          })
        ).resolves.toMatchObject({ usage: 8 })
        const lateEvent = events[2]
        if (!lateEvent) throw new Error("Expected a late prior-period event")
        const replay = await harness.processor.apply({
          ...base,
          event: lateEvent,
          idempotencyKey: lateEvent.idempotencyKey,
        })
        expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
        expect(
          [...harness.store.grantStates.values()]
            .map((state) => state.consumedInCurrentWindow)
            .sort((a, b) => a - b)
        ).toEqual([8, 12])
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe("reset-scoped replay", () => {
  it.each(["single", "batch"] as const)(
    "replays a sealed receipt through %s without initializing reset state",
    async (mode) => {
      const now = Date.UTC(2026, 9, 27, 12)
      vi.useFakeTimers()
      vi.setSystemTime(now)
      try {
        const harness = createHarness({ now })
        await harness.processor.initialize()
        const base = createApplyInput({
          now,
          periodStartAt: now - 86_400_000,
          periodEndAt: now + 86_400_000,
          resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
          event: { timestamp: now, properties: { amount: 3 } },
        })
        const accepted = await harness.processor.apply(base)
        harness.store.meterStates.clear()
        const input = createBatchInput(base, [3], "reset-replay")
        const event = input.events[0]
        if (!event) throw new Error("Expected replay event")
        const replay =
          mode === "single"
            ? await harness.processor.apply(base)
            : (
                await harness.processor.applyBatch({
                  ...input,
                  events: [
                    { ...event, idempotencyKey: base.idempotencyKey },
                    { ...event, idempotencyKey: base.idempotencyKey },
                  ],
                })
              ).results[1]
        expect(replay).toMatchObject({
          allowed: true,
          idempotencyStatus: "already_reported",
          meterFacts: accepted.meterFacts,
        })
        expect(harness.store.meterStates.size).toBe(0)
        expect(
          [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
        ).toEqual([3])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it("replays a staged duplicate before reading its reset period", async () => {
    const dayStart = Date.UTC(2026, 9, 27)
    const now = dayStart + 10
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        periodStartAt: dayStart - 86_400_000,
        periodEndAt: dayStart + 86_400_000,
        resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
        event: { timestamp: now },
      })
      const input = createBatchInput(base, [6], "staged-reset-replay")
      const first = input.events[0]
      if (!first) throw new Error("Expected new-period event")
      const result = await harness.processor.applyBatch({
        ...input,
        events: [first, { ...first, timestamp: dayStart - 1 }],
      })
      expect(
        result.results[0]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[6, 6, 600_000_000]])
      expect(result.results[1]).toMatchObject({
        allowed: true,
        idempotencyStatus: "already_reported",
        meterFacts: result.results[0]?.meterFacts,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("closed-period batch handling", () => {
  it("accepts the new period and denies a closed event", async () => {
    const dayStart = Date.UTC(2026, 9, 27)
    const now = dayStart + LATE_EVENT_GRACE_MS + 1
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        periodStartAt: dayStart - 86_400_000,
        periodEndAt: dayStart + 86_400_000,
        resetConfig: { resetInterval: "day", resetIntervalCount: 1, resetAnchor: 0 },
        event: { timestamp: now },
      })
      const input = createBatchInput(base, [4, 1], "closed-period")
      const fresh = input.events[0]
      const closed = input.events[1]
      if (!fresh || !closed) throw new Error("Expected fresh and closed events")
      const result = await harness.processor.applyBatch({
        ...input,
        events: [fresh, { ...closed, timestamp: dayStart - 1 }],
      })
      expect(
        result.results[0]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[4, 4, 400_000_000]])
      expect(result.results[1]).toMatchObject({
        allowed: false,
        deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      })
      expect(
        [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
      ).toEqual([4])
    } finally {
      vi.useRealTimers()
    }
  })
})
