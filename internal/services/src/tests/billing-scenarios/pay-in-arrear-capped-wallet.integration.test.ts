import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { classifyInvoiceLineSettlement } from "../../billing/invoice-settlement"
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
const usageAmount = 12_000_000_000
const fixedAmount = 9_900_000_000
const invoiceAmount = 21_900_000_000
const usageBillingPeriodId = "bp_test_arrear_capped_events_jan"
const usageSubscriptionItemId = "item_test_arrear_capped_events"

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

describe("P0-B pay_in_arrear capped wallet workflow", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("P0-B issues credit-line runway, reserves and flushes wallet usage, invoices actuals, and is idempotent", async () => {
    const logger = createLogger()
    const ledger = new LedgerGateway({ db, logger })
    const wallet = new WalletService({ db, logger, ledgerGateway: ledger })
    const analytics = createAnalytics({ events: 1200 })
    const rating = new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db, logger }),
    })
    const repo = new DrizzleSubscriptionRepository(db)

    const activationInputs = await deriveActivationInputsFromPlan(db, { projectId, subscriptionId })
    expect(activationInputs).toEqual({
      creditLinePolicy: "capped",
      grants: [{ amount: usageAmount, reason: "Period usage allowance", source: "credit_line" }],
    })

    const services = {
      wallet,
      ledger,
      subscriptions: {},
    } as unknown as Pick<ServiceContext, "wallet" | "ledger" | "subscriptions">
    const activation = await activateSubscription(
      { services, db, logger },
      {
        subscriptionId,
        projectId,
        periodStartAt: new Date(jan1),
        periodEndAt: new Date(feb1),
        idempotencyKey: "p0-b-2026-01",
        grants: activationInputs?.grants,
      }
    )
    const activationReplay = await activateSubscription(
      { services, db, logger },
      {
        subscriptionId,
        projectId,
        periodStartAt: new Date(jan1),
        periodEndAt: new Date(feb1),
        idempotencyKey: "p0-b-2026-01",
        grants: activationInputs?.grants,
      }
    )
    expect(activation.err).toBeUndefined()
    expect(activation.val?.grantsIssued).toEqual([
      expect.objectContaining({ amount: usageAmount, source: "credit_line" }),
    ])
    expect(activationReplay.err).toBeUndefined()

    await expectWalletState(wallet, {
      consumed: 0,
      creditCount: 1,
      granted: usageAmount,
      reserved: 0,
    })

    const reservation = await wallet.createReservation({
      projectId,
      customerId,
      currency: "EUR",
      entitlementId: eventsEntitlementId,
      requestedAmount: usageAmount,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      periodStartAt: new Date(jan1),
      periodEndAt: new Date(feb1),
      effectiveAt: new Date(jan1),
      metadata: { owner: "p0-b-integration" },
      idempotencyKey: "reserve:p0-b-2026-01:events",
    })
    expect(reservation.err).toBeUndefined()
    expect(reservation.val).toMatchObject({
      allocationAmount: usageAmount,
    })

    const reservationReplay = await wallet.createReservation({
      projectId,
      customerId,
      currency: "EUR",
      entitlementId: eventsEntitlementId,
      requestedAmount: usageAmount,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      periodStartAt: new Date(jan1),
      periodEndAt: new Date(feb1),
      effectiveAt: new Date(jan1),
      idempotencyKey: "reserve:p0-b-2026-01:events",
    })
    expect(reservationReplay.err).toBeUndefined()
    expect(reservationReplay.val).toMatchObject({
      allocationAmount: usageAmount,
      reused: "active",
    })

    await expectWalletState(wallet, {
      consumed: 0,
      creditCount: 0,
      granted: 0,
      reserved: usageAmount,
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
      flushAmount: usageAmount,
      refillChunkAmount: 0,
      statementKey,
      final: true,
      effectiveAt: new Date(feb1),
      sourceId: "bp_test_arrear_capped_events_jan:item_test_arrear_capped_events",
      metadata: {
        owner: "p0-b-integration",
      },
    })
    expect(flush.err).toBeUndefined()
    expect(flush.val).toMatchObject({
      flushedAmount: usageAmount,
      grantedAmount: 0,
      refundedAmount: 0,
    })

    await expectWalletState(wallet, {
      consumed: usageAmount,
      creditCount: 0,
      granted: 0,
      reserved: 0,
    })

    const context = await loadSubscriptionContext()
    const firstRun = await billPeriod({
      context,
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })
    const secondRun = await billPeriod({
      context,
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })

    expect(firstRun.phasesProcessed).toBe(1)
    expect(secondRun.phasesProcessed).toBe(0)
    await expectInvoice({
      amount_due: invoiceAmount,
      amount_included: 0,
      amount_paid: 0,
      gross_amount: invoiceAmount,
    })
    await expectInvoiceLineAmounts(ledger, [9_900_000_000, usageAmount])
    await expectReservationClosed(reservationId)
    await expectLedgerSources()
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })

  it("P0-B treats plan-included wallet captures as included invoice usage", async () => {
    const logger = createLogger()
    const ledger = new LedgerGateway({ db, logger })
    const wallet = new WalletService({ db, logger, ledgerGateway: ledger })
    const analytics = createAnalytics({ events: 1200 })
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

    const activation = await activateSubscription(
      { services, db, logger },
      {
        subscriptionId,
        projectId,
        periodStartAt: new Date(jan1),
        periodEndAt: new Date(feb1),
        idempotencyKey: "p0-b-plan-included-2026-01",
        grants: [
          {
            amount: usageAmount,
            reason: "Plan-included usage allowance",
            source: "plan_included",
          },
        ],
      }
    )
    expect(activation.err).toBeUndefined()

    const reservation = await wallet.createReservation({
      projectId,
      customerId,
      currency: "EUR",
      entitlementId: eventsEntitlementId,
      requestedAmount: usageAmount,
      refillThresholdBps: 2000,
      refillChunkAmount: 0,
      periodStartAt: new Date(jan1),
      periodEndAt: new Date(feb1),
      effectiveAt: new Date(jan1),
      metadata: { owner: "p0-b-plan-included-integration" },
      idempotencyKey: "reserve:p0-b-plan-included-2026-01:events",
    })
    expect(reservation.err).toBeUndefined()

    const reservationId = reservation.val?.reservationId
    expect(reservationId).toBeDefined()
    if (!reservationId) return

    const sourceId = `${usageBillingPeriodId}:${usageSubscriptionItemId}`
    const capture = await wallet.captureReservationUsage({
      projectId,
      customerId,
      currency: "EUR",
      reservationId,
      flushSeq: 1,
      amount: usageAmount,
      billingPeriodId: usageBillingPeriodId,
      kind: "usage",
      statementKey,
      sourceId,
      metadata: {
        owner: "p0-b-plan-included-integration",
        billing_period_id: usageBillingPeriodId,
        feature_plan_version_item_id: usageSubscriptionItemId,
        source_id: sourceId,
      },
    })
    expect(capture.err).toBeUndefined()

    const release = await wallet.releaseReservation({
      projectId,
      customerId,
      currency: "EUR",
      reservationId,
      closeReason: "manual",
      idempotencyKey: `release:${reservationId}:manual`,
      metadata: {
        owner: "p0-b-plan-included-integration",
        source_id: sourceId,
      },
      sourceId,
    })
    expect(release.err).toBeUndefined()

    const context = await loadSubscriptionContext()
    const firstRun = await billPeriod({
      context,
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })
    const secondRun = await billPeriod({
      context,
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })

    expect(firstRun.phasesProcessed).toBe(1)
    expect(secondRun.phasesProcessed).toBe(0)
    await expectInvoice({
      amount_due: fixedAmount,
      amount_included: usageAmount,
      amount_paid: 0,
      gross_amount: fixedAmount + usageAmount,
    })
    await expectInvoiceLineAmounts(ledger, [fixedAmount, usageAmount])
    await expectIncludedUsageLine(ledger)
    await expectReservationClosed(reservationId)
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
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

async function expectInvoice(expected: {
  amount_due: number
  amount_included: number
  amount_paid: number
  gross_amount: number
}) {
  const invoices = await db.execute<{
    id: string
    status: "draft"
    amount_due: number
    amount_included: number
    amount_paid: number
    gross_amount: number
    statement_key: string
  }>(sql`
    SELECT id, status, amount_due, amount_included, amount_paid, gross_amount, statement_key
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
  `)
  const invoiceRows = invoices.rows.map((invoice) => ({
    ...invoice,
    amount_due: Number(invoice.amount_due),
    amount_included: Number(invoice.amount_included),
    amount_paid: Number(invoice.amount_paid),
    gross_amount: Number(invoice.gross_amount),
  }))
  expect(invoiceRows).toEqual([
    expect.objectContaining({
      status: "draft",
      statement_key: statementKey,
      ...expected,
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
  ).toEqual(expectedAmounts)
}

async function expectIncludedUsageLine(ledger: LedgerGateway) {
  const lines = await ledger.getInvoiceLines({ projectId, statementKey })
  expect(lines.err).toBeUndefined()
  const usageLine = (lines.val ?? []).find((line) => {
    const metadata = line.metadata ?? {}
    return (
      metadata.billing_period_id === usageBillingPeriodId &&
      metadata.feature_plan_version_item_id === usageSubscriptionItemId &&
      metadata.kind === "usage"
    )
  })

  expect(usageLine).toBeDefined()
  if (!usageLine) return

  expect({
    ...classifyInvoiceLineSettlement({
      amount: toLedgerMinor(usageLine.amount),
      metadata: usageLine.metadata,
    }),
  }).toMatchObject({
    collectable: false,
    settlementSource: "plan_included",
    settlementStatus: "included",
  })
}

async function expectReservationClosed(reservationId: string) {
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
  ).toEqual([{ allocation_amount: usageAmount, consumed_amount: usageAmount, reconciled: true }])
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
  expect(statementEntries.rows).toEqual([{ count: 6 }])
}
