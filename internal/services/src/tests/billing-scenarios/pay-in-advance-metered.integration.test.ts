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
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { billPeriod } from "../../use-cases/billing/bill-period"

const db = createTestDatabaseConnection()

const fixtures = [
  "base-project.sql",
  "plan-monthly-advance.sql",
  "customer-active.sql",
  "subscription-monthly-advance-active.sql",
]

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_advance"
const startStatementKey = "stmt_test_advance_2026_01_start"
const usageStatementKey = "stmt_test_advance_2026_01_usage"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const advanceDueAt = jan1 + 15 * 60 * 1000
const usageDueAt = feb1 + 15 * 60 * 1000

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

async function loadSubscriptionContext(now: number): Promise<SubscriptionContext> {
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
    now,
    subscriptionId,
    projectId,
    subscription,
    customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
  }
}

describe("P0-C pay_in_advance metered billing workflow", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("P0-C bills fixed charges at period start and usage actuals at period end", async () => {
    const logger = createLogger()
    const analytics = createAnalytics({ events: 1200 })
    const ledger = new LedgerGateway({ db, logger })
    const rating = new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db, logger }),
    })
    const repo = new DrizzleSubscriptionRepository(db)
    const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()

    const startRun = await billPeriod({
      context: await loadSubscriptionContext(jan1),
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })
    expect(startRun.phasesProcessed).toBe(1)

    const invoicesAfterStart = await listInvoices()
    expect(invoicesAfterStart).toEqual([
      expect.objectContaining({
        due_at_m: advanceDueAt,
        statement_key: startStatementKey,
        total_amount: 9_900_000_000,
      }),
    ])

    const usageRun = await billPeriod({
      context: await loadSubscriptionContext(feb1),
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })
    const rerun = await billPeriod({
      context: await loadSubscriptionContext(feb1),
      logger,
      db,
      repo,
      ratingService: rating,
      ledgerService: ledger,
    })
    expect(usageRun.phasesProcessed).toBe(1)
    expect(rerun.phasesProcessed).toBe(0)

    const allInvoices = await listInvoices()
    expect(allInvoices).toEqual([
      expect.objectContaining({
        due_at_m: advanceDueAt,
        statement_end_at_m: feb1,
        statement_key: startStatementKey,
        statement_start_at_m: jan1,
        total_amount: 9_900_000_000,
      }),
      expect.objectContaining({
        due_at_m: usageDueAt,
        statement_end_at_m: feb1,
        statement_key: usageStatementKey,
        statement_start_at_m: jan1,
        total_amount: 12_000_000_000,
      }),
    ])

    const periods = await db.execute<{
      id: string
      status: "invoiced"
      invoice_id: string | null
      statement_key: string
    }>(sql`
      SELECT id, status, invoice_id, statement_key
      FROM unprice_billing_periods
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
      ORDER BY id
    `)
    expect(periods.rows).toEqual([
      expect.objectContaining({
        id: "bp_test_advance_access_jan",
        invoice_id: expect.any(String),
        statement_key: startStatementKey,
        status: "invoiced",
      }),
      expect.objectContaining({
        id: "bp_test_advance_events_jan",
        invoice_id: expect.any(String),
        statement_key: usageStatementKey,
        status: "invoiced",
      }),
    ])

    await expectInvoiceLineAmounts(startStatementKey, [9_900_000_000])
    await expectInvoiceLineAmounts(usageStatementKey, [12_000_000_000])

    const idempotency = await db.execute<{ statement_key: string; source_id: string }>(sql`
      SELECT statement_key, source_id
      FROM unprice_ledger_idempotency
      WHERE project_id = ${projectId}
        AND statement_key IN (${startStatementKey}, ${usageStatementKey})
      ORDER BY statement_key, source_id
    `)
    expect(idempotency.rows).toEqual([
      {
        source_id: "bp_test_advance_access_jan:item_test_advance_access",
        statement_key: startStatementKey,
      },
      {
        source_id: "bp_test_advance_events_jan:item_test_advance_events",
        statement_key: usageStatementKey,
      },
    ])

    const entryCount = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_ledger_idempotency i
      JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
      WHERE i.project_id = ${projectId}
        AND i.statement_key IN (${startStatementKey}, ${usageStatementKey})
    `)
    expect(entryCount.rows).toEqual([{ count: 4 }])
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })
})

async function listInvoices() {
  const invoices = await db.execute<{
    due_at_m: number
    statement_end_at_m: number
    statement_key: string
    statement_start_at_m: number
    total_amount: number
  }>(sql`
    SELECT due_at_m, statement_end_at_m, statement_key, statement_start_at_m, total_amount
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
    ORDER BY statement_key
  `)

  return invoices.rows.map((invoice) => ({
    ...invoice,
    due_at_m: Number(invoice.due_at_m),
    statement_end_at_m: Number(invoice.statement_end_at_m),
    statement_start_at_m: Number(invoice.statement_start_at_m),
    total_amount: Number(invoice.total_amount),
  }))
}

async function expectInvoiceLineAmounts(statementKey: string, expectedAmounts: number[]) {
  const ledger = new LedgerGateway({ db, logger: createLogger() })
  const lines = await ledger.getInvoiceLines({ projectId, statementKey })
  expect(lines.err).toBeUndefined()
  expect(
    (lines.val ?? []).map((line) => toLedgerMinor(line.amount)).sort((left, right) => left - right)
  ).toEqual(expectedAmounts)
}
