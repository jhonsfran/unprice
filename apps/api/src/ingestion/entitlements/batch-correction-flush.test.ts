import { expect, it } from "vitest"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"
import { createEntitlementWindowWalletHarness } from "./testing/wallet-harness"

it.each([
  { amounts: [10, -4], usage: 6, captures: [[600_000_000, 6]], extensions: [2_600_000_000] },
  { amounts: [10, -4, 4], usage: 10, captures: [[1_000_000_000, 10]], extensions: [3_000_000_000] },
  { amounts: [10, -10], usage: 0, captures: [], extensions: [] },
])(
  "commits and flushes net accepted batch usage $usage",
  async ({ amounts, usage, captures, extensions }) => {
    const now = Date.now()
    const wallet = createEntitlementWindowWalletHarness()
    const store = new InMemoryEntitlementWindowStore()
    const harness = createEntitlementWindowProcessorHarness({ now, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const base = createApplyInput({
      now,
      periodStartAt: now - 60_000,
      periodEndAt: now + 60_000,
      creditLinePolicy: "capped",
      enforceLimit: true,
      limit: 10,
      event: { timestamp: now },
    })
    const events = amounts.map((amount, index) => ({
      ...base.event,
      id: `draft-${index}`,
      idempotencyKey: `draft-${index}`,
      correlationKey: `draft-${index}`,
      properties: { amount },
      timestamp: now + index,
      now: now + index,
    }))
    const result = await harness.processor.applyBatch({
      customerId: base.customerId,
      projectId: base.projectId,
      entitlement: base.entitlement,
      grants: base.grants,
      enforceLimit: true,
      events,
    })
    expect(result.results.map((row) => row.allowed)).toEqual(amounts.map(() => true))
    await Promise.all(harness.waitUntilPromises)
    expect([...store.grantStates.values()].map((state) => state.consumedInCurrentWindow)).toEqual([
      usage,
    ])
    expect(
      wallet.captureReservationUsage.mock.calls.map(([input]) => [
        input.amount,
        input.metadata?.quantity,
      ])
    ).toEqual(captures)
    expect(wallet.extendReservation.mock.calls.map(([input]) => input.requestedAmount)).toEqual(
      extensions
    )
    expect(store.walletRow).toMatchObject({
      consumedAmount: usage * 100_000_000,
      consumedQuantity: usage,
      flushedAmount: usage * 100_000_000,
      flushedQuantity: usage,
      pendingFlushSeq: null,
      refillInFlight: false,
    })
  }
)
