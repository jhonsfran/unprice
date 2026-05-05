import type { Database } from "@unprice/db"
import {
  entitlementReservations as entitlementReservationsTable,
  walletCredits as walletCreditsTable,
  walletTopups as walletTopupsTable,
} from "@unprice/db/schema"
import type {
  EntitlementReservation,
  WalletCredit,
  WalletCreditSource,
  WalletTopup,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LedgerGateway, LedgerTransferRequest } from "../ledger"
import { customerAccountKeys, platformAccountKey } from "../ledger"
import { WalletService } from "./service"

// ---------------------------------------------------------------------------
// Fakes — minimal in-memory stand-ins for Drizzle + LedgerGateway.
//
// Fidelity tradeoff: we do not emulate Drizzle's opaque `where`/`orderBy`
// expressions, so mutation of wallet_credits via `update(...).set(...).where(...)`
// is recorded but not applied back to `state.grants`. Tests assert on:
//   - the ordered sequence of ledger transfers (`state.transfers`)
//   - inserted rows (`state.inserts`)
//   - captured set-specs of updates (`state.updates`)
// That is enough for every scenario covered by WalletService tests.
// ---------------------------------------------------------------------------

type FakeGrant = WalletCredit
type FakeTopup = WalletTopup
type FakeReservation = EntitlementReservation

interface FakeState {
  grants: FakeGrant[]
  topups: FakeTopup[]
  reservations: FakeReservation[]
  balances: Record<string, number> // account name → minor units (scale 8)
  transfers: LedgerTransferRequest[] // every ledger call, in order
  transferBatches: number // count of `createTransfers` calls
  inserts: Array<{ table: string; values: unknown }>
  updates: Array<{ table: string; set: Record<string, unknown> }>
}

function createState(): FakeState {
  return {
    grants: [],
    topups: [],
    reservations: [],
    balances: {},
    transfers: [],
    transferBatches: 0,
    inserts: [],
    updates: [],
  }
}

function tableName(table: unknown): string {
  if (table === walletCreditsTable) return "walletCredits"
  if (table === walletTopupsTable) return "walletTopups"
  if (table === entitlementReservationsTable) return "entitlementReservations"
  return "unknown"
}

function createDb(state: FakeState): Database {
  const tx = {
    query: {
      walletCredits: {
        findFirst: vi.fn(async () => state.grants[state.grants.length - 1] ?? null),
        findMany: vi.fn(async () => {
          // emulate FIFO drain lookup: expired_at IS NULL, voided_at IS NULL,
          // remaining_amount > 0, ordered by expiresAt NULLS LAST then createdAt.
          const active = state.grants
            .filter((g) => !g.expiredAt && !g.voidedAt && g.remainingAmount > 0)
            .slice()
            .sort((a, b) => {
              const aExp = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY
              const bExp = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY
              if (aExp !== bExp) return aExp - bExp
              return a.createdAt.getTime() - b.createdAt.getTime()
            })
          return active
        }),
      },
      walletTopups: {
        findFirst: vi.fn(async () => state.topups[0] ?? null),
      },
      entitlementReservations: {
        findFirst: vi.fn(async () => state.reservations[0] ?? null),
      },
    },
    execute: vi.fn(async () => ({ rows: [] })),
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          const record = () => {
            state.inserts.push({ table: name, values })
            if (name === "walletCredits") {
              const grant = { ...(values as unknown as FakeGrant) }
              const dup = state.grants.find(
                (g) =>
                  g.customerId === grant.customerId && g.ledgerTransferId === grant.ledgerTransferId
              )
              if (dup) return { inserted: false, row: dup }
              state.grants.push(grant)
              return { inserted: true, row: grant }
            }
            if (name === "entitlementReservations") {
              state.reservations.push({
                ...(values as unknown as FakeReservation),
              })
            }
            return { inserted: true, row: values as unknown as FakeGrant }
          }

          // Drizzle's insert query builder is itself a PromiseLike: callers
          // can either `await db.insert(t).values(v)` directly or chain
          // `.onConflictDoNothing().returning()`. The mock supports both, and
          // `record()` is invoked exactly once on whichever terminal path the
          // caller takes (we do not eagerly resolve).
          type FakeInsertOutcome = { inserted: boolean; row: FakeGrant | FakeReservation }
          type FakeInsertChain = {
            onConflictDoNothing: () => { returning: () => Promise<{ id: string }[]> }
            then: (
              resolve: (value: FakeInsertOutcome) => void,
              reject: (reason: unknown) => void
            ) => void
          }
          const thenable: FakeInsertChain = {
            onConflictDoNothing: () => ({
              returning: vi.fn(async () => {
                const result = record()
                return result.inserted ? [{ id: (result.row as FakeGrant).id }] : []
              }),
            }),
            // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are PromiseLike — `await tx.insert(...).values(...)` requires a `then`, so the mock must implement the thenable protocol exactly as the real builder does.
            then: (resolve, reject) => {
              try {
                resolve(record())
              } catch (e) {
                reject(e)
              }
            },
          }
          return thenable
        }),
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      return {
        set(setSpec: Record<string, unknown>) {
          return {
            where: vi.fn(async () => {
              state.updates.push({ table: name, set: setSpec })
            }),
          }
        },
      }
    },
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  }
  // the service uses this.db for the read-only paths (getWalletState); both
  // this.db and tx share the same stateful object.
  return tx as unknown as Database
}

