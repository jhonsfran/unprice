import { expect, it } from "vitest"
import { createApplyInput } from "./entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "./testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "./testing/processor-contract"
import { createBatchInput } from "./testing/processor-regression-fixtures"
import {
  type EntitlementWindowWalletHarnessOverrides,
  createEntitlementWindowWalletHarness,
} from "./testing/wallet-harness"

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

it.each(["capture", "extend"] as const)(
  "keeps persisted flush intent unchanged when new usage follows a failed %s",
  async (failure) => {
    const now = Date.now()
    const overrides: EntitlementWindowWalletHarnessOverrides =
      failure === "capture"
        ? { captureError: "WALLET_LEDGER_FAILED" }
        : { extendError: "WALLET_LEDGER_FAILED" }
    const wallet = createEntitlementWindowWalletHarness(overrides)
    const store = new InMemoryEntitlementWindowStore()
    const harness = createEntitlementWindowProcessorHarness({ now, store, wallet: wallet.provider })
    await harness.processor.initialize()
    const base = createApplyInput({
      now,
      periodStartAt: now - 60_000,
      periodEndAt: now + 60_000,
      creditLinePolicy: "capped",
      event: { timestamp: now },
    })
    const first = await harness.processor.applyBatch(createBatchInput(base, [8], "failed-flush"))
    expect(first.results.map((row) => row.allowed)).toEqual([true])
    await Promise.all(harness.waitUntilPromises)
    expect(store.walletRow).toMatchObject({
      consumedAmount: 800_000_000,
      consumedQuantity: 8,
      flushSeq: 0,
      pendingFlushSeq: 1,
      pendingFlushAmount: 800_000_000,
      pendingFlushQuantity: 8,
      pendingRefillAmount: 2_800_000_000,
      refillInFlight: false,
    })
    delete overrides.captureError
    delete overrides.extendError

    const next = await harness.processor.applyBatch(createBatchInput(base, [1, 1], "new-usage"))
    expect(next.results.map((row) => row.allowed)).toEqual([true, true])
    await Promise.all(harness.waitUntilPromises)
    expect(
      wallet.captureReservationUsage.mock.calls.map(([input]) => [
        input.amount,
        input.metadata?.quantity,
      ])
    ).toEqual([
      [800_000_000, 8],
      [800_000_000, 8],
    ])
    expect(wallet.extendReservation.mock.calls.map(([input]) => input.requestedAmount)).toEqual(
      failure === "capture" ? [2_800_000_000] : [2_800_000_000, 2_800_000_000]
    )
    expect(store.walletRow).toMatchObject({
      consumedAmount: 1_000_000_000,
      consumedQuantity: 10,
      flushedAmount: 800_000_000,
      flushedQuantity: 8,
      flushSeq: 1,
      pendingFlushSeq: null,
      refillInFlight: false,
    })
  }
)
