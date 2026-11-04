import { describe, expect, it } from "vitest"
import type { ApplyResult } from "./contracts"
import {
  BASE_NOW,
  createApplyInput,
  createBatchInput,
  createGrantSnapshot,
  createHarness,
  createWalletHarness,
  seedWallet,
} from "./testing/processor-regression-fixtures"

describe("correction accounting boundaries", () => {
  it.each(["single", "batch", "split batches"] as const)(
    "corrects free usage accepted before wallet allocation through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness({ allocationAmount: 1_000_000_000_000 })
      const harness = createHarness({ now, wallet: wallet.provider })
      await harness.processor.initialize()
      const money = (amount: number) => ({
        dinero: { amount, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
        displayAmount: String(amount / 100),
      })
      const base = createApplyInput({
        now,
        creditLinePolicy: "capped",
        priceConfig: {
          usageMode: "tier",
          tiers: [
            { firstUnit: 1, lastUnit: 10, unitPrice: money(0), flatPrice: money(0) },
            { firstUnit: 11, lastUnit: null, unitPrice: money(100), flatPrice: money(0) },
          ],
        },
      })
      const input = createBatchInput(base, [10, 1, -2], "free-before-wallet")
      const results: ApplyResult[] = []
      if (mode === "batch") results.push(...(await harness.processor.applyBatch(input)).results)
      else {
        for (const event of input.events) {
          if (mode === "split batches")
            results.push(
              ...(await harness.processor.applyBatch({ ...input, events: [event] })).results
            )
          else
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
        results.flatMap((result) => result.meterFacts ?? []).map((fact) => fact.amount)
      ).toEqual([0, 100_000_000, -100_000_000])
      expect(harness.store.walletRow).toMatchObject({
        consumedAmount: 0,
        consumedQuantity: mode === "batch" ? 9 : 0,
        flushedAmount: 0,
        flushedQuantity: 0,
      })
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 9 })
    }
  )

  it.each(["single", "batch"] as const)(
    "keeps unchanged max snapshots per grant through %s",
    async (mode) => {
      const now = BASE_NOW
      const harness = createHarness({ now })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        meterConfig: {
          aggregationMethod: "max",
          aggregationField: "amount",
          eventId: "max-grants",
          eventSlug: "tokens_used",
        },
        grants: [
          createGrantSnapshot({ grantId: "grant_first", priority: 10, allowanceUnits: 6 }),
          createGrantSnapshot({ grantId: "grant_second", priority: 1, allowanceUnits: 4 }),
        ],
      })
      const input = createBatchInput(base, [10, 8], "unchanged-max")
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
      expect(results[0]?.meterFacts?.map((fact) => [fact.grant_id, fact.value_after])).toEqual([
        ["grant_first", 6],
        ["grant_second", 4],
      ])
      expect(
        results[1]?.meterFacts?.map((fact) => [
          fact.grant_id,
          fact.delta,
          fact.value_after,
          fact.amount,
        ])
      ).toEqual([["grant_first", 0, 6, 0]])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10 })
    }
  )

  it.each(["single", "batch"] as const)(
    "rejects a correction below captured spend atomically through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        limit: 10,
        enforceLimit: true,
        creditLinePolicy: "capped",
      })
      const positive = createBatchInput(base, [10], "captured-positive").events[0]
      if (!positive) throw new Error("Expected positive event")
      await harness.processor.apply({
        ...base,
        event: positive,
        idempotencyKey: positive.idempotencyKey,
        now: positive.now,
      })
      store.updateWalletReservation({ flushedAmount: 700_000_000, flushedQuantity: 7 })
      const input = createBatchInput(base, [-4], "captured-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction event")
      const before = {
        meters: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const rejected =
        mode === "batch"
          ? (await harness.processor.applyBatch(input)).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: correction.now,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
        message:
          "Correction would reverse committed wallet consumption. Use a separate credit workflow for captured usage.",
      })
      expect(store.meterStates).toEqual(before.meters)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
      const replay = await harness.processor.apply({
        ...base,
        event: correction,
        idempotencyKey: correction.idempotencyKey,
        now: correction.now,
      })
      expect(replay).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
        idempotencyStatus: "already_reported",
      })
      const valid = {
        ...correction,
        id: "valid-captured-correction",
        idempotencyKey: "valid-captured-correction",
        properties: { amount: -3 },
      }
      const accepted =
        mode === "batch"
          ? (await harness.processor.applyBatch({ ...input, events: [valid] })).results[0]
          : await harness.processor.apply({
              ...base,
              event: valid,
              idempotencyKey: valid.idempotencyKey,
              now: valid.now,
            })
      expect(accepted).toMatchObject({ allowed: true })
      expect(
        accepted?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
      ).toEqual([[-3, 7, -300_000_000]])
      expect(store.walletRow).toMatchObject({
        consumedAmount: 700_000_000,
        consumedQuantity: 7,
        flushedAmount: 700_000_000,
      })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([7])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 7, isLimitReached: false })
    }
  )

  it.each(["single", "batch"] as const)(
    "applies unflushed corrections without changing net wallet spend through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now,
        limit: 10,
        enforceLimit: true,
        creditLinePolicy: "capped",
      })
      const input = createBatchInput(base, [10, -4, 4], "unflushed-correction")
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
      expect(results.map((result) => result.allowed)).toEqual([true, true, true])
      expect(
        results.flatMap((result) => result.meterFacts ?? []).map((fact) => fact.amount)
      ).toEqual([1_000_000_000, -400_000_000, 400_000_000])
      expect(store.walletRow).toMatchObject({ consumedAmount: 1_000_000_000, flushedAmount: 0 })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([10])
      await expect(
        harness.processor.getEnforcementState({
          entitlement: base.entitlement,
          grants: base.grants,
          now,
        })
      ).resolves.toMatchObject({ usage: 10 })
    }
  )

  it("keeps accepted batch events when a later correction is rejected", async () => {
    const now = BASE_NOW
    const wallet = createWalletHarness()
    const harness = createHarness({ now, wallet: wallet.provider })
    const store = harness.store
    seedWallet(store, {
      allocationAmount: 1_000_000_000_000,
      targetReservationAmount: 1_000_000_000_000,
    })
    await harness.processor.initialize()
    const base = createApplyInput({ now, creditLinePolicy: "capped" })
    const first = createBatchInput(base, [10], "mixed-first").events[0]
    if (!first) throw new Error("Expected first event")
    await harness.processor.apply({
      ...base,
      event: first,
      idempotencyKey: first.idempotencyKey,
      now: first.now,
    })
    store.updateWalletReservation({ flushedAmount: 700_000_000, flushedQuantity: 7 })
    const input = createBatchInput(base, [1, -5, -4], "mixed-correction")
    const result = await harness.processor.applyBatch(input)
    expect(result.results.map((row) => row.allowed)).toEqual([true, false, true])
    expect(result.results[1]).toMatchObject({ deniedReason: "INVALID_AGGREGATION_PROPERTIES" })
    expect(
      result.results[2]?.meterFacts?.map((fact) => [fact.delta, fact.value_after, fact.amount])
    ).toEqual([[-4, 7, -400_000_000]])
    expect(store.walletRow).toMatchObject({
      consumedAmount: 700_000_000,
      flushedAmount: 700_000_000,
    })
    expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([7])
    expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual([
      7,
    ])
  })
})

