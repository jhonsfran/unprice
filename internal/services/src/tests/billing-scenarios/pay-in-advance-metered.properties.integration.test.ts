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

function expectedEventsAmount(usage: number) {
  if (usage <= 0) return 0

  // The seeded advance plan uses volume tiers:
  // 1..1000 => 1 EUR flat + 0.001 EUR/unit, 1001+ => 0.10 EUR/unit.
  if (usage <= 1000) {
    return 100_000_000 + usage * 100_000
  }

  return usage * 10_000_000
}

async function runAdvanceMeteredPropertyCase(usage: number) {
  await truncateTestDatabase(db)
  await seedTestDb({ db, fixtures })

  const expectedUsageAmount = expectedEventsAmount(usage)
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

  const startRun = await billPeriod({
    context: await loadSubscriptionContext(jan1),
    logger,
    db,
    repo,
    ratingService: rating,
    ledgerService: ledger,
  })
  expect(startRun.phasesProcessed).toBe(1)
  expect(await listInvoices()).toEqual([
    expect.objectContaining({
      due_at_m: advanceDueAt,
      statement_key: startStatementKey,
      gross_amount: flatAccessAmount,

      amount_due: flatAccessAmount,

      amount_paid: 0,

      amount_included: 0,
    }),
  ])
  await expectInvoiceLineAmounts(ledger, startStatementKey, [flatAccessAmount])

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

  expect(await listInvoices()).toEqual([
    expect.objectContaining({
      due_at_m: advanceDueAt,
      statement_end_at_m: feb1,
      statement_key: startStatementKey,
      statement_start_at_m: jan1,
      gross_amount: flatAccessAmount,

      amount_due: flatAccessAmount,

      amount_paid: 0,

      amount_included: 0,
    }),
    expect.objectContaining({
      due_at_m: usageDueAt,
      statement_end_at_m: feb1,
      statement_key: usageStatementKey,
      statement_start_at_m: jan1,
      gross_amount: expectedUsageAmount,

      amount_due: expectedUsageAmount,

      amount_paid: 0,

      amount_included: 0,
    }),
  ])
  await expectPeriodsInvoiced()
  await expectInvoiceLineAmounts(ledger, usageStatementKey, [expectedUsageAmount])
  await expectLedgerState()
  expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
}

describe("P0-C pay_in_advance metered billing properties", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  it("keeps generated usage actuals separate from start-of-period fixed billing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5_000 }), runAdvanceMeteredPropertyCase),
      {
        examples: [[1], [1000], [1001], [1200], [5000]],
        numRuns: propertyRuns,
        seed: propertySeed,
      }
    )
  })
})

async function listInvoices() {
  const invoices = await db.execute<{
    due_at_m: number
    statement_end_at_m: number
    statement_key: string
    statement_start_at_m: number
    gross_amount: number

    amount_due: number

    amount_paid: number

    amount_included: number
  }>(sql`
    SELECT due_at_m, statement_end_at_m, statement_key, statement_start_at_m, gross_amount, amount_due, amount_paid, amount_included
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
    gross_amount: Number(invoice.gross_amount),

    amount_due: Number(invoice.amount_due),

    amount_paid: Number(invoice.amount_paid),

    amount_included: Number(invoice.amount_included),
  }))
}

async function expectPeriodsInvoiced() {
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
}

async function expectInvoiceLineAmounts(
  ledger: LedgerGateway,
  statementKey: string,
  expectedAmounts: number[]
) {
  const lines = await ledger.getInvoiceLines({ projectId, statementKey })
  expect(lines.err).toBeUndefined()
  expect(
    (lines.val ?? []).map((line) => toLedgerMinor(line.amount)).sort((left, right) => left - right)
  ).toEqual(expectedAmounts.sort((left, right) => left - right))
}

async function expectLedgerState() {
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
}
