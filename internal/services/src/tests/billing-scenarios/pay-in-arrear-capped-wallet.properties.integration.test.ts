import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import * as fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import { RatingService } from "../../rating/service"
import { DrizzleSubscriptionRepository } from "../../subscriptions/repository.drizzle"
import type { SubscriptionContext } from "../../subscriptions/types"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { billPeriod } from "../../use-cases/billing/bill-period"
import { deriveActivationInputsFromPlan } from "../../use-cases/billing/derive-provision-inputs"
import { activateSubscription } from "../../use-cases/billing/provision-period"
import { WalletService } from "../../wallet"
import { flushReservationForTest } from "../wallet-scenarios/helpers"

const db = createTestDatabaseConnection()

const fixtures = [
  "base-project.sql",
  "plan-monthly-arrear.sql",
  "customer-active.sql",
  "subscription-monthly-arrear-capped-active.sql",
]

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_arrear_capped"
const eventsEntitlementId = "ent_test_arrear_capped_events"
const statementKey = "stmt_test_arrear_capped_2026_01"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000
const flatAccessAmount = 9_900_000_000
const creditLineAmount = 12_000_000_000
const propertyRuns = Number.parseInt(process.env.UNPRICE_DB_PROPERTY_RUNS ?? "8", 10)
const propertySeed = process.env.UNPRICE_DB_PROPERTY_SEED
  ? Number.parseInt(process.env.UNPRICE_DB_PROPERTY_SEED, 10)
  : process.env.UNPRICE_PROPERTY_SEED
    ? Number.parseInt(process.env.UNPRICE_PROPERTY_SEED, 10)
    : undefined

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

function createAnalytics(usageByFeature: Record<string, number>): Analytics {
  return {
    getUsageBillingFeatures: vi.fn(
      async ({
        features,
      }: {
        features: Array<{ featureSlug: string }>
      }) =>
        Ok(
          features.map((feature) => ({
            featureSlug: feature.featureSlug,
            usage: usageByFeature[feature.featureSlug] ?? 0,
          }))
        )
    ),
  } as unknown as Analytics
}

async function loadSubscriptionContext(): Promise<SubscriptionContext> {
  const subscription = (await db.query.subscriptions.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, subscriptionId)),
  })) as Subscription | undefined
  const customer = (await db.query.customers.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, customerId)),
  })) as Customer | undefined

  if (!subscription || !customer) {
    throw new Error("Seeded subscription context was not restored")
  }

  return {
    now: billableNow,
    subscriptionId,
    projectId,
    subscription,
    customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
  }
}

function expectedEventsAmount(usage: number) {
  if (usage <= 0) return 0

  // The seeded arrears plan uses volume tiers:
  // 1..1000 => 1 EUR flat + 0.001 EUR/unit, 1001+ => 0.10 EUR/unit.
  if (usage <= 1000) {
    return 100_000_000 + usage * 100_000
  }

  return usage * 10_000_000
}

