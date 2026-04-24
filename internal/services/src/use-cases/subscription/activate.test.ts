import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor } from "@unprice/money"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ServiceContext } from "../../context"
import { customerAccountKeys } from "../../ledger"
import type { LedgerGateway } from "../../ledger"
import { UnPriceWalletError, type WalletService } from "../../wallet"
import { activateSubscription } from "./activate"

// ---------------------------------------------------------------------------
// Fakes — the activation use case only touches three collaborators:
//   - `services.wallet`  (adjust, transfer, createReservation)
//   - `services.ledger`  (getAccountBalance, for the pre-flight check)
//   - `db.query.subscriptions.findFirst` + `db.update(subscriptions).set().where()`
// ---------------------------------------------------------------------------

const DOLLAR = 100_000_000
const customerId = "cus_abc"
const projectId = "prj_abc"
const subscriptionId = "sub_123"
const periodStartAt = new Date("2026-02-01T00:00:00Z")
const periodEndAt = new Date("2026-03-01T00:00:00Z")

interface FakeState {
  balances: Record<string, number>
  walletCalls: {
    adjust: Array<{ signedAmount: number; source: string; expiresAt?: Date }>
    transfer: Array<{
      amount: number
      fromAccountKey: string
      toAccountKey: string
      metadata: Record<string, unknown>
    }>
    createReservation: Array<{
      entitlementId: string
      requestedAmount: number
    }>
  }
  subscriptionUpdates: Array<Record<string, unknown>>
}

function createState(): FakeState {
  return {
    balances: {},
    walletCalls: { adjust: [], transfer: [], createReservation: [] },
    subscriptionUpdates: [],
  }
}

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

type WalletStubs = {
  adjustImpl?: (input: unknown) => Promise<{ val: { grantId?: string; clampedAmount: number } }>
  transferImpl?: (input: unknown) => Promise<{ val: undefined; err?: UnPriceWalletError }>
  createReservationImpl?: (input: {
    entitlementId: string
    requestedAmount: number
  }) => Promise<{
    val?: { reservationId: string; allocationAmount: number; drainLegs: never[] }
    err?: UnPriceWalletError
  }>
}

