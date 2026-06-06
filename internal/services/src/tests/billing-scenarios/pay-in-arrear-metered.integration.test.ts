import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import { RatingService } from "../../rating/service"
import { DrizzleSubscriptionRepository } from "../../subscriptions/repository.drizzle"
import type { SubscriptionContext } from "../../subscriptions/types"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
} from "../../test-fixtures/database"
import { truncateTestDatabase } from "../../test-fixtures/database"
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
const statementKey = "stmt_test_arrear_2026_01"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000

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

describe("P0-A pay_in_arrear metered billing workflow", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("P0-A rates pending periods, posts pgledger entries, creates one invoice, and is idempotent", async () => {
    const logger = createLogger()
    const analytics = createAnalytics({ events: 1200 })
    const ledger = new LedgerGateway({ db, logger })
    const rating = new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db, logger }),
    })
    const repo = new DrizzleSubscriptionRepository(db)
    const ensureAccounts = await ledger.ensureCustomerAccounts("cus_test", "EUR")
    expect(ensureAccounts.err).toBeUndefined()

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

    const invoices = await db.execute<{
      id: string
      status: "draft"
      gross_amount: number

      amount_due: number

      amount_paid: number

      amount_included: number
      statement_key: string
      statement_start_at_m: number
      statement_end_at_m: number
    }>(sql`
      SELECT id, status, gross_amount, amount_due, amount_paid, amount_included, statement_key, statement_start_at_m, statement_end_at_m
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
        AND customer_id = ${customerId}
    `)
    const invoiceRows = invoices.rows.map((invoice) => ({
      ...invoice,
      statement_end_at_m: Number(invoice.statement_end_at_m),
      statement_start_at_m: Number(invoice.statement_start_at_m),
      gross_amount: Number(invoice.gross_amount),

      amount_due: Number(invoice.amount_due),

      amount_paid: Number(invoice.amount_paid),

      amount_included: Number(invoice.amount_included),
    }))
    expect(invoiceRows).toEqual([
      expect.objectContaining({
        status: "draft",
        statement_end_at_m: feb1,
        statement_key: statementKey,
        statement_start_at_m: jan1,
        gross_amount: 21_900_000_000,

        amount_due: 21_900_000_000,

        amount_paid: 0,

        amount_included: 0,
      }),
    ])
    const invoiceId = invoiceRows[0]?.id
    expect(invoiceId).toBeDefined()

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

    const ledgerLines = await ledger.getInvoiceLines({ projectId, statementKey })
    expect(ledgerLines.err).toBeUndefined()
    const lineAmounts = (ledgerLines.val ?? [])
      .map((line) => toLedgerMinor(line.amount))
      .sort((left, right) => left - right)
    expect(lineAmounts).toEqual([9_900_000_000, 12_000_000_000])

    const idempotency = await db.execute<{ source_type: string; source_id: string }>(sql`
      SELECT source_type, source_id
      FROM unprice_ledger_idempotency
      WHERE project_id = ${projectId}
        AND statement_key = ${statementKey}
      ORDER BY source_id
    `)
    expect(idempotency.rows).toEqual([
      {
        source_id: "bp_test_arrear_access_jan:item_test_arrear_access",
        source_type: "subscription_billing_period_charge_v1",
      },
      {
        source_id: "bp_test_arrear_events_jan:item_test_arrear_events",
        source_type: "subscription_billing_period_charge_v1",
      },
    ])

    const entryCount = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_ledger_idempotency i
      JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
      WHERE i.project_id = ${projectId}
        AND i.statement_key = ${statementKey}
    `)
    expect(entryCount.rows).toEqual([{ count: 4 }])
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })
})
