import { sql } from "@unprice/db"
import { Err } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { LedgerGateway } from "../../ledger"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { expireWalletCredits } from "../../use-cases/wallet/expire-wallet-credits"
import { UnPriceWalletError, WalletService } from "../../wallet"
import { flushReservationForTest } from "./helpers"

const db = createTestDatabaseConnection()

const fixtures = ["base-project.sql", "customer-active.sql"]
const projectId = "proj_test"
const customerId = "cus_test"
const currency = "EUR"
const euro = 100_000_000
const jan1 = new Date("2026-01-01T00:00:00.000Z")
const jan5 = new Date("2026-01-05T00:00:00.000Z")
const jan10 = new Date("2026-01-10T00:00:00.000Z")
const jan15 = new Date("2026-01-15T00:00:00.000Z")
const feb1 = new Date("2026-02-01T00:00:00.000Z")
const feb15 = new Date("2026-02-15T00:00:00.000Z")

function createLogger(): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createWallet(logger = createLogger()) {
  const ledger = new LedgerGateway({ db, logger })
  const wallet = new WalletService({ db, logger, ledgerGateway: ledger })
  return { ledger, logger, wallet }
}

function walletWithFirstExpirationFailure(realWallet: WalletService) {
  type ExpireArgs = Parameters<WalletService["expireGrant"]>
  type ExpireReturn = ReturnType<WalletService["expireGrant"]>

  let failuresRemaining = 1
  const expireGrant = vi.fn((...args: ExpireArgs): ExpireReturn => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      return Promise.resolve(
        Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" }))
      ) as ExpireReturn
    }

    return realWallet.expireGrant(...args)
  })

  return new Proxy(realWallet, {
    get(target, prop, receiver) {
      if (prop === "expireGrant") return expireGrant
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as WalletService & { expireGrant: typeof expireGrant }
}

describe("wallet credit expiration sweep DB lifecycle", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("expires remaining credits, stamps fully drained credits, and leaves future credits active", async () => {
    const { logger, wallet } = createWallet()

    const drained = await wallet.adjust({
      actorId: "system:sweep-test",
      currency,
      customerId,
      expiresAt: jan10,
      idempotencyKey: "wallet-sweep:drained",
      projectId,
      reason: "drained before sweep",
      signedAmount: 2 * euro,
      source: "promo",
    })
    const expiring = await wallet.adjust({
      actorId: "system:sweep-test",
      currency,
      customerId,
      expiresAt: jan15,
      idempotencyKey: "wallet-sweep:expiring",
      projectId,
      reason: "expires on sweep",
      signedAmount: 4 * euro,
      source: "promo",
    })
    const future = await wallet.adjust({
      actorId: "system:sweep-test",
      currency,
      customerId,
      expiresAt: feb15,
      idempotencyKey: "wallet-sweep:future",
      projectId,
      reason: "future credit",
      signedAmount: 3 * euro,
      source: "promo",
    })
    expect(drained.err).toBeUndefined()
    expect(expiring.err).toBeUndefined()
    expect(future.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan5,
      entitlementId: "ent_wallet_expiration_sweep",
      idempotencyKey: "wallet-sweep:reserve-drained",
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 2 * euro,
    })
    expect(reservation.err).toBeUndefined()
    await expectReservationFundingLegs({
      expected: [
        {
          allocatedAmount: 2 * euro,
          grantSource: "promo",
          source: "granted",
          walletCreditId: drained.val?.grantId,
        },
      ],
      reservationId: reservation.val?.reservationId,
    })

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const flush = await flushReservationForTest(wallet, {
      currency,
      customerId,
      final: true,
      flushAmount: 2 * euro,
      flushSeq: 1,
      projectId,
      refillChunkAmount: 0,
      reservationId,
      statementKey: "stmt_wallet_sweep",
    })
    expect(flush.err).toBeUndefined()

    const swept = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet },
      },
      { now: feb1 }
    )
    expect(swept).toEqual({ expiredCount: 1, skippedCount: 1 })

    await expectCreditRows([
      {
        expired: true,
        id: drained.val?.grantId,
        remainingAmount: 0,
      },
      {
        expired: true,
        id: expiring.val?.grantId,
        remainingAmount: 0,
      },
      {
        expired: false,
        id: future.val?.grantId,
        remainingAmount: 3 * euro,
      },
    ])
    await expectWalletState(wallet, {
      consumed: 2 * euro,
      creditIds: [future.val?.grantId],
      granted: 3 * euro,
      purchased: 0,
      reserved: 0,
    })
    await expectLedgerSourceCounts([
      { count: 3, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_capture_usage" },
      { count: 1, source_type: "wallet_expire_grant" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])

    const replay = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet },
      },
      { now: feb1 }
    )
    expect(replay).toEqual({ expiredCount: 0, skippedCount: 0 })
    await expectLedgerSourceCounts([
      { count: 3, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_capture_usage" },
      { count: 1, source_type: "wallet_expire_grant" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])
  })

  it("skips grants with active reserved funding, then expires after reservation release", async () => {
    const { logger, wallet } = createWallet()

    const expiring = await wallet.adjust({
      actorId: "system:sweep-test",
      currency,
      customerId,
      expiresAt: jan15,
      idempotencyKey: "wallet-sweep:active-reservation",
      projectId,
      reason: "active reservation expiration guard",
      signedAmount: 5 * euro,
      source: "promo",
    })
    expect(expiring.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan5,
      entitlementId: "ent_wallet_active_reservation_sweep",
      idempotencyKey: "wallet-sweep:active-reservation:reserve",
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 3 * euro,
    })
    expect(reservation.err).toBeUndefined()

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const skipped = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet },
      },
      { now: feb1 }
    )
    expect(skipped).toEqual({ expiredCount: 0, skippedCount: 1 })
    expect(logger.warn).toHaveBeenCalledWith(
      "wallet.expire_grant.skipped_active_reservation",
      expect.objectContaining({
        grantId: expiring.val?.grantId,
        reservationId,
        stillReservedAmount: 3 * euro,
      })
    )
    await expectCreditRows([
      {
        expired: false,
        id: expiring.val?.grantId,
        remainingAmount: 2 * euro,
      },
    ])
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [expiring.val?.grantId],
      granted: 2 * euro,
      purchased: 0,
      reserved: 3 * euro,
    })
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])

    const release = await flushReservationForTest(wallet, {
      currency,
      customerId,
      final: true,
      flushAmount: 0,
      flushSeq: 1,
      projectId,
      refillChunkAmount: 0,
      reservationId,
      closeReason: "period_close",
      statementKey: "stmt_wallet_active_reservation_release",
    })
    expect(release.err).toBeUndefined()

    const expired = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet },
      },
      { now: feb1 }
    )
    expect(expired).toEqual({ expiredCount: 1, skippedCount: 0 })
    await expectCreditRows([
      {
        expired: true,
        id: expiring.val?.grantId,
        remainingAmount: 0,
      },
    ])
    await expectWalletState(wallet, {
      consumed: 0,
      creditIds: [],
      granted: 0,
      purchased: 0,
      reserved: 0,
    })
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_expire_grant" },
      { count: 1, source_type: "wallet_release_reservation" },
      { count: 1, source_type: "wallet_reserve_granted" },
    ])
  })

  it("leaves failed expirations retryable and succeeds on the next sweep", async () => {
    const { logger, wallet } = createWallet()
    const failingWallet = walletWithFirstExpirationFailure(wallet)

    const expiring = await wallet.adjust({
      actorId: "system:sweep-test",
      currency,
      customerId,
      expiresAt: jan15,
      idempotencyKey: "wallet-sweep:retry",
      projectId,
      reason: "retry expiration",
      signedAmount: 5 * euro,
      source: "promo",
    })
    expect(expiring.err).toBeUndefined()

    const failed = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet: failingWallet },
      },
      { now: feb1 }
    )
    expect(failed).toEqual({ expiredCount: 0, skippedCount: 1 })
    await expectCreditRows([
      {
        expired: false,
        id: expiring.val?.grantId,
        remainingAmount: 5 * euro,
      },
    ])
    await expectLedgerSourceCounts([{ count: 1, source_type: "wallet_adjust" }])

    const retry = await expireWalletCredits(
      {
        db,
        logger,
        services: { wallet: failingWallet },
      },
      { now: feb1 }
    )
    expect(retry).toEqual({ expiredCount: 1, skippedCount: 0 })
    await expectCreditRows([
      {
        expired: true,
        id: expiring.val?.grantId,
        remainingAmount: 0,
      },
    ])
    await expectLedgerSourceCounts([
      { count: 1, source_type: "wallet_adjust" },
      { count: 1, source_type: "wallet_expire_grant" },
    ])
  })
})