function createLedger(state: FakeState): LedgerGateway {
  let transferIdSeq = 0
  const nextId = () => `pgle_${++transferIdSeq}`
  const idempotencyCache = new Map<string, ReturnType<typeof makeTransfer>>()
  const makeTransfer = (req: LedgerTransferRequest, id: string) => ({
    id,
    fromAccountId: `acct_from_${req.fromAccount}`,
    toAccountId: `acct_to_${req.toAccount}`,
    amount: req.amount,
    currency: "USD" as const,
    metadata: req.metadata ?? null,
    createdAt: new Date(),
    eventAt: req.eventAt ?? new Date(),
  })

  const apply = (req: LedgerTransferRequest) => {
    const minor = toLedgerMinor(req.amount)
    state.balances[req.fromAccount] = (state.balances[req.fromAccount] ?? 0) - minor
    state.balances[req.toAccount] = (state.balances[req.toAccount] ?? 0) + minor
  }

  const idempotencyKey = (req: LedgerTransferRequest) =>
    `${req.projectId}|${req.source.type}|${req.source.id}`

  return {
    createTransfer: vi.fn(async (req: LedgerTransferRequest) => {
      const key = idempotencyKey(req)
      const existing = idempotencyCache.get(key)
      if (existing) return Ok(existing)
      state.transfers.push(req)
      apply(req)
      const transfer = makeTransfer(req, nextId())
      idempotencyCache.set(key, transfer)
      return Ok(transfer)
    }),
    createTransfers: vi.fn(async (reqs: LedgerTransferRequest[]) => {
      state.transferBatches += 1
      const out: ReturnType<typeof makeTransfer>[] = []
      for (const req of reqs) {
        const key = idempotencyKey(req)
        const existing = idempotencyCache.get(key)
        if (existing) {
          out.push(existing)
          continue
        }
        state.transfers.push(req)
        apply(req)
        const transfer = makeTransfer(req, nextId())
        idempotencyCache.set(key, transfer)
        out.push(transfer)
      }
      return Ok(out)
    }),
    getAccountBalanceIn: vi.fn(async (name: string) => {
      const minor = state.balances[name] ?? 0
      return Ok(fromLedgerMinor(minor, "USD"))
    }),
    seedPlatformAccounts: vi.fn(async () => Ok(undefined)),
    ensureCustomerAccounts: vi.fn(async () => Ok(undefined)),
  } as unknown as LedgerGateway
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

function buildService() {
  const state = createState()
  const db = createDb(state)
  const ledger = createLedger(state)
  const wallet = new WalletService({ db, ledgerGateway: ledger, logger: createLogger() })
  return { state, db, ledger, wallet }
}

function seedGrant(
  state: FakeState,
  overrides: Partial<FakeGrant> & {
    id: string
    customerId: string
    projectId: string
  }
): FakeGrant {
  const grant: FakeGrant = {
    source: "promo",
    issuedAmount: 0,
    remainingAmount: 0,
    expiresAt: null,
    expiredAt: null,
    voidedAt: null,
    ledgerTransferId: `pgle_seed_${overrides.id}`,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as FakeGrant
  state.grants.push(grant)
  return grant
}

function seedReservation(
  state: FakeState,
  overrides: Partial<FakeReservation> & {
    id: string
    customerId: string
    projectId: string
    entitlementId: string
  }
): FakeReservation {
  const reservation: FakeReservation = {
    allocationAmount: 0,
    consumedAmount: 0,
    drainLegs: [],
    refillThresholdBps: 2000,
    refillChunkAmount: 0,
    periodStartAt: new Date("2026-01-01T00:00:00Z"),
    periodEndAt: new Date("2026-02-01T00:00:00Z"),
    reconciledAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as FakeReservation
  state.reservations.push(reservation)
  return reservation
}

const DOLLAR = 100_000_000

let idSeq = 0
vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    newId: vi.fn((prefix: string) => `${prefix}_${++idSeq}`),
  }
})

