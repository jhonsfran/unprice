import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ServiceContext } from "../../context"
import type { LedgerGateway } from "../../ledger"
import { UnPriceWalletError, type WalletService } from "../../wallet"
import { activateSubscription } from "./activate"

// ---------------------------------------------------------------------------
// Phase 7 activation is grants-only:
//   - Issues additive `wallet_grants` rows (plan_included / trial / credit_line / promo / manual)
//   - Flips the subscription to `active`
//
// Reservations are owned by the EntitlementWindowDO (lazy on first priced
// event). Base fees settle through the invoicing flow at period boundaries.
// Both are out of scope for these tests.
// ---------------------------------------------------------------------------

const DOLLAR = 100_000_000
const customerId = "cus_abc"
const projectId = "prj_abc"
const subscriptionId = "sub_123"
const periodStartAt = new Date("2026-02-01T00:00:00Z")
const periodEndAt = new Date("2026-03-01T00:00:00Z")

interface FakeState {
  walletCalls: {
    adjust: Array<{ signedAmount: number; source: string; expiresAt?: Date }>
  }
  subscriptionUpdates: Array<Record<string, unknown>>
}

function createState(): FakeState {
  return {
    walletCalls: { adjust: [] },
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
  adjustImpl?: (input: unknown) => Promise<{
    val: { grantId?: string; clampedAmount: number; unclampedRemainder: number }
    err?: UnPriceWalletError
  }>
}

function buildDeps(state: FakeState, customerExists = true, stubs: WalletStubs = {}) {
  const wallet = {
    adjust: vi.fn(async (input: { signedAmount: number; source: string; expiresAt?: Date }) => {
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
  } as unknown as WalletService

  // ledger.getAccountBalance is no longer called by activation — the
  // pre-flight reservation check moved out with the reservation logic. Keep a
  // stub here so the deps shape compiles, but it should never be invoked.
  const ledger = {
    getAccountBalance: vi.fn(),
  } as unknown as LedgerGateway

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
  it("issues each grant in order and flips the subscription to active", async () => {
    const state = createState()
    const { deps } = buildDeps(state)

    const { val, err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_1",
      grants: [
        { amount: 5 * DOLLAR, source: "plan_included" },
        { amount: 50 * DOLLAR, source: "credit_line", reason: "Period credit line" },
      ],
    })

    expect(err).toBeUndefined()
    expect(val?.subscriptionId).toBe(subscriptionId)
    expect(val?.grantsIssued).toHaveLength(2)
    expect(val?.grantsIssued.map((g) => g.source)).toEqual(["plan_included", "credit_line"])

    expect(state.walletCalls.adjust[0]).toMatchObject({
      signedAmount: 5 * DOLLAR,
      source: "plan_included",
      expiresAt: periodEndAt,
    })
    expect(state.walletCalls.adjust[1]).toMatchObject({
      signedAmount: 50 * DOLLAR,
      source: "credit_line",
      expiresAt: periodEndAt,
    })

    expect(state.subscriptionUpdates[0]).toMatchObject({
      active: true,
      status: "active",
      currentCycleStartAt: periodStartAt.getTime(),
      currentCycleEndAt: periodEndAt.getTime(),
    })
  })

  it("activates a subscription with no grants (empty list still flips status)", async () => {
    const state = createState()
    const { deps } = buildDeps(state)

    const { val, err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_empty",
    })

    expect(err).toBeUndefined()
    expect(val?.grantsIssued).toHaveLength(0)
    expect(state.walletCalls.adjust).toHaveLength(0)
    // Status flip happens regardless of whether any grants were issued.
    expect(state.subscriptionUpdates[0]).toMatchObject({ active: true, status: "active" })
  })

  it("filters out grants with zero amount before issuing", async () => {
    const state = createState()
    const { deps } = buildDeps(state)

    const { err } = await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "act_zero",
      grants: [
        { amount: 0, source: "credit_line" },
        { amount: 1 * DOLLAR, source: "plan_included" },
      ],
    })

    expect(err).toBeUndefined()
    // Only the non-zero grant is issued; the zero entry is dropped silently.
    expect(state.walletCalls.adjust).toHaveLength(1)
    expect(state.walletCalls.adjust[0]).toMatchObject({ signedAmount: 1 * DOLLAR })
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
    expect(state.walletCalls.adjust).toHaveLength(0)
  })

  it("aborts the activation tx when adjust() fails — no status flip, no further grants", async () => {
    const state = createState()
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
      grants: [
        { amount: 1 * DOLLAR, source: "plan_included" },
        { amount: 2 * DOLLAR, source: "credit_line" },
      ],
    })

    expect(err).toBeDefined()
    expect((err as UnPriceWalletError).message).toBe("WALLET_LEDGER_FAILED")
    // First adjust threw — the loop bails before the second grant or the
    // status flip.
    expect(state.walletCalls.adjust).toHaveLength(1)
    expect(state.subscriptionUpdates).toHaveLength(0)
  })
})

describe("activateSubscription — idempotency keys", () => {
  it("derives deterministic per-grant idempotency keys from the activation key", async () => {
    const state = createState()
    const { deps, wallet } = buildDeps(state)

    await activateSubscription(deps, {
      subscriptionId,
      projectId,
      periodStartAt,
      periodEndAt,
      idempotencyKey: "run_42",
      grants: [
        { amount: 1 * DOLLAR, source: "plan_included" },
        { amount: 2 * DOLLAR, source: "credit_line" },
      ],
    })

    const adjustCalls = (wallet.adjust as ReturnType<typeof vi.fn>).mock.calls
    expect(adjustCalls[0]![0].idempotencyKey).toBe("activate:run_42:grant:0")
    expect(adjustCalls[1]![0].idempotencyKey).toBe("activate:run_42:grant:1")
  })
})