function buildDeps(state: FakeState, customerExists = true, stubs: WalletStubs = {}) {
  const wallet = {
    adjust: vi.fn(async (input: {
      signedAmount: number
      source: string
      expiresAt?: Date
    }) => {
      state.walletCalls.adjust.push({
        signedAmount: input.signedAmount,
        source: input.source,
        expiresAt: input.expiresAt,
      })
      if (stubs.adjustImpl) return stubs.adjustImpl(input)
      return Ok({
        grantId: `wgr_${state.walletCalls.adjust.length}`,
        clampedAmount: input.signedAmount,
        unclampedRemainder: 0,
      })
    }),
    transfer: vi.fn(async (input: {
      amount: number
      fromAccountKey: string
      toAccountKey: string
      metadata: Record<string, unknown>
    }) => {
      state.walletCalls.transfer.push({
        amount: input.amount,
        fromAccountKey: input.fromAccountKey,
        toAccountKey: input.toAccountKey,
        metadata: input.metadata,
      })
      if (stubs.transferImpl) return stubs.transferImpl(input)
      return Ok(undefined)
    }),
    createReservation: vi.fn(async (input: {
      entitlementId: string
      requestedAmount: number
    }) => {
      state.walletCalls.createReservation.push({
        entitlementId: input.entitlementId,
        requestedAmount: input.requestedAmount,
      })
      if (stubs.createReservationImpl) return stubs.createReservationImpl(input)
      return Ok({
        reservationId: `res_${state.walletCalls.createReservation.length}`,
        allocationAmount: input.requestedAmount,
        drainLegs: [],
      })
    }),
  } as unknown as WalletService

  const ledger = {
    getAccountBalance: vi.fn(async (name: string) => {
      const minor = state.balances[name] ?? 0
      return Ok(fromLedgerMinor(minor, "USD"))
    }),
  } as unknown as LedgerGateway

  // The tx handle is the same shape as db, minus transaction(). The
  // activate use case only needs tx.update() and tx.execute() inside
  // the outer transaction; the wallet stubs are injected above and
  // don't interact with tx directly.
  const tx = {
    execute: vi.fn(async () => ({ rows: [] })),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        state.subscriptionUpdates.push(data)
        return { where: vi.fn(async () => undefined) }
      }),
    })),
  }

  const db = {
    query: {
      subscriptions: {
        findFirst: vi.fn(async () => {
          if (!customerExists) return null
          return {
            id: subscriptionId,
            projectId,
            customer: { id: customerId, defaultCurrency: "USD" },
          }
        }),
      },
    },
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Database

  const services = {
    wallet,
    ledger,
    subscriptions: {} as ServiceContext["subscriptions"],
  } as unknown as Pick<ServiceContext, "subscriptions" | "wallet" | "ledger">

  return { deps: { services, db, logger: createLogger() }, wallet, ledger, db }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("activateSubscription — happy path", () => {
  it("issues credits, charges base fee, opens reservations, marks subscription active", async () => {
    const state = createState()
    const keys = customerAccountKeys(customerId)
    state.balances[keys.purchased] = 20 * DOLLAR
    state.balances[keys.granted] = 0

    const { deps } = buildDeps(state)

    const { val, err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_1",
      planIncludedCredits: [{ amount: 5 * DOLLAR, source: "plan_included" }],
      baseFeeAmount: 10 * DOLLAR,
      reservations: [
        {
          entitlementId: "ent_a",
          requestedAmount: 3 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 1 * DOLLAR,
        },
        {
          entitlementId: "ent_b",
          requestedAmount: 2 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 1 * DOLLAR,
        },
      ],
    })

    expect(err).toBeUndefined()
    expect(val?.subscriptionId).toBe(subscriptionId)
    expect(val?.grantsIssued).toHaveLength(1)
    expect(val?.baseFeeCharged).toBe(10 * DOLLAR)
    expect(val?.reservations.map((r) => r.entitlementId)).toEqual(["ent_a", "ent_b"])

    // Ordering: credits first, then base fee, then reservations.
    expect(state.walletCalls.adjust[0]).toMatchObject({
      signedAmount: 5 * DOLLAR,
      source: "plan_included",
      expiresAt: periodEndAt,
    })
    expect(state.walletCalls.transfer[0]).toMatchObject({
      amount: 10 * DOLLAR,
      fromAccountKey: keys.purchased,
      toAccountKey: keys.consumed,
    })
    expect(state.walletCalls.transfer[0]!.metadata).toMatchObject({
      kind: "subscription",
      flow: "subscription",
    })
    expect(state.walletCalls.createReservation).toHaveLength(2)

    // Subscription flipped to active.
    expect(state.subscriptionUpdates[0]).toMatchObject({
      active: true,
      status: "active",
      currentCycleStartAt: periodStartAt.getTime(),
      currentCycleEndAt: periodEndAt.getTime(),
    })
  })

  it("skips base-fee transfer when baseFeeAmount is 0", async () => {
    const state = createState()
    state.balances[customerAccountKeys(customerId).purchased] = 1 * DOLLAR
    const { deps } = buildDeps(state)

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_nofee",
      reservations: [
        {
          entitlementId: "ent_a",
          requestedAmount: 1 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 1 * DOLLAR,
        },
      ],
    })

    expect(err).toBeUndefined()
    expect(state.walletCalls.transfer).toHaveLength(0)
  })

  it("activates a plan with no metered entitlements (base fee only)", async () => {
    const state = createState()
    state.balances[customerAccountKeys(customerId).purchased] = 50 * DOLLAR
    const { deps } = buildDeps(state)

    const { val, err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_flatonly",
      baseFeeAmount: 29 * DOLLAR,
    })

    expect(err).toBeUndefined()
    expect(val?.reservations).toHaveLength(0)
    expect(state.walletCalls.createReservation).toHaveLength(0)
    expect(state.walletCalls.transfer).toHaveLength(1)
  })
})