beforeEach(() => {
  idSeq = 0
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WalletService.ensureCustomerAccounts", () => {
  it("seeds project funding accounts before the customer wallet bundle", async () => {
    const { ledger, wallet } = buildService()

    const { err } = await wallet.ensureCustomerAccounts({
      projectId: "prj_abc",
      customerId: "cus_abc",
      currency: "USD",
    })

    expect(err).toBeUndefined()
    expect(ledger.seedPlatformAccounts).toHaveBeenCalledWith("prj_abc", "USD", undefined)
    expect(ledger.ensureCustomerAccounts).toHaveBeenCalledWith("cus_abc", "USD", undefined)
  })
})

describe("WalletService.createReservation", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("drains available.granted FIFO before touching available.purchased", async () => {
    const { state, wallet } = buildService()
    state.balances[keys.purchased] = 5 * DOLLAR
    seedGrant(state, {
      id: "wcr_old",
      customerId,
      projectId,
      source: "promo",
      issuedAmount: 3 * DOLLAR,
      remainingAmount: 3 * DOLLAR,
      expiresAt: new Date("2026-03-01"),
      createdAt: new Date("2026-01-01"),
    })
    seedGrant(state, {
      id: "wcr_new",
      customerId,
      projectId,
      source: "promo",
      issuedAmount: 2 * DOLLAR,
      remainingAmount: 2 * DOLLAR,
      expiresAt: new Date("2026-04-01"),
      createdAt: new Date("2026-01-15"),
    })

    const { val, err } = await wallet.createReservation({
      projectId,
      customerId,
      currency: "USD",
      entitlementId: "ent_1",
      requestedAmount: 7 * DOLLAR,
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      idempotencyKey: "reserve:1",
    })

    expect(err).toBeUndefined()
    expect(val?.allocationAmount).toBe(7 * DOLLAR)

    // Two ledger legs: one combined granted (summed across drained grants),
    // one purchased covering the remainder. Per-grant attribution lives in
    // `drainLegs`, not in separate transfers.
    expect(state.transfers).toHaveLength(2)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.granted,
      toAccount: keys.reserved,
    })
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(5 * DOLLAR)
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.purchased,
      toAccount: keys.reserved,
    })
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(2 * DOLLAR)

    // drainLegs attribution: granted before purchased, preserving grant ids.
    expect(val?.drainLegs).toEqual([
      { source: "granted", amount: 3 * DOLLAR, grantId: "wcr_old", grantSource: "promo" },
      { source: "granted", amount: 2 * DOLLAR, grantId: "wcr_new", grantSource: "promo" },
      { source: "purchased", amount: 2 * DOLLAR },
    ])
  })

  it("drains soonest-expiring grant first (FIFO by expiry)", async () => {
    const { state, wallet } = buildService()
    // Seed in "wrong" order; findMany sorts by expiresAt ascending.
    seedGrant(state, {
      id: "wcr_far",
      customerId,
      projectId,
      issuedAmount: 1 * DOLLAR,
      remainingAmount: 1 * DOLLAR,
      expiresAt: new Date("2026-12-01"),
      createdAt: new Date("2026-01-01"),
    })
    seedGrant(state, {
      id: "wcr_soon",
      customerId,
      projectId,
      issuedAmount: 1 * DOLLAR,
      remainingAmount: 1 * DOLLAR,
      expiresAt: new Date("2026-02-01"),
      createdAt: new Date("2026-01-10"),
    })

    const { val } = await wallet.createReservation({
      projectId,
      customerId,
      currency: "USD",
      entitlementId: "ent_1",
      requestedAmount: 2 * DOLLAR,
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      idempotencyKey: "reserve:fifo",
    })

    expect(val?.drainLegs.map((l) => l.grantId)).toEqual(["wcr_soon", "wcr_far"])
  })

  it("skips grants with remaining_amount = 0 and returns partial fulfillment", async () => {
    const { state, wallet } = buildService()
    // Partially-consumed grant still active, but only 1 DOLLAR remains.
    seedGrant(state, {
      id: "wcr_partial",
      customerId,
      projectId,
      issuedAmount: 5 * DOLLAR,
      remainingAmount: 1 * DOLLAR,
      expiresAt: new Date("2026-06-01"),
      createdAt: new Date("2026-01-01"),
    })
    // Drained grant — findMany must skip it.
    seedGrant(state, {
      id: "wcr_empty",
      customerId,
      projectId,
      issuedAmount: 5 * DOLLAR,
      remainingAmount: 0,
      expiresAt: new Date("2026-03-01"),
      createdAt: new Date("2026-01-02"),
    })
    // No purchased balance.

    const { val, err } = await wallet.createReservation({
      projectId,
      customerId,
      currency: "USD",
      entitlementId: "ent_1",
      requestedAmount: 10 * DOLLAR,
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      idempotencyKey: "reserve:partial",
    })

    expect(err).toBeUndefined()
    // Only 1 DOLLAR was available; allocation equals what was actually drained.
    expect(val?.allocationAmount).toBe(1 * DOLLAR)
    expect(state.transfers).toHaveLength(1)
    expect(state.transfers[0]!.fromAccount).toBe(keys.granted)
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(1 * DOLLAR)
    // zero drained from purchased → no purchased transfer leg emitted.
  })

  it("decrements wallet_credits.remaining_amount for each drained grant", async () => {
    const { state, wallet } = buildService()
    seedGrant(state, {
      id: "wcr_a",
      customerId,
      projectId,
      issuedAmount: 3 * DOLLAR,
      remainingAmount: 3 * DOLLAR,
      expiresAt: new Date("2026-02-01"),
      createdAt: new Date("2026-01-01"),
    })
    seedGrant(state, {
      id: "wcr_b",
      customerId,
      projectId,
      issuedAmount: 3 * DOLLAR,
      remainingAmount: 3 * DOLLAR,
      expiresAt: new Date("2026-03-01"),
      createdAt: new Date("2026-01-02"),
    })

    await wallet.createReservation({
      projectId,
      customerId,
      currency: "USD",
      entitlementId: "ent_1",
      requestedAmount: 4 * DOLLAR,
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      idempotencyKey: "reserve:decrement",
    })

    const grantUpdates = state.updates.filter((u) => u.table === "walletCredits")
    // First grant fully drained (3 -> 0); second partially drained (3 -> 2).
    expect(grantUpdates).toHaveLength(2)
    expect(grantUpdates[0]!.set).toEqual({ remainingAmount: 0 })
    expect(grantUpdates[1]!.set).toEqual({ remainingAmount: 2 * DOLLAR })
  })
})

