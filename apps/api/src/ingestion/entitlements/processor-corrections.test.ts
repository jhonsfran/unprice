import { describe, expect, it } from "vitest"
import type { ApplyResult } from "./contracts"
import {
  BASE_NOW,
  createApplyInput,
  createBatchInput,
  createGrantSnapshot,
  createHarness,
} from "./testing/processor-regression-fixtures"

describe("grant correction correctness", () => {
  it.each([
    ["sum", "single", false],
    ["sum", "single", true],
    ["sum", "batch", false],
    ["sum", "batch", true],
    ["latest", "single", false],
    ["latest", "single", true],
    ["latest", "batch", false],
    ["latest", "batch", true],
  ] as const)(
    "restores grant capacity for %s through %s with enforcement %s",
    async (aggregationMethod, mode, enforceLimit) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit,
        limit: 10,
        meterConfig: {
          aggregationMethod,
          aggregationField: "amount",
          eventId: "correction-meter",
          eventSlug: "tokens_used",
        },
      })
      const events = (aggregationMethod === "sum" ? [10, -4, 4] : [10, 6, 10]).map(
        (amount, index) => ({
          ...base.event,
          id: `correction-event-${index}`,
          idempotencyKey: `correction-key-${index}`,
          correlationKey: `correction-${index}`,
          properties: { amount },
          timestamp: now + index,
          now: now + index,
        })
      )
      const results: ApplyResult[] = []
      if (mode === "batch") {
        results.push(
          ...(
            await harness.processor.applyBatch({
              customerId: base.customerId,
              projectId: base.projectId,
              entitlement: base.entitlement,
              enforceLimit,
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
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
        }
      }
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => ({
            delta: fact.delta,
            value: fact.value_after,
            amount: fact.amount,
          }))
        )
      ).toEqual([
        [{ delta: 10, value: 10, amount: 1_000_000_000 }],
        [{ delta: -4, value: 6, amount: -400_000_000 }],
        [{ delta: 4, value: 10, amount: 400_000_000 }],
      ])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10, limit: 10, isLimitReached: true })
      const correction = events[1]
      if (!correction) throw new Error("Expected correction event")
      const replay = await harness.processor.apply({
        ...base,
        event: correction,
        idempotencyKey: correction.idempotencyKey,
        now: correction.now,
      })
      expect(replay).toMatchObject({ allowed: true, idempotencyStatus: "already_reported" })
      expect(
        [...harness.store.grantStates.values()].map((state) => state.consumedInCurrentWindow)
      ).toEqual([10])
    }
  )

  it.each(["single", "batch"] as const)(
    "reverses consumption across multiple grants through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit: true,
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const events = createBatchInput(base, [10, -7, 7], "multiple-correction").events
      const results: ApplyResult[] = []
      if (mode === "batch") {
        results.push(
          ...(
            await harness.processor.applyBatch({ ...createBatchInput(base, [], "unused"), events })
          ).results
        )
      } else {
        for (const event of events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      }
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results[1]?.meterFacts?.map((fact) => ({
          grant: fact.grant_id,
          delta: fact.delta,
          value: fact.value_after,
          amount: fact.amount,
        }))
      ).toEqual([
        { grant: "grant_second", delta: -4, value: 0, amount: -400_000_000 },
        { grant: "grant_first", delta: -3, value: 3, amount: -300_000_000 },
      ])
      expect(
        [...harness.store.grantStates.values()].map((state) => ({
          grant: state.grantId,
          usage: state.consumedInCurrentWindow,
        }))
      ).toEqual([
        { grant: "grant_first", usage: 6 },
        { grant: "grant_second", usage: 4 },
      ])
    }
  )

  it.each(["single", "batch"] as const)(
    "preserves signed raw totals and floor-zero billable usage through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({ now, enforceLimit: true, limit: 10 })
      const input = createBatchInput(base, [10, -14, 4, 3], "over-correction")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(results.map((result) => result.allowed)).toEqual([true, true, true, true])
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => ({
            delta: fact.delta,
            value: fact.value_after,
            amount: fact.amount,
          }))
        )
      ).toEqual([
        [{ delta: 10, value: 10, amount: 1_000_000_000 }],
        [{ delta: -10, value: 0, amount: -1_000_000_000 }],
        [{ delta: 0, value: 0, amount: 0 }],
        [{ delta: 3, value: 3, amount: 300_000_000 }],
      ])
      expect([...harness.store.meterStates.values()].map((state) => state.usage)).toEqual([3])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 3, limit: 10, isLimitReached: false })
    }
  )
})

describe("overage correction allocation", () => {
  it.each(["single", "batch"] as const)(
    "reverses overflow before included capacity and publishes one snapshot per grant through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        enforceLimit: false,
        overageStrategy: "always",
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const input = createBatchInput(base, [15, -3, -5, -6], "overage-correction")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else
        for (const event of input.events)
          results.push(
            await harness.processor.apply({
              ...base,
              event,
              idempotencyKey: event.idempotencyKey,
              now: event.now,
            })
          )
      expect(
        results.map((result) =>
          result.meterFacts?.map((fact) => [
            fact.grant_id,
            fact.delta,
            fact.value_after,
            fact.amount,
          ])
        )
      ).toEqual([
        [
          ["grant_first", 11, 11, 1_100_000_000],
          ["grant_second", 4, 4, 400_000_000],
        ],
        [["grant_first", -3, 8, -300_000_000]],
        [
          ["grant_first", -2, 6, -200_000_000],
          ["grant_second", -3, 1, -300_000_000],
        ],
        [
          ["grant_second", -1, 0, -100_000_000],
          ["grant_first", -5, 1, -500_000_000],
        ],
      ])
      for (const result of results) {
        const identities =
          result.meterFacts?.map((fact) =>
            [
              fact.customer_entitlement_id,
              fact.grant_id,
              fact.period_key,
              fact.idempotency_key,
            ].join("|")
          ) ?? []
        expect(new Set(identities).size).toBe(identities.length)
      }
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 1 })
    }
  )
})
