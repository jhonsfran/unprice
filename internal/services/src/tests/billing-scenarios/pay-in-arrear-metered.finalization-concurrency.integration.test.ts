import type { Analytics } from "@unprice/analytics"
import { type Database, sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BillingService } from "../../billing/service"
import type { Cache } from "../../cache"
import type { CustomerService } from "../../customers/service"
import { GrantsManager } from "../../entitlements/grants"
import { LedgerGateway } from "../../ledger"
import type { Metrics } from "../../metrics"
import type { PaymentProviderService } from "../../payment-provider/service"
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
import type { WalletService } from "../../wallet"

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
const finalizeNow = billableNow + 60 * 1000

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

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
  } as unknown as Analytics
}

class ConcurrentPaymentProvider {
  readonly providerInvoiceId = "provider_inv_concurrent"
  readonly providerInvoiceUrl = "https://provider.example/invoices/provider_inv_concurrent"
  readonly items: Array<{ id: string; amount: number; currency: "EUR"; quantity: number }> = []

  createInvoice = vi.fn(async () => {
    await delay(100)
    return Ok({
      invoiceId: this.providerInvoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      status: "draft" as const,
      total: 0,
      items: [],
    })
  })

  addInvoiceItem = vi.fn(
    async ({
      totalAmount,
      currency,
      quantity,
    }: {
      totalAmount: number
      currency: "EUR"
      quantity: number
    }) => {
      this.items.push({
        id: `provider_item_${this.items.length + 1}`,
        amount: totalAmount,
        currency,
        quantity,
      })
      return Ok(undefined)
    }
  )

  updateInvoiceItem = vi.fn(async () => Ok(undefined))

  finalizeInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) =>
    Ok({ invoiceId: invoiceId })
  )

  getInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) =>
    Ok({
      invoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      status: "open" as const,
      total: this.items.reduce((sum, item) => sum + item.amount, 0),
      items: this.items.map((item) => ({
        ...item,
        description: "Provider item",
        productId: item.id,
        metadata: {},
      })),
    })
  )
}

async function loadSubscriptionContext(dbForContext: Database): Promise<SubscriptionContext> {
  const subscription = (await dbForContext.query.subscriptions.findFirst({
    where: (table, ops) =>
      ops.and(ops.eq(table.projectId, projectId), ops.eq(table.id, subscriptionId)),
  })) as Subscription | undefined
  const customer = (await dbForContext.query.customers.findFirst({
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

async function createDraftInvoice() {
  const logger = createLogger()
  const ledger = new LedgerGateway({ db, logger })
  const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
  expect(ensureAccounts.err).toBeUndefined()

  await billPeriod({
    context: await loadSubscriptionContext(db),
    logger,
    db,
    repo: new DrizzleSubscriptionRepository(db),
    ratingService: new RatingService({
      logger,
      analytics: createAnalytics({ events: 1200 }),
      grantsManager: new GrantsManager({ db, logger }),
    }),
    ledgerService: ledger,
  })

  const invoices = await db.execute<{ id: string }>(sql`
    SELECT id
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
      AND statement_key = ${statementKey}
  `)

  const invoiceId = invoices.rows[0]?.id
  if (!invoiceId) {
    throw new Error("Expected billPeriod to create a draft invoice")
  }

  return invoiceId
}

function createBillingService(
  dbForWorker: Database,
  provider: ConcurrentPaymentProvider,
  errors: unknown[]
) {
  const logger = createLogger(errors)
  const analytics = createAnalytics({ events: 1200 })
  const ledger = new LedgerGateway({ db: dbForWorker, logger })

  return new BillingService({
    db: dbForWorker,
    logger,
    analytics,
    waitUntil: (promise) => {
      void promise
    },
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService: {
      getPaymentProvider: vi
        .fn()
        .mockResolvedValue(Ok(provider as unknown as PaymentProviderService)),
      validatePaymentMethod: vi.fn().mockResolvedValue(
        Ok({
          paymentMethodId: null,
          requiredPaymentMethod: false,
        })
      ),
    } as unknown as CustomerService,
    grantsManager: new GrantsManager({ db: dbForWorker, logger }),
    ratingService: new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db: dbForWorker, logger }),
    }),
    ledgerService: ledger,
    walletService: {} as WalletService,
  })
}

describe("P0-A pay_in_arrear metered invoice finalization concurrency", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("serializes concurrent finalization into one provider invoice and one local status flip", async () => {
    const invoiceId = await createDraftInvoice()
    const provider = new ConcurrentPaymentProvider()
    const loggedErrors: unknown[] = []
    const workerDbs = Array.from({ length: 4 }, () => createTestDatabaseConnection())

    try {
      const results = await Promise.allSettled(
        workerDbs.map((workerDb) =>
          createBillingService(workerDb, provider, loggedErrors).finalizeInvoice({
            projectId,
            subscriptionId,
            invoiceId,
            now: finalizeNow,
          })
        )
      )

      for (const result of results) {
        expect(result.status).toBe("fulfilled")
      }

      const fulfilled = results.map((result) => {
        if (result.status === "rejected") throw result.reason
        return result.value
      })
      const resultMessages = fulfilled.map((result) => result.err?.message ?? "ok")
      expect(loggedErrors).toEqual([])
      expect(resultMessages).toContain("ok")
      const successful = fulfilled.filter((result) => result.err === undefined)
      expect(successful.length).toBeGreaterThanOrEqual(1)
      expect(provider.createInvoice).toHaveBeenCalledTimes(1)
      expect(provider.addInvoiceItem).toHaveBeenCalledTimes(2)
      expect(provider.finalizeInvoice).toHaveBeenCalledTimes(1)

      const invoices = await db.execute<{
        status: string
        invoice_payment_provider_id: string | null
        invoice_payment_provider_url: string | null
      }>(sql`
        SELECT status, invoice_payment_provider_id, invoice_payment_provider_url
        FROM unprice_invoices
        WHERE project_id = ${projectId}
          AND id = ${invoiceId}
      `)
      expect(invoices.rows).toEqual([
        {
          invoice_payment_provider_id: provider.providerInvoiceId,
          invoice_payment_provider_url: provider.providerInvoiceUrl,
          status: "unpaid",
        },
      ])

      const lockRows = await db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM unprice_subscription_locks
        WHERE project_id = ${projectId}
          AND subscription_id = ${subscriptionId}
      `)
      expect(lockRows.rows).toEqual([{ count: 0 }])
    } finally {
      await Promise.all(workerDbs.map((workerDb) => closeTestDatabaseConnection(workerDb)))
    }
  })
})