describe("WalletService.flushReservation", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("mid-period: flushes consumed then refills with multi-leg drain", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_1",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 5 * DOLLAR,
      consumedAmount: 0,
    })
    state.balances[keys.reserved] = 5 * DOLLAR // pre-existing allocation
    state.balances[keys.purchased] = 10 * DOLLAR
    seedGrant(state, {
      id: "wcr_1",
      customerId,
      projectId,
      issuedAmount: 1 * DOLLAR,
      remainingAmount: 1 * DOLLAR,
      expiresAt: new Date("2026-06-01"),
    })

    const { val, err } = await wallet.flushReservation({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_1",
      flushSeq: 1,
      flushAmount: 2 * DOLLAR,
      refillChunkAmount: 3 * DOLLAR,
      statementKey: "stmt_1",
      final: false,
    })

    expect(err).toBeUndefined()
    expect(val).toMatchObject({
      flushedAmount: 2 * DOLLAR,
      grantedAmount: 3 * DOLLAR, // 1 from granted + 2 from purchased
      refundedAmount: 0,
    })

    // One batched call with 3 legs: flush + granted refill + purchased refill.
    expect(state.transferBatches).toBe(1)
    expect(state.transfers).toHaveLength(3)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.consumed,
    })
    expect(state.transfers[0]?.statementKey).toBeUndefined()
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.granted,
      toAccount: keys.reserved,
    })
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(1 * DOLLAR)
    expect(state.transfers[2]).toMatchObject({
      fromAccount: keys.purchased,
      toAccount: keys.reserved,
    })
    expect(toLedgerMinor(state.transfers[2]!.amount)).toBe(2 * DOLLAR)

    // Reservation row reflects both flush and refill.
    const resUpdate = state.updates.find((u) => u.table === "entitlementReservations")
    expect(resUpdate?.set).toMatchObject({
      consumedAmount: 2 * DOLLAR,
      allocationAmount: 5 * DOLLAR + 3 * DOLLAR,
    })
    expect(resUpdate?.set).not.toHaveProperty("reconciledAt")
  })

  it("final flush: flushes consumed, refunds purchased, and releases unused credits", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_2",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 2 * DOLLAR,
      drainLegs: [
        { source: "granted", amount: 4 * DOLLAR, grantSource: "promo", grantId: "wcr_1" },
        { source: "purchased", amount: 6 * DOLLAR },
      ],
    })
    state.balances[keys.reserved] = 10 * DOLLAR

    const { val, err } = await wallet.flushReservation({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_2",
      flushSeq: 2,
      flushAmount: 1 * DOLLAR, // the unflushed delta
      refillChunkAmount: 0,
      statementKey: "stmt_2",
      final: true,
    })

    expect(err).toBeUndefined()
    expect(val).toMatchObject({
      flushedAmount: 1 * DOLLAR,
      grantedAmount: 0,
      refundedAmount: 6 * DOLLAR,
    })

    // Flush leg + purchased refund + granted release, one batch.
    expect(state.transferBatches).toBe(1)
    expect(state.transfers).toHaveLength(3)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.consumed,
    })
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.purchased,
    })
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(6 * DOLLAR)
    expect(state.transfers[2]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: platformAccountKey("promo", projectId),
    })
    expect(toLedgerMinor(state.transfers[2]!.amount)).toBe(1 * DOLLAR)

    // reconciledAt is stamped on the final flush.
    const resUpdate = state.updates.find((u) => u.table === "entitlementReservations")
    expect(resUpdate?.set).toHaveProperty("reconciledAt")
  })

  it("rejects flushing an already-reconciled reservation", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_done",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 1 * DOLLAR,
      consumedAmount: 1 * DOLLAR,
      reconciledAt: new Date("2026-02-01"),
    })

    const { err } = await wallet.flushReservation({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_done",
      flushSeq: 5,
      flushAmount: 0,
      refillChunkAmount: 0,
      statementKey: "stmt_done",
      final: true,
    })

    expect(err?.message).toBe("WALLET_RESERVATION_ALREADY_RECONCILED")
    expect(state.transfers).toHaveLength(0)
  })
})

