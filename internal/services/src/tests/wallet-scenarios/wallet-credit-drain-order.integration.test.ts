import { sql } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { LedgerGateway } from "../../ledger"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { WalletService } from "../../wallet"

const db = createTestDatabaseConnection()

const fixtures = ["base-project.sql", "customer-active.sql"]

const projectId = "proj_test"
const customerId = "cus_test"
const currency = "EUR"
const euro = 100_000_000
const jan1 = new Date("2026-01-01T00:00:00.000Z")
const feb1 = new Date("2026-02-01T00:00:00.000Z")
const mar1 = new Date("2026-03-01T00:00:00.000Z")

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

function createWallet() {
  const logger = createLogger()
  const ledger = new LedgerGateway({ db, logger })
  return new WalletService({ db, logger, ledgerGateway: ledger })
}

async function expectFundingLegs(
  reservationId: string | undefined,
  expected: Array<{ allocatedAmount: number; grantSource: string | null }>
) {
  expect(reservationId).toBeDefined()
  if (!reservationId) return

  const fundingLegs = await db.execute<{
    allocated_amount: number | string
    grant_source: string | null
  }>(sql`
    SELECT grant_source, allocated_amount
    FROM unprice_entitlement_reservation_funding_legs
    WHERE project_id = ${projectId}
      AND reservation_id = ${reservationId}
    ORDER BY sequence ASC
  `)

  expect(
    fundingLegs.rows.map((row) => ({
      allocatedAmount: Number(row.allocated_amount),
      grantSource: row.grant_source,
    }))
  ).toEqual(expected)
}

async function expectRemainingBySource(expected: Array<{ source: string; remaining: number }>) {
  const credits = await db.execute<{
    remaining_amount: number | string
    source: string
  }>(sql`
    SELECT source, remaining_amount
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND customer_id = ${customerId}
    ORDER BY source::text ASC
  `)

  expect(
    credits.rows.map((row) => ({
      remaining: Number(row.remaining_amount),
      source: row.source,
    }))
  ).toEqual(expected)
}

describe("wallet credit drain order", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("drains plan_included before credit_line at equal expiry, regardless of insertion order", async () => {
    const wallet = createWallet()

    // Issue both credits in ONE transaction — Postgres freezes now() per
    // transaction, so both rows share created_at exactly like subscription
    // activation grants do. credit_line goes first on purpose so insertion
    // order cannot mask a missing source rank.
    await db.transaction(async (tx) => {
      const creditLine = await wallet.adjust(
        {
          actorId: "system:subscription-activation",
          currency,
          customerId,
          expiresAt: feb1,
          idempotencyKey: "drain-order-test:credit-line",
          projectId,
          reason: "period usage allowance",
          signedAmount: 10 * euro,
          source: "credit_line",
        },
        tx
      )
      if (creditLine.err) throw creditLine.err

      const planIncluded = await wallet.adjust(
        {
          actorId: "system:subscription-activation",
          currency,
          customerId,
          expiresAt: feb1,
          idempotencyKey: "drain-order-test:plan-included",
          projectId,
          reason: "plan included credits",
          signedAmount: 5 * euro,
          source: "plan_included",
        },
        tx
      )
      if (planIncluded.err) throw planIncluded.err
    })

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_drain_order_test",
      idempotencyKey: "drain-order-test:reserve",
      metadata: { owner: "wallet-drain-order-integration" },
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 8 * euro,
    })

    expect(reservation.err).toBeUndefined()
    expect(reservation.val).toMatchObject({ allocationAmount: 8 * euro })

    // Free plan_included money is fully drained first; the chargeable
    // credit_line only covers the remainder.
    await expectFundingLegs(reservation.val?.reservationId, [
      { allocatedAmount: 5 * euro, grantSource: "plan_included" },
      { allocatedAmount: 3 * euro, grantSource: "credit_line" },
    ])
    await expectRemainingBySource([
      { source: "credit_line", remaining: 7 * euro },
      { source: "plan_included", remaining: 0 },
    ])
  })

  it("drains free credits before credit_line even when credit_line expires sooner", async () => {
    const wallet = createWallet()

    const creditLine = await wallet.adjust({
      actorId: "system:subscription-activation",
      currency,
      customerId,
      expiresAt: feb1,
      idempotencyKey: "drain-order-test:credit-line-early",
      projectId,
      reason: "period usage allowance",
      signedAmount: 10 * euro,
      source: "credit_line",
    })
    expect(creditLine.err).toBeUndefined()

    const promo = await wallet.adjust({
      actorId: "admin_1",
      currency,
      customerId,
      expiresAt: mar1,
      idempotencyKey: "drain-order-test:promo-late",
      projectId,
      reason: "welcome credit",
      signedAmount: 3 * euro,
      source: "promo",
    })
    expect(promo.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      currency,
      customerId,
      effectiveAt: jan1,
      entitlementId: "ent_drain_order_rank_test",
      idempotencyKey: "drain-order-test:reserve-rank",
      metadata: { owner: "wallet-drain-order-integration" },
      periodEndAt: feb1,
      periodStartAt: jan1,
      projectId,
      refillChunkAmount: 0,
      refillThresholdBps: 2000,
      requestedAmount: 2 * euro,
    })

    expect(reservation.err).toBeUndefined()

    // An unused credit_line costs the customer nothing at period end, while
    // an unused promo credit is lost value — so the free credit drains first
    // even though it expires later.
    await expectFundingLegs(reservation.val?.reservationId, [
      { allocatedAmount: 2 * euro, grantSource: "promo" },
    ])
    await expectRemainingBySource([
      { source: "credit_line", remaining: 10 * euro },
      { source: "promo", remaining: 1 * euro },
    ])
  })
})
