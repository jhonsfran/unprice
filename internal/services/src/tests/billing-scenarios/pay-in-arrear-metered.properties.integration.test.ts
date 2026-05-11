import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import * as fc from "fast-check"
import { afterAll, describe, expect, it, vi } from "vitest"
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
  "plan-monthly-arrear.sql",
  "customer-active.sql",
  "subscription-monthly-arrear-active.sql",
]

const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test_monthly_arrear"
const statementKey = "stmt_test_arrear_2026_01"
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000
const flatAccessAmount = 9_900_000_000
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

async function runBillingPropertyCase(usage: number) {
  await truncateTestDatabase(db)
  await seedTestDb({ db, fixtures })

  const logger = createLogger()
  const analytics = createAnalytics({ events: usage })
  const ledger = new LedgerGateway({ db, logger })
  const rating = new RatingService({
    logger,
    analytics,
    grantsManager: new GrantsManager({ db, logger }),
  })
  const repo = new DrizzleSubscriptionRepository(db)
  const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
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

  const expectedUsageAmount = expectedEventsAmount(usage)
  const expectedTotalAmount = flatAccessAmount + expectedUsageAmount

  expect(firstRun.phasesProcessed).toBe(1)
  expect(secondRun.phasesProcessed).toBe(0)

  const invoices = await db.execute<{
    id: string
    status: "draft"
    total_amount: number
    statement_key: string
  }>(sql`
    SELECT id, status, total_amount, statement_key
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
  `)
  const invoiceRows = invoices.rows.map((invoice) => ({
    ...invoice,
    total_amount: Number(invoice.total_amount),
  }))
  expect(invoiceRows).toHaveLength(1)
  expect(invoiceRows[0]).toEqual(
    expect.objectContaining({
      status: "draft",
      statement_key: statementKey,
      total_amount: expectedTotalAmount,
    })
  )

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
  const expectedLineAmounts =
    expectedUsageAmount > 0
      ? [flatAccessAmount, expectedUsageAmount].sort((left, right) => left - right)
      : [flatAccessAmount]
  expect(lineAmounts).toEqual(expectedLineAmounts)

  const idempotencyCount = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND statement_key = ${statementKey}
  `)
  expect(idempotencyCount.rows).toEqual([{ count: expectedUsageAmount > 0 ? 2 : 1 }])

  const entryCount = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency i
    JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
    WHERE i.project_id = ${projectId}
      AND i.statement_key = ${statementKey}
  `)
  expect(entryCount.rows).toEqual([{ count: expectedUsageAmount > 0 ? 4 : 2 }])
  expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
}

describe("P0-A pay_in_arrear metered billing properties", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  it("persists generated usage totals through invoice rows and pgledger entries", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 5_000 }), runBillingPropertyCase), {
      examples: [[0], [1], [1200], [5000]],
      numRuns: propertyRuns,
      seed: propertySeed,
    })
  })
})
