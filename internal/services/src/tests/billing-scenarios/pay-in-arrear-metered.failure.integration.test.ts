import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import { UnPriceLedgerError } from "../../ledger/errors"
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
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000

class FailingLedgerGateway extends LedgerGateway {
  private calls = 0

  constructor(
    opts: ConstructorParameters<typeof LedgerGateway>[0],
    private readonly failOnCall: number
  ) {
    super(opts)
  }

  override async createTransfer(
    ...args: Parameters<LedgerGateway["createTransfer"]>
  ): ReturnType<LedgerGateway["createTransfer"]> {
    this.calls += 1
    if (this.calls === this.failOnCall) {
      return Err(
        new UnPriceLedgerError({
          message: "LEDGER_TRANSFER_FAILED",
          context: { injected: true, failOnCall: this.failOnCall },
        })
      )
    }

    return super.createTransfer(...args)
  }
}

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

function createRatingService(logger: Logger) {
  return new RatingService({
    logger,
    analytics: createAnalytics({ events: 1200 }),
    grantsManager: new GrantsManager({ db, logger }),
  })
}

describe("P0-A pay_in_arrear metered billing failure injection", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("rolls back invoice and ledger state when a mid-transaction ledger write fails", async () => {
    const logger = createLogger()
    const failingLedger = new FailingLedgerGateway({ db, logger }, 2)
    const repo = new DrizzleSubscriptionRepository(db)
    const ensureAccounts = await failingLedger.ensureCustomerAccounts(customerId, "EUR")
    expect(ensureAccounts.err).toBeUndefined()

    await expect(
      billPeriod({
        context: await loadSubscriptionContext(),
        logger,
        db,
        repo,
        ratingService: createRatingService(logger),
        ledgerService: failingLedger,
      })
    ).rejects.toThrow("LEDGER_TRANSFER_FAILED")

    await expectNoPartialBillingState()

    const ledger = new LedgerGateway({ db, logger })
    const retry = await billPeriod({
      context: await loadSubscriptionContext(),
      logger,
      db,
      repo,
      ratingService: createRatingService(logger),
      ledgerService: ledger,
    })
    const rerun = await billPeriod({
      context: await loadSubscriptionContext(),
      logger,
      db,
      repo,
      ratingService: createRatingService(logger),
      ledgerService: ledger,
    })

    expect(retry.phasesProcessed).toBe(1)
    expect(rerun.phasesProcessed).toBe(0)
    await expectSuccessfulBillingState(ledger)
  })
})

async function expectNoPartialBillingState() {
  const invoices = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
  `)
  expect(invoices.rows).toEqual([{ count: 0 }])

  const periods = await db.execute<{ status: string; invoice_id: string | null }>(sql`
    SELECT status, invoice_id
    FROM unprice_billing_periods
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
    ORDER BY id
  `)
  expect(periods.rows).toEqual([
    { invoice_id: null, status: "pending" },
    { invoice_id: null, status: "pending" },
  ])

  const idempotency = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND statement_key = ${statementKey}
  `)
  expect(idempotency.rows).toEqual([{ count: 0 }])

  const entries = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM pgledger_entries_view e
    JOIN unprice_ledger_idempotency i ON i.transfer_id = e.transfer_id
    WHERE i.project_id = ${projectId}
      AND i.statement_key = ${statementKey}
  `)
  expect(entries.rows).toEqual([{ count: 0 }])
}

async function expectSuccessfulBillingState(ledger: LedgerGateway) {
  const invoices = await db.execute<{
    id: string
    status: "draft"
    total_amount: number
    statement_key: string
    statement_start_at_m: number
    statement_end_at_m: number
  }>(sql`
    SELECT id, status, total_amount, statement_key, statement_start_at_m, statement_end_at_m
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
  `)
  const invoiceRows = invoices.rows.map((invoice) => ({
    ...invoice,
    statement_end_at_m: Number(invoice.statement_end_at_m),
    statement_start_at_m: Number(invoice.statement_start_at_m),
    total_amount: Number(invoice.total_amount),
  }))
  expect(invoiceRows).toEqual([
    expect.objectContaining({
      status: "draft",
      statement_end_at_m: feb1,
      statement_key: statementKey,
      statement_start_at_m: jan1,
      total_amount: 21_900_000_000,
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
  expect(
    (ledgerLines.val ?? [])
      .map((line) => toLedgerMinor(line.amount))
      .sort((left, right) => left - right)
  ).toEqual([9_900_000_000, 12_000_000_000])

  const idempotency = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND statement_key = ${statementKey}
  `)
  expect(idempotency.rows).toEqual([{ count: 2 }])

  const entries = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM unprice_ledger_idempotency i
    JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
    WHERE i.project_id = ${projectId}
      AND i.statement_key = ${statementKey}
  `)
  expect(entries.rows).toEqual([{ count: 4 }])
}
