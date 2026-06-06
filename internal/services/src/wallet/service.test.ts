import type { Database } from "@unprice/db"
import {
  entitlementReservationFundingLegs as entitlementReservationFundingLegsTable,
  entitlementReservations as entitlementReservationsTable,
  walletCommandIdempotency as walletCommandIdempotencyTable,
  walletCredits as walletCreditsTable,
  walletTopups as walletTopupsTable,
} from "@unprice/db/schema"
import type {
  EntitlementReservation,
  EntitlementReservationFundingLeg,
  WalletCredit,
  WalletCreditSource,
  WalletTopup,
} from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  type LedgerGateway,
  type LedgerTransferRequest,
  UnPriceLedgerError,
  customerAccountKeys,
  platformAccountKey,
} from "../ledger"
import { flushReservationForTest } from "../tests/wallet-scenarios/helpers"
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
type FakeFundingLeg = EntitlementReservationFundingLeg
type SeedFundingAllocation = {
  source: "granted" | "purchased"
  amount: number
  walletCreditId?: string
  grantSource?: WalletCreditSource
}

interface FakeState {
  grants: FakeGrant[]
  topups: FakeTopup[]
  reservations: FakeReservation[]
  fundingLegs: FakeFundingLeg[]
  walletCommands: Array<{
    projectId: string
    idempotencyKey: string
    command: string
    payloadHash: string
    result: Record<string, unknown>
  }>
  replayWalletCommands: boolean
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
    fundingLegs: [],
    walletCommands: [],
    replayWalletCommands: false,
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
  if (table === entitlementReservationFundingLegsTable) return "entitlementReservationFundingLegs"
  if (table === walletCommandIdempotencyTable) return "walletCommandIdempotency"
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
      entitlementReservationFundingLegs: {
        findMany: vi.fn(async () =>
          state.fundingLegs.slice().sort((a, b) => a.sequence - b.sequence)
        ),
      },
      walletCommandIdempotency: {
        findFirst: vi.fn(async () =>
          state.replayWalletCommands ? (state.walletCommands[0] ?? null) : null
        ),
      },
    },
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    })),
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values: vi.fn((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
          const rows = Array.isArray(values) ? values : [values]
          const record = () => {
            let row: FakeGrant | FakeReservation | FakeFundingLeg | Record<string, unknown> =
              rows[0] ?? {}
            let inserted = true
            for (const value of rows) {
              state.inserts.push({ table: name, values: value })
              if (name === "walletCredits") {
                const grant = { ...(value as unknown as FakeGrant) }
                const dup = state.grants.find(
                  (g) =>
                    g.customerId === grant.customerId &&
                    g.ledgerTransferId === grant.ledgerTransferId
                )
                if (dup) {
                  inserted = false
                  row = dup
                  continue
                }
                state.grants.push(grant)
                row = grant
                continue
              }
              if (name === "entitlementReservations") {
                const reservation = { ...(value as unknown as FakeReservation) }
                state.reservations.push(reservation)
                row = reservation
                continue
              }
              if (name === "entitlementReservationFundingLegs") {
                const leg = { ...(value as unknown as FakeFundingLeg) }
                state.fundingLegs.push(leg)
                row = leg
                continue
              }
              if (name === "walletCommandIdempotency") {
                state.walletCommands.push(value as unknown as FakeState["walletCommands"][number])
                row = value
              }
            }
            return { inserted, row }
          }

          // Drizzle's insert query builder is itself a PromiseLike: callers
          // can either `await db.insert(t).values(v)` directly or chain
          // `.onConflictDoNothing().returning()`. The mock supports both, and
          // `record()` is invoked exactly once on whichever terminal path the
          // caller takes (we do not eagerly resolve).
          type FakeInsertOutcome = { inserted: boolean; row: unknown }
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
              if (name === "entitlementReservations" && state.reservations[0]) {
                Object.assign(state.reservations[0], setSpec)
              }
              if (name === "entitlementReservationFundingLegs") {
                const leg = state.fundingLegs.find((candidate) => {
                  if (typeof setSpec.capturedAmount === "number") {
                    return (
                      candidate.capturedAmount < setSpec.capturedAmount &&
                      candidate.allocatedAmount >= setSpec.capturedAmount
                    )
                  }
                  if (typeof setSpec.releasedAmount === "number") {
                    const stillReserved =
                      candidate.allocatedAmount -
                      candidate.capturedAmount -
                      candidate.releasedAmount
                    return candidate.releasedAmount < setSpec.releasedAmount && stillReserved > 0
                  }
                  return false
                })
                if (leg) Object.assign(leg, setSpec)
              }
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
  const idempotencyCache = new Map<
    string,
    { request: LedgerTransferRequest; transfer: ReturnType<typeof makeTransfer> }
  >()

  const apply = (req: LedgerTransferRequest) => {
    const minor = toLedgerMinor(req.amount)
    state.balances[req.fromAccount] = (state.balances[req.fromAccount] ?? 0) - minor
    state.balances[req.toAccount] = (state.balances[req.toAccount] ?? 0) + minor
  }

  const idempotencyKey = (req: LedgerTransferRequest) =>
    `${req.projectId}|${req.source.type}|${req.source.id}`

  const hasReplayConflict = (
    request: LedgerTransferRequest,
    existing: LedgerTransferRequest
  ): boolean =>
    request.fromAccount !== existing.fromAccount ||
    request.toAccount !== existing.toAccount ||
    toLedgerMinor(request.amount) !== toLedgerMinor(existing.amount) ||
    (request.statementKey ?? null) !== (existing.statementKey ?? null)

  const idempotencyConflict = (req: LedgerTransferRequest) =>
    Err(
      new UnPriceLedgerError({
        message: "LEDGER_IDEMPOTENCY_CONFLICT",
        context: {
          sourceType: req.source.type,
          sourceId: req.source.id,
        },
      })
    )

  return {
    createTransfer: vi.fn(async (req: LedgerTransferRequest) => {
      const key = idempotencyKey(req)
      const existing = idempotencyCache.get(key)
      if (existing) {
        if (hasReplayConflict(req, existing.request)) return idempotencyConflict(req)
        return Ok(existing.transfer)
      }
      state.transfers.push(req)
      apply(req)
      const transfer = makeTransfer(req, nextId())
      idempotencyCache.set(key, { request: req, transfer })
      return Ok(transfer)
    }),
    createTransfers: vi.fn(async (reqs: LedgerTransferRequest[]) => {
      state.transferBatches += 1
      const out: ReturnType<typeof makeTransfer>[] = []
      for (const req of reqs) {
        const key = idempotencyKey(req)
        const existing = idempotencyCache.get(key)
        if (existing) {
          if (hasReplayConflict(req, existing.request)) return idempotencyConflict(req)
          out.push(existing.transfer)
          continue
        }
        state.transfers.push(req)
        apply(req)
        const transfer = makeTransfer(req, nextId())
        idempotencyCache.set(key, { request: req, transfer })
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
    fundingAllocations?: SeedFundingAllocation[]
  }
): FakeReservation {
  const { fundingAllocations, ...reservationOverrides } = overrides
  const reservation: FakeReservation = {
    allocationAmount: 0,
    consumedAmount: 0,
    refillThresholdBps: 2000,
    refillChunkAmount: 0,
    periodStartAt: new Date("2026-01-01T00:00:00Z"),
    periodEndAt: new Date("2026-02-01T00:00:00Z"),
    reconciledAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...reservationOverrides,
  } as FakeReservation
  state.reservations.push(reservation)
  const allocations =
    fundingAllocations ??
    (reservation.allocationAmount > 0
      ? ([{ source: "purchased", amount: reservation.allocationAmount }] as const)
      : [])

  let remainingCaptured = reservation.consumedAmount
  for (const [index, allocation] of allocations.entries()) {
    const capturedAmount = Math.min(allocation.amount, Math.max(0, remainingCaptured))
    remainingCaptured -= capturedAmount
    state.fundingLegs.push({
      id: `erfl_seed_${state.fundingLegs.length + 1}`,
      projectId: reservation.projectId,
      reservationId: reservation.id,
      source: allocation.source,
      walletCreditId: allocation.source === "granted" ? (allocation.walletCreditId ?? null) : null,
      grantSource: allocation.source === "granted" ? (allocation.grantSource ?? null) : null,
      allocatedAmount: allocation.amount,
      capturedAmount,
      releasedAmount: 0,
      sequence: index + 1,
      createdAt: reservation.createdAt,
    } as FakeFundingLeg)
  }
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
    // first-class funding legs, not in separate transfers.
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

    // Funding legs preserve source attribution and grant ids.
    expect(
      state.fundingLegs.map((leg) => ({
        amount: leg.allocatedAmount,
        grantSource: leg.grantSource,
        source: leg.source,
        walletCreditId: leg.walletCreditId,
      }))
    ).toEqual([
      { source: "granted", amount: 3 * DOLLAR, walletCreditId: "wcr_old", grantSource: "promo" },
      { source: "granted", amount: 2 * DOLLAR, walletCreditId: "wcr_new", grantSource: "promo" },
      { source: "purchased", amount: 2 * DOLLAR, walletCreditId: null, grantSource: null },
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

    await wallet.createReservation({
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

    expect(
      state.fundingLegs.filter((leg) => leg.source === "granted").map((leg) => leg.walletCreditId)
    ).toEqual(["wcr_soon", "wcr_far"])
  })

  it("stores reservation metadata and forwards it to reserve ledger transfers", async () => {
    const { state, wallet } = buildService()
    state.balances[keys.purchased] = 2 * DOLLAR

    const { err } = await wallet.createReservation({
      projectId,
      customerId,
      currency: "USD",
      entitlementId: "ent_1",
      requestedAmount: 2 * DOLLAR,
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      metadata: {
        requestedBy: "durable_object",
        requestedById: "do_123",
        ignored: undefined,
      },
      idempotencyKey: "reserve:metadata",
    })

    expect(err).toBeUndefined()
    const reservationInsert = state.inserts.find((i) => i.table === "entitlementReservations")
    expect(reservationInsert?.values).toMatchObject({
      metadata: {
        requestedBy: "durable_object",
        requestedById: "do_123",
      },
    })
    expect(state.transfers[0]?.metadata).toMatchObject({
      requestedBy: "durable_object",
      requestedById: "do_123",
      flow: "reserve",
      reservation_id: expect.any(String),
      entitlement_id: "ent_1",
    })
    expect(state.transfers[0]?.metadata).not.toHaveProperty("ignored")
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

  it("uses reservation-scoped ledger source ids when re-opening the same period", async () => {
    const { state, wallet } = buildService()
    const input = {
      projectId,
      customerId,
      currency: "USD" as const,
      entitlementId: "ent_1",
      refillThresholdBps: 2000,
      refillChunkAmount: 1 * DOLLAR,
      periodStartAt: new Date("2026-01-01"),
      periodEndAt: new Date("2026-02-01"),
      idempotencyKey: "reserve:same-period",
    }

    state.balances[keys.purchased] = 3 * DOLLAR
    const first = await wallet.createReservation({
      ...input,
      requestedAmount: 3 * DOLLAR,
    })

    expect(first.err).toBeUndefined()

    // Simulate the active-reservation lookup after a final close: the closed
    // reservation remains in Postgres, but it is ignored by the partial active
    // unique index/query, so a fresh reservation can be inserted for the period.
    state.reservations = []
    state.fundingLegs = []
    state.balances[keys.purchased] = 5 * DOLLAR

    const second = await wallet.createReservation({
      ...input,
      requestedAmount: 5 * DOLLAR,
    })

    expect(second.err).toBeUndefined()
    expect(state.transfers).toHaveLength(2)
    expect(state.transfers[0]?.source.id).toBe(`reserve:same-period:${first.val?.reservationId}`)
    expect(state.transfers[1]?.source.id).toBe(`reserve:same-period:${second.val?.reservationId}`)
    expect(state.transfers[0]?.source.id).not.toBe(state.transfers[1]?.source.id)
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(3 * DOLLAR)
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(5 * DOLLAR)
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

describe("WalletService reservation capture, extend, and release", () => {
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

    const { val, err } = await flushReservationForTest(wallet, {
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_1",
      flushSeq: 1,
      flushAmount: 2 * DOLLAR,
      refillChunkAmount: 3 * DOLLAR,
      statementKey: "stmt_1",
      final: false,
      metadata: {
        requestedBy: "durable_object",
        requestedById: "do_123",
      },
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
    expect(state.transfers[0]?.statementKey).toBe("stmt_1")
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.granted,
      toAccount: keys.reserved,
    })
    expect(state.transfers[1]?.metadata).toMatchObject({
      requestedBy: "durable_object",
      requestedById: "do_123",
      flow: "extend",
    })
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(1 * DOLLAR)
    expect(state.transfers[2]).toMatchObject({
      fromAccount: keys.purchased,
      toAccount: keys.reserved,
    })
    expect(toLedgerMinor(state.transfers[2]!.amount)).toBe(2 * DOLLAR)

    // Reservation row reflects both flush and refill.
    const consumedUpdate = state.updates.find(
      (u) => u.table === "entitlementReservations" && "consumedAmount" in u.set
    )
    const allocationUpdate = state.updates.find(
      (u) => u.table === "entitlementReservations" && "allocationAmount" in u.set
    )
    expect(consumedUpdate?.set).toMatchObject({ consumedAmount: 2 * DOLLAR })
    expect(allocationUpdate?.set).toMatchObject({ allocationAmount: 5 * DOLLAR + 3 * DOLLAR })
    expect(allocationUpdate?.set).not.toHaveProperty("reconciledAt")
  })

  it("captures usage across funding legs in allocation order", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_capture_order",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 5 * DOLLAR,
      consumedAmount: 0,
      fundingAllocations: [
        { source: "granted", amount: 3 * DOLLAR, grantSource: "promo", walletCreditId: "wcr_a" },
        { source: "purchased", amount: 2 * DOLLAR },
      ],
    })
    state.balances[keys.reserved] = 5 * DOLLAR

    const { val, err } = await wallet.captureReservationUsage({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_capture_order",
      flushSeq: 1,
      amount: 4 * DOLLAR,
      statementKey: "stmt_capture_order",
    })

    expect(err).toBeUndefined()
    expect(val?.capturedAmount).toBe(4 * DOLLAR)
    expect(state.transfers).toHaveLength(2)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.consumed,
    })
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.consumed,
    })
    expect(state.transfers.map((transfer) => toLedgerMinor(transfer.amount))).toEqual([
      3 * DOLLAR,
      1 * DOLLAR,
    ])
    expect(state.fundingLegs.map((leg) => leg.capturedAmount)).toEqual([3 * DOLLAR, 1 * DOLLAR])
    expect(state.reservations[0]?.consumedAmount).toBe(4 * DOLLAR)
  })

  it("attributes captured usage to settlement metadata by funding source", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_capture_settlement",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 9 * DOLLAR,
      consumedAmount: 0,
      fundingAllocations: [
        {
          source: "granted",
          amount: 3 * DOLLAR,
          grantSource: "plan_included",
          walletCreditId: "wcr_plan",
        },
        {
          source: "granted",
          amount: 4 * DOLLAR,
          grantSource: "credit_line",
          walletCreditId: "wcr_credit",
        },
        { source: "purchased", amount: 2 * DOLLAR },
      ],
    })
    state.balances[keys.reserved] = 9 * DOLLAR

    const { val, err } = await wallet.captureReservationUsage({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_capture_settlement",
      flushSeq: 1,
      amount: 9 * DOLLAR,
      statementKey: "stmt_capture_settlement",
      billingPeriodId: "bp_1",
    })

    expect(err).toBeUndefined()
    expect(val?.capturedAmount).toBe(9 * DOLLAR)
    expect(state.transfers).toHaveLength(3)
    expect(state.transfers.map((transfer) => toLedgerMinor(transfer.amount))).toEqual([
      3 * DOLLAR,
      4 * DOLLAR,
      2 * DOLLAR,
    ])
    expect(state.transfers.map((transfer) => transfer.metadata)).toMatchObject([
      {
        settlement_source: "plan_included",
        settlement_status: "included",
        collectable: false,
        invoice_visible: true,
        wallet_credit_id: "wcr_plan",
        wallet_credit_source: "plan_included",
      },
      {
        settlement_source: "credit_line",
        settlement_status: "due",
        collectable: true,
        invoice_visible: false,
        wallet_credit_id: "wcr_credit",
        wallet_credit_source: "credit_line",
      },
      {
        settlement_source: "cash_wallet",
        settlement_status: "paid",
        collectable: false,
        invoice_visible: true,
      },
    ])
  })

  it("treats changed capture invoice context as a wallet idempotency conflict", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_capture_hash",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 2 * DOLLAR,
      consumedAmount: 0,
      fundingAllocations: [{ source: "purchased", amount: 2 * DOLLAR }],
    })
    state.balances[keys.reserved] = 2 * DOLLAR

    const baseInput = {
      projectId,
      customerId,
      currency: "USD" as const,
      reservationId: "res_capture_hash",
      flushSeq: 1,
      amount: 2 * DOLLAR,
      statementKey: "stmt_capture_hash",
      billingPeriodId: "bp_1",
      kind: "usage",
      sourceId: "bp_1:item_1",
      metadata: {
        billing_period_id: "bp_1",
        cycle_end_at: 2000,
        cycle_start_at: 1000,
        feature_plan_version_item_id: "item_1",
        source_id: "bp_1:item_1",
      },
    }

    const first = await wallet.captureReservationUsage(baseInput)
    expect(first.err).toBeUndefined()
    expect(first.val?.capturedAmount).toBe(2 * DOLLAR)

    state.replayWalletCommands = true

    const replay = await wallet.captureReservationUsage(baseInput)
    expect(replay.err).toBeUndefined()
    expect(replay.val?.capturedAmount).toBe(2 * DOLLAR)

    const changed = await wallet.captureReservationUsage({
      ...baseInput,
      billingPeriodId: "bp_2",
      sourceId: "bp_2:item_1",
      metadata: {
        ...baseInput.metadata,
        billing_period_id: "bp_2",
        source_id: "bp_2:item_1",
      },
    })

    expect(changed.err?.message).toBe("WALLET_IDEMPOTENCY_CONFLICT")
  })

  it("rejects captures that exceed still-reserved funding legs", async () => {
    const { state, wallet } = buildService()
    seedReservation(state, {
      id: "res_over_capture",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 2 * DOLLAR,
      consumedAmount: 0,
      fundingAllocations: [{ source: "purchased", amount: 2 * DOLLAR }],
    })
    state.balances[keys.reserved] = 2 * DOLLAR

    const { err } = await wallet.captureReservationUsage({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_over_capture",
      flushSeq: 1,
      amount: 3 * DOLLAR,
      statementKey: "stmt_over_capture",
    })

    expect(err?.message).toBe("WALLET_INSUFFICIENT_FUNDS")
    expect(state.transfers).toHaveLength(0)
    expect(state.fundingLegs.map((leg) => leg.capturedAmount)).toEqual([0])
    expect(state.reservations[0]?.consumedAmount).toBe(0)
  })

  it("release: captures consumed and restores unused funds to customer buckets", async () => {
    const { state, wallet } = buildService()
    seedGrant(state, {
      id: "wcr_1",
      customerId,
      projectId,
      issuedAmount: 4 * DOLLAR,
      remainingAmount: 0,
      source: "promo",
    })
    seedReservation(state, {
      id: "res_2",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 2 * DOLLAR,
      fundingAllocations: [
        { source: "granted", amount: 4 * DOLLAR, grantSource: "promo", walletCreditId: "wcr_1" },
        { source: "purchased", amount: 6 * DOLLAR },
      ],
    })
    state.balances[keys.reserved] = 10 * DOLLAR

    const { val, err } = await flushReservationForTest(wallet, {
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

    // Capture leg + release batch (purchased and granted restore).
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
      toAccount: keys.granted,
    })
    expect(toLedgerMinor(state.transfers[2]!.amount)).toBe(1 * DOLLAR)

    // reconciledAt is stamped on release.
    const resUpdate = state.updates.find(
      (u) => u.table === "entitlementReservations" && "reconciledAt" in u.set
    )
    expect(resUpdate?.set).toHaveProperty("reconciledAt")
  })

  it("release restores partially unused granted funding to the original grant row", async () => {
    const { state, wallet } = buildService()
    seedGrant(state, {
      id: "wcr_a",
      customerId,
      projectId,
      issuedAmount: 3 * DOLLAR,
      remainingAmount: 0,
      source: "promo",
    })
    seedGrant(state, {
      id: "wcr_b",
      customerId,
      projectId,
      issuedAmount: 2 * DOLLAR,
      remainingAmount: 0,
      source: "promo",
    })
    seedReservation(state, {
      id: "res_release_attribution",
      customerId,
      projectId,
      entitlementId: "ent_1",
      allocationAmount: 10 * DOLLAR,
      consumedAmount: 4 * DOLLAR,
      fundingAllocations: [
        { source: "granted", amount: 3 * DOLLAR, grantSource: "promo", walletCreditId: "wcr_a" },
        { source: "granted", amount: 2 * DOLLAR, grantSource: "promo", walletCreditId: "wcr_b" },
        { source: "purchased", amount: 5 * DOLLAR },
      ],
    })
    state.balances[keys.reserved] = 6 * DOLLAR

    const { val, err } = await wallet.releaseReservation({
      projectId,
      customerId,
      currency: "USD",
      reservationId: "res_release_attribution",
      closeReason: "period_close",
      idempotencyKey: "release:res_release_attribution:period_close",
    })

    expect(err).toBeUndefined()
    expect(val).toMatchObject({
      releasedAmount: 6 * DOLLAR,
      restoredGrantedAmount: 1 * DOLLAR,
      refundedPurchasedAmount: 5 * DOLLAR,
    })
    expect(state.transfers).toHaveLength(2)
    expect(state.transfers[0]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.purchased,
    })
    expect(toLedgerMinor(state.transfers[0]!.amount)).toBe(5 * DOLLAR)
    expect(state.transfers[1]).toMatchObject({
      fromAccount: keys.reserved,
      toAccount: keys.granted,
    })
    expect(state.transfers[1]?.metadata).toMatchObject({
      grant_id: "wcr_b",
      source: "granted",
    })
    expect(toLedgerMinor(state.transfers[1]!.amount)).toBe(1 * DOLLAR)
    expect(
      state.updates.filter((update) => update.table === "walletCredits").map((update) => update.set)
    ).toEqual([{ remainingAmount: 1 * DOLLAR }])
    expect(state.fundingLegs.map((leg) => leg.releasedAmount)).toEqual([0, 1 * DOLLAR, 5 * DOLLAR])
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

    const { err } = await flushReservationForTest(wallet, {
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
    const { db, state, wallet } = buildService()

    const { err } = await wallet.expireGrant(db as never, {
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
    const { db, state, wallet } = buildService()

    await wallet.expireGrant(db as never, {
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

describe("WalletService.getWalletCreditBalance", () => {
  const customerId = "cus_abc"
  const projectId = "prj_abc"

  it("returns a wallet credit by customer and wallet id", async () => {
    const { state, wallet } = buildService()
    seedGrant(state, {
      id: "wcr_target",
      customerId,
      projectId,
      issuedAmount: 10 * DOLLAR,
      remainingAmount: 7 * DOLLAR,
      expiresAt: new Date("2026-12-01"),
    })

    const { val, err } = await wallet.getWalletCreditBalance({
      projectId,
      customerId,
      walletId: "wcr_target",
    })

    expect(err).toBeUndefined()
    expect(val?.id).toBe("wcr_target")
    expect(val?.remainingAmount).toBe(7 * DOLLAR)
  })
})
