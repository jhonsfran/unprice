import { describe, expect, it, vi } from "vitest"
import { applyInputSchema } from "./contracts"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"

describe("late meter fact proof", () => {
  it("keeps both accepted units in processing-order snapshots", async () => {
    const now = Date.UTC(2026, 9, 27, 12)
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const { processor } = createEntitlementWindowProcessorHarness({
        now,
        store: new InMemoryEntitlementWindowStore(),
      })
      const first = applyInputSchema.parse(
        createApplyInput({
          now,
          periodStartAt: now - 60_000,
          periodEndAt: now + 60_000,
          idempotencyKey: "z_first",
          event: { id: "first", timestamp: now, properties: { amount: 1 } },
        })
      )
      const second = applyInputSchema.parse(
        createApplyInput({
          now,
          periodStartAt: now - 60_000,
          periodEndAt: now + 60_000,
          idempotencyKey: "a_late",
          event: { id: "late", timestamp: now - 1_000, properties: { amount: 1 } },
        })
      )
      const a = await processor.apply(first)
      const b = await processor.apply(second)
      const replay = await processor.apply(second)
      expect([a.allowed, b.allowed, replay.allowed]).toEqual([true, true, true])
      expect(
        [...(a.meterFacts ?? []), ...(b.meterFacts ?? [])].map((fact) => ({
          timestamp: fact.timestamp,
          delta: fact.delta,
          total: fact.value_after,
        }))
      ).toEqual([
        { timestamp: now, delta: 1, total: 1 },
        { timestamp: now - 1_000, delta: 1, total: 2 },
      ])
      expect(replay.meterFacts).toEqual(b.meterFacts)
    } finally {
      vi.useRealTimers()
    }
  })
})
