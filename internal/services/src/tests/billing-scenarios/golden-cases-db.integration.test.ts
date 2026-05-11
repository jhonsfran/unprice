import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { toLedgerMinor } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../../cache"
import { createServiceContext } from "../../context"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import type { Metrics } from "../../metrics"
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
const phaseId = "phase_test_monthly_arrear"
const statementKey = "stmt_test_arrear_2026_01"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000
const invoiceTotal = 21_900_000_000

function createLogger(errors: unknown[] = []): Logger {
  return {
    set: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((error: unknown) => {
      errors.push(error)
    }),
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
    ingestEvents: vi.fn(),
  } as unknown as Analytics
}

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
      total_amount: string
    }>(sql`
      SELECT id, status, total_amount, statement_key, statement_start_at_m, statement_end_at_m
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
        total_amount: Number(invoice.total_amount),
      }))
    ).toEqual([
      expect.objectContaining({
        statement_end_at_m: feb1,
        statement_key: statementKey,
        statement_start_at_m: jan1,
        status: "draft",
        total_amount: invoiceTotal,
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
})