describe("WalletService.adjust", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("positive with expiresAt: credits available.granted and creates wallet_credits row", async () => {
    const { state, wallet } = buildService()

    const { val, err } = await wallet.adjust({
      projectId,
      customerId,
      currency: "USD",
      signedAmount: 5 * DOLLAR,
      actorId: "admin_1",
      reason: "welcome credit",
      source: "promo",
      idempotencyKey: "adjust:1",
      expiresAt: new Date("2026-06-01"),
    })

    expect(err).toBeUndefined()
    expect(val?.grantId).toBeDefined()
    expect(state.transfers).toHaveLength(1)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: platformAccountKey("promo", projectId),
      toAccount: keys.granted,
    })
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(5 * DOLLAR)

    const grantInsert = state.inserts.find((i) => i.table === "walletCredits")
    expect(grantInsert?.values).toMatchObject({
      source: "promo",
      issuedAmount: 5 * DOLLAR,
      remainingAmount: 5 * DOLLAR,
    })
  })

  it("positive with source='purchased': credits available.purchased and creates NO wallet_credits row", async () => {
    const { state, wallet } = buildService()

    const { val, err } = await wallet.adjust({
      projectId,
      customerId,
      currency: "USD",
      signedAmount: 2 * DOLLAR,
      actorId: "admin_1",
      reason: "manual top-up",
      source: "purchased",
      idempotencyKey: "adjust:2",
    })

    expect(err).toBeUndefined()
    expect(val?.grantId).toBeUndefined()
    expect(state.transfers[0]).toMatchObject({
      fromAccount: platformAccountKey("manual", projectId),
      toAccount: keys.purchased,
    })
    expect(state.inserts.find((i) => i.table === "walletCredits")).toBeUndefined()
  })

  it("replay with same idempotencyKey reuses the existing wallet_credits row", async () => {
    const { state, wallet } = buildService()

    const first = await wallet.adjust({
      projectId,
      customerId,
      currency: "USD",
      signedAmount: 5 * DOLLAR,
      actorId: "system:subscription-activation",
      reason: "Plan activation grant (credit_line)",
      source: "credit_line",
      idempotencyKey: "activate:cycle:sub_1:2026-04-25T00:00:00.000Z:grant:0",
      expiresAt: new Date("2026-05-25"),
    })
    expect(first.err).toBeUndefined()
    expect(first.val?.grantId).toBeDefined()

    const second = await wallet.adjust({
      projectId,
      customerId,
      currency: "USD",
      signedAmount: 5 * DOLLAR,
      actorId: "system:subscription-activation",
      reason: "Plan activation grant (credit_line)",
      source: "credit_line",
      idempotencyKey: "activate:cycle:sub_1:2026-04-25T00:00:00.000Z:grant:0",
      expiresAt: new Date("2026-05-25"),
    })

    expect(second.err).toBeUndefined()
    expect(second.val?.grantId).toBe(first.val?.grantId)
    // exactly one ledger transfer + one wallet_credits row across both calls
    expect(state.transfers).toHaveLength(1)
    expect(state.grants).toHaveLength(1)
  })

  it("plan_included grant drains the plan_credit platform source", async () => {
    const { state, wallet } = buildService()

    await wallet.adjust({
      projectId,
      customerId,
      currency: "USD",
      signedAmount: 10 * DOLLAR,
      actorId: "system",
      reason: "plan activation",
      source: "plan_included",
      idempotencyKey: "adjust:plan",
      expiresAt: new Date("2026-02-01"),
    })

    expect(state.transfers[0]).toMatchObject({
      fromAccount: platformAccountKey("plan_credit", projectId),
      toAccount: keys.granted,
    })
    const grantInsert = state.inserts.find((i) => i.table === "walletCredits")
    expect(grantInsert?.values).toMatchObject({ source: "plan_included" })
  })
})