describe("activateSubscription — zero-balance policy", () => {
  it("fails when base fee exceeds available purchased balance", async () => {
    const state = createState()
    state.balances[customerAccountKeys(customerId).purchased] = 2 * DOLLAR
    const { deps } = buildDeps(state)

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_poor",
      baseFeeAmount: 10 * DOLLAR,
    })

    expect(err).toBeDefined()
    expect(err?.message).toMatch(/base fee/i)
    // No wallet writes happened — pre-flight aborts before any side effects.
    expect(state.walletCalls.adjust).toHaveLength(0)
    expect(state.walletCalls.transfer).toHaveLength(0)
    expect(state.walletCalls.createReservation).toHaveLength(0)
    expect(state.subscriptionUpdates).toHaveLength(0)
  })

  it("fails when total reservation requested exceeds available balance + credits", async () => {
    const state = createState()
    const keys = customerAccountKeys(customerId)
    state.balances[keys.purchased] = 1 * DOLLAR
    state.balances[keys.granted] = 0
    const { deps } = buildDeps(state)

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_big_reservation",
      planIncludedCredits: [{ amount: 2 * DOLLAR, source: "plan_included" }],
      reservations: [
        {
          entitlementId: "ent_huge",
          requestedAmount: 100 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 10 * DOLLAR,
        },
      ],
    })

    expect(err).toBeDefined()
    expect(err?.message).toMatch(/reservation/i)
    expect(state.walletCalls.adjust).toHaveLength(0)
  })

  it("fails when a reservation comes back partially filled (all-or-nothing)", async () => {
    const state = createState()
    const keys = customerAccountKeys(customerId)
    // Enough to pass pre-flight, but the stub simulates a race that
    // drained the balance between preflight and reservation call.
    state.balances[keys.purchased] = 100 * DOLLAR
    const { deps } = buildDeps(state, true, {
      createReservationImpl: async (input) =>
        Ok({
          reservationId: "res_partial",
          allocationAmount: Math.floor(input.requestedAmount / 2),
          drainLegs: [],
        }),
    })

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_race",
      reservations: [
        {
          entitlementId: "ent_a",
          requestedAmount: 5 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 1 * DOLLAR,
        },
      ],
    })

    expect(err).toBeDefined()
    expect(err?.message).toMatch(/partial|insufficient/i)
    // Subscription NOT marked active after a failed reservation.
    expect(state.subscriptionUpdates).toHaveLength(0)
  })
})

describe("activateSubscription — error surfaces", () => {
  it("returns subscription-not-found when the row is missing", async () => {
    const state = createState()
    const { deps } = buildDeps(state, /* customerExists */ false)

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_missing",
    })

    expect(err?.message).toMatch(/not found/i)
  })

  it("propagates wallet-level failures from adjust()", async () => {
    const state = createState()
    state.balances[customerAccountKeys(customerId).purchased] = 100 * DOLLAR
    const { deps } = buildDeps(state, true, {
      adjustImpl: async () =>
        Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" })) as never,
    })

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_adjust_fail",
      planIncludedCredits: [{ amount: 1 * DOLLAR, source: "plan_included" }],
    })

    expect(err).toBeDefined()
    expect((err as UnPriceWalletError).message).toBe("WALLET_LEDGER_FAILED")
    // Fails fast — base fee and reservations never attempted.
    expect(state.walletCalls.transfer).toHaveLength(0)
    expect(state.walletCalls.createReservation).toHaveLength(0)
  })
})

describe("activateSubscription — idempotency keys", () => {
  it("derives deterministic idempotency keys from the activation key", async () => {
    const state = createState()
    state.balances[customerAccountKeys(customerId).purchased] = 100 * DOLLAR
    const { deps, wallet } = buildDeps(state)

    await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "run_42",
      planIncludedCredits: [
        { amount: 1 * DOLLAR, source: "plan_included" },
        { amount: 2 * DOLLAR, source: "promo" },
      ],
      baseFeeAmount: 5 * DOLLAR,
      reservations: [
        {
          entitlementId: "ent_x",
          requestedAmount: 1 * DOLLAR,
          refillThresholdBps: 2000,
          refillChunkAmount: 1 * DOLLAR,
        },
      ],
    })

    const adjustCalls = (wallet.adjust as ReturnType<typeof vi.fn>).mock.calls
    expect(adjustCalls[0]![0].idempotencyKey).toBe("activate:run_42:credit:0")
    expect(adjustCalls[1]![0].idempotencyKey).toBe("activate:run_42:credit:1")

    const transferCalls = (wallet.transfer as ReturnType<typeof vi.fn>).mock.calls
    expect(transferCalls[0]![0].idempotencyKey).toBe("activate:run_42:base_fee")

    const reserveCalls = (wallet.createReservation as ReturnType<typeof vi.fn>).mock.calls
    expect(reserveCalls[0]![0].idempotencyKey).toBe("activate:run_42:reserve:ent_x")
  })
})
