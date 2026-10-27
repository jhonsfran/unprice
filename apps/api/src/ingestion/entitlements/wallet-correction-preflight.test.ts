import { describe, expect, it } from "vitest"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"
import { createEntitlementWindowWalletHarness } from "./testing/wallet-harness"

describe("volume correction after wallet close", () => {
  it.each(["single", "batch"] as const)(
    "rejects a committed quantity correction without opening a new wallet hold through %s",
    async (mode) => {
      let clock = Date.now()
      const start = clock
      const wallet = createEntitlementWindowWalletHarness({ allocationAmount: 1_000_000_000_000 })
      const store = new InMemoryEntitlementWindowStore()
      const harness = createEntitlementWindowProcessorHarness({
        now: () => clock,
        store,
        wallet: wallet.provider,
      })
      await harness.processor.initialize()
      const base = createApplyInput({
        now: start,
        creditLinePolicy: "capped",
        periodStartAt: start - 60_000,
        periodEndAt: start + 60_000,
        priceConfig: {
          usageMode: "tier",
          tierMode: "volume",
          tiers: [
            {
              firstUnit: 1,
              lastUnit: 10,
              unitPrice: {
                dinero: { amount: 100, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
                displayAmount: "1.00",
              },
              flatPrice: {
                dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
                displayAmount: "0.00",
              },
            },
            {
              firstUnit: 11,
              lastUnit: null,
              unitPrice: {
                dinero: { amount: 10, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
                displayAmount: "0.10",
              },
              flatPrice: {
                dinero: { amount: 0, currency: { code: "USD", base: 10, exponent: 2 }, scale: 2 },
                displayAmount: "0.00",
              },
            },
          ],
        },
        event: { id: "volume-initial", timestamp: start, properties: { amount: 11 } },
      })
      const first = await harness.processor.apply(base)
      expect(first.meterFacts?.map((fact) => [fact.delta, fact.amount])).toEqual([
        [11, 110_000_000],
      ])
      await Promise.all(harness.waitUntilPromises)
      clock = start + 60_001
      await harness.processor.alarm()
      expect(store.walletRow).toMatchObject({
        reservationId: null,
        consumedAmount: 110_000_000,
        consumedQuantity: 11,
        flushedAmount: 110_000_000,
        flushedQuantity: 11,
      })
      const before = structuredClone(store.walletRow)
      const event = {
        ...base.event,
        id: "volume-correction",
        properties: { amount: -1 },
        timestamp: start + 1,
      }
      const corrected =
        mode === "single"
          ? await harness.processor.apply({
              ...base,
              now: clock,
              idempotencyKey: "volume-correction",
              event,
            })
          : (
              await harness.processor.applyBatch({
                customerId: base.customerId,
                projectId: base.projectId,
                entitlement: base.entitlement,
                grants: base.grants,
                enforceLimit: base.enforceLimit,
                events: [
                  {
                    ...event,
                    correlationKey: "volume-correction",
                    idempotencyKey: "volume-correction",
                    now: clock,
                  },
                ],
              })
            ).results[0]
      expect(corrected).toMatchObject({
        allowed: false,
        deniedReason: "INVALID_AGGREGATION_PROPERTIES",
      })
      expect(store.walletRow).toEqual(before)
      expect([...store.meterStates.values()].map((state) => state.usage)).toEqual([11])
      expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual(
        [11]
      )
    }
  )
})