async function expectCreditRows(
  expected: Array<{ expired: boolean; id: string | undefined; remainingAmount: number }>
) {
  const rows = await db.execute<{
    expired: boolean
    id: string
    remaining_amount: number | string
  }>(sql`
    SELECT id, remaining_amount, expired_at IS NOT NULL AS expired
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND customer_id = ${customerId}
    ORDER BY COALESCE(expires_at, 'infinity'::timestamptz), created_at, id
  `)

  expect(
    rows.rows.map((row) => ({
      expired: row.expired,
      id: row.id,
      remainingAmount: Number(row.remaining_amount),
    }))
  ).toEqual(expected)
}

async function expectWalletState(
  wallet: WalletService,
  expected: {
    consumed: number
    creditIds: Array<string | undefined>
    granted: number
    purchased: number
    reserved: number
  }
) {
  const state = await wallet.getWalletState({ projectId, customerId })
  expect(state.err).toBeUndefined()
  expect(state.val?.balances).toEqual({
    consumed: expected.consumed,
    granted: expected.granted,
    purchased: expected.purchased,
    reserved: expected.reserved,
  })
  expect(state.val?.credits.map((credit) => credit.id)).toEqual(expected.creditIds)
}

async function expectReservationFundingLegs(input: {
  expected: Array<{
    allocatedAmount: number
    grantSource: string | null
    source: "granted" | "purchased"
    walletCreditId: string | null | undefined
  }>
  reservationId: string | undefined
}) {
  expect(input.reservationId).toBeDefined()
  if (!input.reservationId) return

  const fundingLegs = await db.execute<{
    allocated_amount: number | string
    grant_source: string | null
    source: "granted" | "purchased"
    wallet_credit_id: string | null
  }>(sql`
    SELECT source, wallet_credit_id, grant_source, allocated_amount
    FROM unprice_entitlement_reservation_funding_legs
    WHERE project_id = ${projectId}
      AND reservation_id = ${input.reservationId}
    ORDER BY sequence ASC
  `)

  expect(
    fundingLegs.rows.map((row) => ({
      allocatedAmount: Number(row.allocated_amount),
      grantSource: row.grant_source,
      source: row.source,
      walletCreditId: row.wallet_credit_id,
    }))
  ).toEqual(input.expected)
}

async function expectLedgerSourceCounts(expected: Array<{ count: number; source_type: string }>) {
  const sources = await db.execute<{ count: number; source_type: string }>(sql`
    SELECT source_type, COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND source_type LIKE 'wallet_%'
    GROUP BY source_type
    ORDER BY source_type
  `)

  expect(sources.rows).toEqual(expected)
}
