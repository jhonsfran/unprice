import { sql } from "@unprice/db"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { Cache } from "../../cache"
import { createServiceContext } from "../../context"
import { LATE_EVENT_GRACE_MS } from "../../entitlements"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import type { Metrics } from "../../metrics"
import { RatingService } from "../../rating/service"
import { DrizzleSubscriptionRepository } from "../../subscriptions/repository.drizzle"
import {
  createBillingAnalytics as createAnalytics,
  createBillingLogger as createLogger,
  loadBillingSubscriptionContext,
} from "../../test-fixtures/billing-context"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { billPeriod } from "../../use-cases/billing/bill-period"

const db = createTestDatabaseConnection()

const fixtures = [
  "base-project.sql",
  "plan-monthly-arrear.sql",
  "customer-active.sql",
  "subscription-monthly-arrear-active.sql",
]

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_arrear"
const phaseId = "phase_test_monthly_arrear"
const statementKey = "stmt_test_arrear_2026_01"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const nextYear = Date.parse("2027-01-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000
const invoiceTotal = 21_900_000_000
const annualStatementKey = "stmt_test_arrear_2026_annual"

async function cancelAtRenewalBoundary() {
  await db.execute(sql`
    UPDATE unprice_subscriptions
    SET status = 'canceled',
        active = false,
        end_at_m = ${feb1},
        updated_at_m = ${feb1}
    WHERE project_id = ${projectId}
      AND id = ${subscriptionId}
  `)

  await db.execute(sql`
    UPDATE unprice_subscription_phases
    SET end_at_m = ${feb1},
        updated_at_m = ${feb1}
    WHERE project_id = ${projectId}
      AND id = ${phaseId}
  `)
}

async function loadSubscriptionContext(now = billableNow) {
  return loadBillingSubscriptionContext({
    db,
    now,
    subscriptionId,
    projectId,
    customerId,
  })
}

async function makeArrearSubscriptionAnnual() {
  const yearlyBillingConfig = {
    name: "yearly",
    billingInterval: "year",
    billingIntervalCount: 1,
    billingAnchor: "dayOfCreation",
    planType: "recurring",
  }
  const yearlyResetConfig = {
    name: "yearly",
    resetInterval: "year",
    resetIntervalCount: 1,
    resetAnchor: "dayOfCreation",
    planType: "recurring",
  }

  await db.execute(sql`
    UPDATE unprice_plan_versions
    SET billing_config = ${JSON.stringify(yearlyBillingConfig)}::json,
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND id = 'pv_test_monthly_arrear'
  `)

  await db.execute(sql`
    UPDATE unprice_plan_versions_features
    SET billing_config = ${JSON.stringify(yearlyBillingConfig)}::json,
        reset_config = ${JSON.stringify(yearlyResetConfig)}::json,
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND plan_version_id = 'pv_test_monthly_arrear'
  `)

  await db.execute(sql`
    UPDATE unprice_subscriptions
    SET current_cycle_end_at_m = ${nextYear},
        renew_at_m = ${nextYear},
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND id = ${subscriptionId}
  `)

  await db.execute(sql`
    UPDATE unprice_customer_entitlements
    SET expires_at = ${nextYear},
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
  `)

  await db.execute(sql`
    UPDATE unprice_grants
    SET expires_at = ${nextYear},
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND customer_entitlement_id IN (
        SELECT id
        FROM unprice_customer_entitlements
        WHERE project_id = ${projectId}
          AND subscription_id = ${subscriptionId}
      )
  `)

  await db.execute(sql`
    UPDATE unprice_billing_periods
    SET cycle_end_at_m = ${nextYear},
        invoice_at_m = ${nextYear},
        statement_key = ${annualStatementKey},
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
  `)
}

async function listBillingPeriods() {
  const periods = await db.execute<{
    cycle_end_at_m: string
    cycle_start_at_m: string
    invoice_id: string | null
    statement_key: string
    status: string
  }>(sql`
    SELECT status, invoice_id, statement_key, cycle_start_at_m, cycle_end_at_m
    FROM unprice_billing_periods
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
    ORDER BY cycle_start_at_m, id
  `)

  return periods.rows.map((period) => ({
    ...period,
    cycle_end_at_m: Number(period.cycle_end_at_m),
    cycle_start_at_m: Number(period.cycle_start_at_m),
  }))
}

describe("DB-backed billing golden cases", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("cancellation at the renewal boundary bills the earned period and creates no future charge", async () => {
    const loggerErrors: unknown[] = []
    const logger = createLogger(loggerErrors)
    const analytics = createAnalytics({ events: 1200 })
    const services = createServiceContext({
      db,
      logger,
      analytics,
      waitUntil: (promise) => {
        void promise
      },
      cache: {} as Cache,
      metrics: {} as Metrics,
    })

    await cancelAtRenewalBoundary()

    const materialized = await services.billing.generateBillingPeriods({
      projectId,
      subscriptionId,
      now: billableNow,
    })
    expect(materialized.err).toBeUndefined()
    expect(materialized.val).toEqual({ cyclesCreated: 0, phasesProcessed: 1 })
    expect(await listBillingPeriods()).toEqual([
      expect.objectContaining({
        cycle_end_at_m: feb1,
        cycle_start_at_m: jan1,
        invoice_id: null,
        statement_key: statementKey,
        status: "pending",
      }),
      expect.objectContaining({
        cycle_end_at_m: feb1,
        cycle_start_at_m: jan1,
        invoice_id: null,
        statement_key: statementKey,
        status: "pending",
      }),
    ])

    const ledger = new LedgerGateway({ db, logger })
    const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()
    const billed = await billPeriod({
      context: await loadSubscriptionContext(),
      logger,
      db,
      repo: new DrizzleSubscriptionRepository(db),
      ratingService: new RatingService({
        logger,
        analytics,
        grantsManager: new GrantsManager({ db, logger }),
      }),
      ledgerService: ledger,
    })
    expect(billed.phasesProcessed).toBe(1)

    const invoices = await db.execute<{
      id: string
      statement_end_at_m: string
      statement_key: string
      statement_start_at_m: string
      status: string
      gross_amount: string

      amount_due: string

      amount_paid: string

      amount_included: string
    }>(sql`
      SELECT id, status, gross_amount, amount_due, amount_paid, amount_included, statement_key, statement_start_at_m, statement_end_at_m
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
      ORDER BY statement_start_at_m
    `)
    expect(
      invoices.rows.map((invoice) => ({
        ...invoice,
        statement_end_at_m: Number(invoice.statement_end_at_m),
        statement_start_at_m: Number(invoice.statement_start_at_m),
        gross_amount: Number(invoice.gross_amount),

        amount_due: Number(invoice.amount_due),

        amount_paid: Number(invoice.amount_paid),

        amount_included: Number(invoice.amount_included),
      }))
    ).toEqual([
      expect.objectContaining({
        statement_end_at_m: feb1,
        statement_key: statementKey,
        statement_start_at_m: jan1,
        status: "draft",
        gross_amount: invoiceTotal,

        amount_due: invoiceTotal,

        amount_paid: 0,

        amount_included: 0,
      }),
    ])

    const invoiceId = invoices.rows[0]?.id
    expect(invoiceId).toBeDefined()
    expect(await listBillingPeriods()).toEqual([
      expect.objectContaining({
        cycle_end_at_m: feb1,
        cycle_start_at_m: jan1,
        invoice_id: invoiceId,
        status: "invoiced",
      }),
      expect.objectContaining({
        cycle_end_at_m: feb1,
        cycle_start_at_m: jan1,
        invoice_id: invoiceId,
        status: "invoiced",
      }),
    ])

    const noFuturePeriods = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_billing_periods
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
        AND cycle_start_at_m >= ${feb1}
    `)
    expect(noFuturePeriods.rows).toEqual([{ count: 0 }])

    const noFutureInvoices = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
        AND statement_start_at_m >= ${feb1}
    `)
    expect(noFutureInvoices.rows).toEqual([{ count: 0 }])

    const laterMaterialized = await services.billing.generateBillingPeriods({
      projectId,
      subscriptionId,
      now: mar1,
    })
    expect(laterMaterialized.err).toBeUndefined()
    expect(laterMaterialized.val).toEqual({ cyclesCreated: 0, phasesProcessed: 0 })

    const lineAmounts = (await ledger.getInvoiceLines({ projectId, statementKey })).val
      ?.map((line) => toLedgerMinor(line.amount))
      .sort((left, right) => left - right)
    expect(lineAmounts).toEqual([9_900_000_000, 12_000_000_000])
    expect(loggerErrors).toEqual([])
  })

  it("waits for the late-event grace window before invoicing an arrears statement", async () => {
    const logger = createLogger()
    const analytics = createAnalytics({ events: 1200 })
    const ledger = new LedgerGateway({ db, logger })
    const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()

    const common = {
      logger,
      db,
      repo: new DrizzleSubscriptionRepository(db),
      ratingService: new RatingService({
        logger,
        analytics,
        grantsManager: new GrantsManager({ db, logger }),
      }),
      ledgerService: ledger,
    }

    const tooEarly = await billPeriod({
      ...common,
      context: await loadSubscriptionContext(feb1 + LATE_EVENT_GRACE_MS - 1),
    })
    expect(tooEarly.phasesProcessed).toBe(0)

    const invoiceCountBeforeGrace = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
    `)
    expect(invoiceCountBeforeGrace.rows).toEqual([{ count: 0 }])
    expect(await listBillingPeriods()).toEqual([
      expect.objectContaining({ status: "pending" }),
      expect.objectContaining({ status: "pending" }),
    ])
    expect(analytics.getUsageBillingFeatures).not.toHaveBeenCalled()

    const ready = await billPeriod({
      ...common,
      context: await loadSubscriptionContext(feb1 + LATE_EVENT_GRACE_MS),
    })
    expect(ready.phasesProcessed).toBe(1)

    const invoiceCountAfterGrace = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
        AND statement_key = ${statementKey}
    `)
    expect(invoiceCountAfterGrace.rows).toEqual([{ count: 1 }])
    expect(await listBillingPeriods()).toEqual([
      expect.objectContaining({ status: "invoiced" }),
      expect.objectContaining({ status: "invoiced" }),
    ])
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })

  it("bills an annual DB statement as one yearly invoice with ledger-backed lines", async () => {
    const logger = createLogger()
    const analytics = createAnalytics({ events: 1200 })
    const ledger = new LedgerGateway({ db, logger })
    const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()

    await makeArrearSubscriptionAnnual()

    const billed = await billPeriod({
      context: await loadSubscriptionContext(nextYear + LATE_EVENT_GRACE_MS),
      logger,
      db,
      repo: new DrizzleSubscriptionRepository(db),
      ratingService: new RatingService({
        logger,
        analytics,
        grantsManager: new GrantsManager({ db, logger }),
      }),
      ledgerService: ledger,
    })
    expect(billed.phasesProcessed).toBe(1)

    const invoices = await db.execute<{
      statement_end_at_m: string
      statement_key: string
      statement_start_at_m: string
      gross_amount: string

      amount_due: string

      amount_paid: string

      amount_included: string
    }>(sql`
      SELECT statement_key, statement_start_at_m, statement_end_at_m, gross_amount, amount_due, amount_paid, amount_included
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
      ORDER BY statement_start_at_m
    `)
    expect(
      invoices.rows.map((invoice) => ({
        ...invoice,
        statement_end_at_m: Number(invoice.statement_end_at_m),
        statement_start_at_m: Number(invoice.statement_start_at_m),
        gross_amount: Number(invoice.gross_amount),

        amount_due: Number(invoice.amount_due),

        amount_paid: Number(invoice.amount_paid),

        amount_included: Number(invoice.amount_included),
      }))
    ).toEqual([
      {
        statement_end_at_m: nextYear,
        statement_key: annualStatementKey,
        statement_start_at_m: jan1,
        gross_amount: invoiceTotal,

        amount_due: invoiceTotal,

        amount_paid: 0,

        amount_included: 0,
      },
    ])

    const annualPeriods = await listBillingPeriods()
    expect(annualPeriods).toEqual([
      expect.objectContaining({
        cycle_end_at_m: nextYear,
        cycle_start_at_m: jan1,
        statement_key: annualStatementKey,
        status: "invoiced",
      }),
      expect.objectContaining({
        cycle_end_at_m: nextYear,
        cycle_start_at_m: jan1,
        statement_key: annualStatementKey,
        status: "invoiced",
      }),
    ])

    const lineAmounts = (
      await ledger.getInvoiceLines({ projectId, statementKey: annualStatementKey })
    ).val
      ?.map((line) => toLedgerMinor(line.amount))
      .sort((left, right) => left - right)
    expect(lineAmounts).toEqual([9_900_000_000, 12_000_000_000])
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })
})