describe("WalletService.settleTopUp", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("credits available.purchased from platform.funding.topup and marks topup completed", async () => {
    const { state, wallet } = buildService()
    state.topups.push({
      id: "top_1",
      projectId,
      customerId,
      provider: "stripe",
      providerSessionId: "sess_1",
      requestedAmount: 10 * DOLLAR,
      currency: "USD",
      status: "pending",
      settledAmount: null,
      ledgerTransferId: null,
      completedAt: null,
      createdAt: new Date(),
    } as unknown as FakeTopup)

    const { val, err } = await wallet.settleTopUp({
      projectId,
      customerId,
      currency: "USD",
      providerSessionId: "sess_1",
      paidAmount: 10 * DOLLAR,
      idempotencyKey: "webhook_evt_1",
    })

    expect(err).toBeUndefined()
    expect(val?.topupId).toBe("top_1")
    expect(state.transfers[0]).toMatchObject({
      fromAccount: platformAccountKey("topup", projectId),
      toAccount: keys.purchased,
    })

    const topupUpdate = state.updates.find((u) => u.table === "walletTopups")
    expect(topupUpdate?.set).toMatchObject({
      status: "completed",
      settledAmount: 10 * DOLLAR,
    })
  })

  it("is idempotent on replay: second call with same session returns prior ledger id without a new transfer", async () => {
    const { state, wallet } = buildService()
    state.topups.push({
      id: "top_2",
      projectId,
      customerId,
      provider: "stripe",
      providerSessionId: "sess_2",
      requestedAmount: 5 * DOLLAR,
      currency: "USD",
      status: "completed",
      settledAmount: 5 * DOLLAR,
      ledgerTransferId: "pgle_prior",
      completedAt: new Date("2026-01-10"),
      createdAt: new Date("2026-01-10"),
    } as unknown as FakeTopup)

    const { val, err } = await wallet.settleTopUp({
      projectId,
      customerId,
      currency: "USD",
      providerSessionId: "sess_2",
      paidAmount: 5 * DOLLAR,
      idempotencyKey: "webhook_evt_2",
    })

    expect(err).toBeUndefined()
    expect(val?.ledgerTransferId).toBe("pgle_prior")
    expect(state.transfers).toHaveLength(0)
  })

  it("rejects an unknown provider session", async () => {
    const { state, wallet } = buildService()

    const { err } = await wallet.settleTopUp({
      projectId,
      customerId,
      currency: "USD",
      providerSessionId: "sess_missing",
      paidAmount: 1 * DOLLAR,
      idempotencyKey: "webhook_evt_missing",
    })

    expect(err?.message).toBe("WALLET_TOPUP_NOT_FOUND")
    expect(state.transfers).toHaveLength(0)
  })
})