describe("pending wallet capture correction boundary", () => {
  it.each(["single", "batch"] as const)(
    "rejects a correction below a persisted pending capture through %s",
    async (mode) => {
      const now = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({ now, creditLinePolicy: "capped" })
      const initial = createBatchInput(base, [10], "pending-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      store.updateWalletReservation({
        flushedAmount: 700_000_000,
        flushedQuantity: 7,
        flushSeq: 0,
        pendingFlushSeq: 1,
        pendingFlushAmount: 200_000_000,
        pendingFlushQuantity: 2,
        pendingFlushFinal: false,
        refillInFlight: true,
      })
      const before = {
        meter: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const input = createBatchInput(base, [-2], "pending-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const rejected =
        mode === "batch"
          ? (await harness.processor.applyBatch(input)).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: correction.now,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect(store.meterStates).toEqual(before.meter)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
    }
  )
})

describe("closed wallet reservation correction boundary", () => {
  it.each(["single", "batch"] as const)(
    "rejects reversing usage captured by a closed reservation through %s",
    async (mode) => {
      let clock = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now: () => clock, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({ now: BASE_NOW, creditLinePolicy: "capped" })
      const initial = createBatchInput(base, [10], "closed-wallet-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      await Promise.all(harness.waitUntilPromises)
      clock = BASE_NOW + 60_001
      await harness.processor.alarm()
      expect(store.walletRow).toMatchObject({
        reservationId: null,
        consumedAmount: 1_000_000_000,
        flushedAmount: 1_000_000_000,
      })
      const input = createBatchInput(base, [-1], "closed-wallet-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const rejected =
        mode === "batch"
          ? (
              await harness.processor.applyBatch({
                ...input,
                events: [{ ...correction, now: clock }],
              })
            ).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: clock,
            })
      expect(rejected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([10])
      expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual(
        [10]
      )
      expect(store.walletRow).toMatchObject({
        reservationId: null,
        consumedAmount: 1_000_000_000,
        flushedAmount: 1_000_000_000,
      })
    }
  )
})

describe("zero-price committed quantity correction boundary", () => {
  it.each([
    ["single", "captured"],
    ["batch", "captured"],
    ["single", "pending"],
    ["batch", "pending"],
    ["single", "closed"],
    ["batch", "closed"],
  ] as const)(
    "rejects a zero-cost correction through %s below %s quantity",
    async (mode, commitment) => {
      let clock = BASE_NOW
      const wallet = createWalletHarness()
      const harness = createHarness({ now: () => clock, wallet: wallet.provider })
      const store = harness.store
      seedWallet(store, {
        allocationAmount: 1_000_000_000_000,
        targetReservationAmount: 1_000_000_000_000,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now: BASE_NOW,
        creditLinePolicy: "capped",
        priceConfig: {
          usageMode: "unit",
          price: {
            dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
            displayAmount: "0.00",
          },
        },
      })
      const initial = createBatchInput(base, [10], "free-first").events[0]
      if (!initial) throw new Error("Expected first event")
      await harness.processor.apply({
        ...base,
        event: initial,
        idempotencyKey: initial.idempotencyKey,
        now: initial.now,
      })
      await Promise.all(harness.waitUntilPromises)
      expect(store.walletRow).toMatchObject({ consumedAmount: 0, consumedQuantity: 10 })
      if (commitment === "closed") {
        clock = BASE_NOW + 60_001
        await harness.processor.alarm()
        expect(store.walletRow).toMatchObject({
          reservationId: null,
          flushedAmount: 0,
          flushedQuantity: 10,
        })
      } else if (commitment === "pending") {
        store.updateWalletReservation({
          flushedAmount: 0,
          flushedQuantity: 7,
          flushSeq: 0,
          pendingFlushSeq: 1,
          pendingFlushAmount: 0,
          pendingFlushQuantity: 2,
          pendingFlushFinal: false,
          refillInFlight: true,
        })
      } else store.updateWalletReservation({ flushedAmount: 0, flushedQuantity: 7 })
      const before = {
        meters: structuredClone(store.meterStates),
        grants: structuredClone(store.grantStates),
        wallet: structuredClone(store.walletRow),
      }
      const input = createBatchInput(base, [commitment === "pending" ? -2 : -4], "free-correction")
      const correction = input.events[0]
      if (!correction) throw new Error("Expected correction")
      const result =
        mode === "batch"
          ? (
              await harness.processor.applyBatch({
                ...input,
                events: [{ ...correction, now: clock }],
              })
            ).results[0]
          : await harness.processor.apply({
              ...base,
              event: correction,
              idempotencyKey: correction.idempotencyKey,
              now: clock,
            })
      expect(result).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect(store.meterStates).toEqual(before.meters)
      expect(store.grantStates).toEqual(before.grants)
      expect(store.walletRow).toEqual(before.wallet)
    }
  )
})