async function runCappedWalletPropertyCase(usage: number) {
  await truncateTestDatabase(db)
  await seedTestDb({ db, fixtures })

  const expectedUsageAmount = expectedEventsAmount(usage)
  const expectedTotalAmount = flatAccessAmount + expectedUsageAmount
  const remainingCreditLine = creditLineAmount - expectedUsageAmount
  const logger = createLogger()
  const ledger = new LedgerGateway({ db, logger })
  const wallet = new WalletService({ db, logger, ledgerGateway: ledger })
  const analytics = createAnalytics({ events: usage })
  const rating = new RatingService({
    logger,
    analytics,
    grantsManager: new GrantsManager({ db, logger }),
  })
  const repo = new DrizzleSubscriptionRepository(db)
  const services = {
    wallet,
    ledger,
    subscriptions: {},
  } as unknown as Pick<ServiceContext, "wallet" | "ledger" | "subscriptions">

  const activationInputs = await deriveActivationInputsFromPlan(db, { projectId, subscriptionId })
  expect(activationInputs).toEqual({
    creditLinePolicy: "capped",
    grants: [{ amount: creditLineAmount, reason: "Period usage allowance", source: "credit_line" }],
  })

  const activation = await activateSubscription(
    { services, db, logger },
    {
      subscriptionId,
      projectId,
      periodStartAt: new Date(jan1),
      periodEndAt: new Date(feb1),
      idempotencyKey: "p0-b-property-2026-01",
      grants: activationInputs?.grants,
    }
  )
  expect(activation.err).toBeUndefined()

  const reservation = await wallet.createReservation({
    projectId,
    customerId,
    currency: "EUR",
    entitlementId: eventsEntitlementId,
    requestedAmount: expectedUsageAmount,
    refillThresholdBps: 2000,
    refillChunkAmount: 0,
    periodStartAt: new Date(jan1),
    periodEndAt: new Date(feb1),
    effectiveAt: new Date(jan1),
    metadata: { owner: "p0-b-property" },
    idempotencyKey: "reserve:p0-b-property-2026-01:events",
  })
  expect(reservation.err).toBeUndefined()
  expect(reservation.val).toMatchObject({
    allocationAmount: expectedUsageAmount,
  })

  await expectWalletState(wallet, {
    consumed: 0,
    creditCount: remainingCreditLine > 0 ? 1 : 0,
    granted: remainingCreditLine,
    reserved: expectedUsageAmount,
  })

  const reservationId = reservation.val?.reservationId
  expect(reservationId).toBeDefined()
  if (!reservationId) return

  const flush = await flushReservationForTest(wallet, {
    projectId,
    customerId,
    currency: "EUR",
    reservationId,
    flushSeq: 1,
    flushAmount: expectedUsageAmount,
    refillChunkAmount: 0,
    statementKey,
    final: true,
    effectiveAt: new Date(feb1),
    sourceId: "bp_test_arrear_capped_events_jan:item_test_arrear_capped_events",
    metadata: { owner: "p0-b-property" },
  })
  expect(flush.err).toBeUndefined()
  expect(flush.val).toMatchObject({
    flushedAmount: expectedUsageAmount,
    grantedAmount: 0,
    refundedAmount: 0,
  })

  await expectWalletState(wallet, {
    consumed: expectedUsageAmount,
    creditCount: remainingCreditLine > 0 ? 1 : 0,
    granted: remainingCreditLine,
    reserved: 0,
  })

  const firstRun = await billPeriod({
    context: await loadSubscriptionContext(),
    logger,
    db,
    repo,
    ratingService: rating,
    ledgerService: ledger,
  })
  const secondRun = await billPeriod({
    context: await loadSubscriptionContext(),
    logger,
    db,
    repo,
    ratingService: rating,
    ledgerService: ledger,
  })

  expect(firstRun.phasesProcessed).toBe(1)
  expect(secondRun.phasesProcessed).toBe(0)
  await expectInvoice(expectedTotalAmount)
  await expectInvoiceLineAmounts(ledger, [flatAccessAmount, expectedUsageAmount])
  await expectReservationClosed(reservationId, expectedUsageAmount)
  await expectWalletCredit(remainingCreditLine)
  await expectLedgerSources()
  expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
}

describe("P0-B pay_in_arrear capped wallet properties", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  it("drains generated usage costs through wallet reservations and invoices actuals", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1200 }), runCappedWalletPropertyCase),
      {
        examples: [[1], [1000], [1001], [1200]],
        numRuns: propertyRuns,
        seed: propertySeed,
      }
    )
  })
})

async function expectWalletState(
  wallet: WalletService,
  expected: { consumed: number; creditCount: number; granted: number; reserved: number }
) {
  const state = await wallet.getWalletState({ projectId, customerId })
  expect(state.err).toBeUndefined()
  expect(state.val?.balances).toMatchObject({
    consumed: expected.consumed,
    granted: expected.granted,
    purchased: 0,
    reserved: expected.reserved,
  })
  expect(state.val?.credits).toHaveLength(expected.creditCount)
}