describe("WalletService.expireGrant", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("claws back remaining from available.granted to the matching platform source", async () => {
    const { state, wallet } = buildService()
    const tx = { execute: vi.fn(async () => ({ rows: [] })) }

    const { err } = await wallet.expireGrant(tx as never, {
      projectId,
      customerId,
      currency: "USD",
      grantId: "wcr_expire",
      amount: 3 * DOLLAR,
      source: "promo" as WalletCreditSource,
      idempotencyKey: "expire:wcr_expire",
    })

    expect(err).toBeUndefined()
    expect(state.transfers).toHaveLength(1)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.granted,
      toAccount: platformAccountKey("promo", projectId),
    })
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(3 * DOLLAR)
    expect(state.transfers[0]!.metadata).toMatchObject({
      flow: "expire",
      grant_id: "wcr_expire",
      source: "promo",
    })
  })

  it("plan_included grant clawback returns to platform.funding.plan_credit", async () => {
    const { state, wallet } = buildService()
    const tx = { execute: vi.fn(async () => ({ rows: [] })) }

    await wallet.expireGrant(tx as never, {
      projectId,
      customerId,
      currency: "USD",
      grantId: "wcr_plan",
      amount: 1 * DOLLAR,
      source: "plan_included" as WalletCreditSource,
      idempotencyKey: "expire:wcr_plan",
    })

    expect(state.transfers[0]).toMatchObject({
      toAccount: platformAccountKey("plan_credit", projectId),
    })
  })
})

describe("WalletService.getWalletState", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"
  const keys = customerAccountKeys(customerId)

  it("returns the four sub-account balances and active credits ordered by expiry", async () => {
    const { state, wallet } = buildService()
    state.balances[keys.purchased] = 10 * DOLLAR
    state.balances[keys.granted] = 4 * DOLLAR
    state.balances[keys.reserved] = 1 * DOLLAR
    state.balances[keys.consumed] = 25 * DOLLAR

    seedGrant(state, {
      id: "wcr_far",
      customerId,
      projectId,
      issuedAmount: 3 * DOLLAR,
      remainingAmount: 3 * DOLLAR,
      expiresAt: new Date("2026-12-01"),
    })
    seedGrant(state, {
      id: "wcr_soon",
      customerId,
      projectId,
      issuedAmount: 2 * DOLLAR,
      remainingAmount: 1 * DOLLAR,
      expiresAt: new Date("2026-02-01"),
    })
    // Inactive — must NOT appear in the result.
    seedGrant(state, {
      id: "wcr_expired",
      customerId,
      projectId,
      issuedAmount: 1 * DOLLAR,
      remainingAmount: 0,
      expiredAt: new Date("2025-12-31"),
    })

    const { val, err } = await wallet.getWalletState({ projectId, customerId })

    expect(err).toBeUndefined()
    expect(val?.balances).toEqual({
      purchased: 10 * DOLLAR,
      granted: 4 * DOLLAR,
      reserved: 1 * DOLLAR,
      consumed: 25 * DOLLAR,
    })
    expect(val?.credits.map((g) => g.id)).toEqual(["wcr_soon", "wcr_far"])
  })

  it("returns zeros and empty credits for an untouched customer", async () => {
    const { wallet } = buildService()

    const { val, err } = await wallet.getWalletState({
      projectId: "prj_empty",
      customerId: "cus_empty",
    })

    expect(err).toBeUndefined()
    expect(val?.balances).toEqual({
      purchased: 0,
      granted: 0,
      reserved: 0,
      consumed: 0,
    })
    expect(val?.credits).toEqual([])
  })
})