async function expectInvoice(expectedAmount: number) {
  const invoices = await db.execute<{
    id: string
    status: "draft"
    gross_amount: number

    amount_due: number

    amount_paid: number

    amount_included: number
    statement_key: string
  }>(sql`
    SELECT id, status, gross_amount, amount_due, amount_paid, amount_included, statement_key
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
  `)
  const invoiceRows = invoices.rows.map((invoice) => ({
    ...invoice,
    gross_amount: Number(invoice.gross_amount),

    amount_due: Number(invoice.amount_due),

    amount_paid: Number(invoice.amount_paid),

    amount_included: Number(invoice.amount_included),
  }))
  expect(invoiceRows).toEqual([
    expect.objectContaining({
      status: "draft",
      statement_key: statementKey,
      gross_amount: expectedAmount,

      amount_due: expectedAmount,

      amount_paid: 0,

      amount_included: 0,
    }),
  ])

  const invoiceId = invoiceRows[0]?.id
  const periods = await db.execute<{ status: "invoiced"; invoice_id: string | null }>(sql`
    SELECT status, invoice_id
    FROM unprice_billing_periods
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
    ORDER BY id
  `)
  expect(periods.rows).toEqual([
    { invoice_id: invoiceId, status: "invoiced" },
    { invoice_id: invoiceId, status: "invoiced" },
  ])
}

async function expectInvoiceLineAmounts(ledger: LedgerGateway, expectedAmounts: number[]) {
  const lines = await ledger.getInvoiceLines({ projectId, statementKey })
  expect(lines.err).toBeUndefined()
  expect(
    (lines.val ?? []).map((line) => toLedgerMinor(line.amount)).sort((left, right) => left - right)
  ).toEqual(expectedAmounts.sort((left, right) => left - right))
}

async function expectReservationClosed(reservationId: string, expectedUsageAmount: number) {
  const reservations = await db.execute<{
    allocation_amount: number
    consumed_amount: number
    reconciled_at: Date | null
  }>(sql`
    SELECT allocation_amount, consumed_amount, reconciled_at
    FROM unprice_entitlement_reservations
    WHERE project_id = ${projectId}
      AND id = ${reservationId}
  `)
  expect(
    reservations.rows.map((row) => ({
      allocation_amount: Number(row.allocation_amount),
      consumed_amount: Number(row.consumed_amount),
      reconciled: row.reconciled_at !== null,
    }))
  ).toEqual([
    {
      allocation_amount: expectedUsageAmount,
      consumed_amount: expectedUsageAmount,
      reconciled: true,
    },
  ])
}

async function expectWalletCredit(expectedRemainingAmount: number) {
  const credits = await db.execute<{
    issued_amount: number
    remaining_amount: number
  }>(sql`
    SELECT issued_amount, remaining_amount
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND customer_id = ${customerId}
  `)
  expect(
    credits.rows.map((credit) => ({
      issued_amount: Number(credit.issued_amount),
      remaining_amount: Number(credit.remaining_amount),
    }))
  ).toEqual([{ issued_amount: creditLineAmount, remaining_amount: expectedRemainingAmount }])
}

async function expectLedgerSources() {
  const sources = await db.execute<{ source_type: string; count: number }>(sql`
    SELECT source_type, COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
    GROUP BY source_type
    ORDER BY source_type
  `)
  expect(sources.rows).toEqual([
    { count: 2, source_type: "subscription_billing_period_charge_v1" },
    { count: 1, source_type: "wallet_adjust" },
    { count: 1, source_type: "wallet_capture_usage" },
    { count: 1, source_type: "wallet_reserve_granted" },
  ])

  const statementEntries = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency i
    JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
    WHERE i.project_id = ${projectId}
      AND i.statement_key = ${statementKey}
  `)
  expect(statementEntries.rows).toEqual([{ count: 4 }])
}
