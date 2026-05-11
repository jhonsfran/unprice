import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../../cache"
import { type ServiceContext, createServiceContext } from "../../context"
import type { Metrics } from "../../metrics"
import { DrizzleSubscriptionRepository } from "../../subscriptions/repository.drizzle"
import { SubscriptionService } from "../../subscriptions/service"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../../test-fixtures/database"
import { seedTestDb } from "../../test-fixtures/seed-db"
import { UnPriceWalletError, type WalletService } from "../../wallet"

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
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const creditLineAmount = 12_000_000_000

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

function createAnalytics(): Analytics {
  return {
    getUsageBillingFeatures: vi.fn(async () => Ok([])),
    ingestEvents: vi.fn(),
  } as unknown as Analytics
}

function createCache(): Cache {
  const acl = new Map<string, unknown>()
  return {
    accessControlList: {
      get: vi.fn(async (key: string) => Ok(acl.get(key) ?? null)),
      remove: vi.fn(async (key: string) => {
        acl.delete(key)
      }),
      set: vi.fn(async (key: string, value: unknown) => {
        acl.set(key, value)
      }),
    },
  } as unknown as Cache
}

function createServices() {
  const logger = createLogger()
  const analytics = createAnalytics()
  const cache = createCache()
  const metrics = {} as Metrics
  const waitUntil = vi.fn()
  const services = createServiceContext({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  })

  return { analytics, cache, logger, metrics, services, waitUntil }
}

function createSubscriptionServiceWithWallet(input: {
  base: ServiceContext
  logger: Logger
  analytics: Analytics
  cache: Cache
  metrics: Metrics
  waitUntil: (promise: Promise<unknown>) => void
  wallet: WalletService
}) {
  return new SubscriptionService({
    db,
    repo: new DrizzleSubscriptionRepository(db),
    logger: input.logger,
    analytics: input.analytics,
    waitUntil: input.waitUntil,
    cache: input.cache,
    metrics: input.metrics,
    customerService: input.base.customers,
    entitlementService: input.base.entitlements,
    billingService: input.base.billing,
    ratingService: input.base.rating,
    ledgerService: input.base.ledger,
    walletService: input.wallet,
  })
}

function walletWithFirstAdjustFailure(realWallet: WalletService) {
  type AdjustArgs = Parameters<WalletService["adjust"]>
  type AdjustReturn = ReturnType<WalletService["adjust"]>

  let failuresRemaining = 1
  const adjust = vi.fn((...args: AdjustArgs): AdjustReturn => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      return Promise.resolve(
        Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" }))
      ) as AdjustReturn
    }

    return realWallet.adjust(...args)
  })

  return new Proxy(realWallet, {
    get(target, prop, receiver) {
      if (prop === "adjust") return adjust
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as WalletService & { adjust: typeof adjust }
}

async function loadSubscriptionRow() {
  const result = await db.execute<{
    active: boolean
    current_cycle_end_at_m: string
    current_cycle_start_at_m: string
    renew_at_m: string
    status: string
  }>(sql`
    SELECT status, active, current_cycle_start_at_m, current_cycle_end_at_m, renew_at_m
    FROM unprice_subscriptions
    WHERE project_id = ${projectId}
      AND id = ${subscriptionId}
  `)

  const row = result.rows[0]
  if (!row) throw new Error("Subscription row missing")

  return {
    ...row,
    current_cycle_end_at_m: Number(row.current_cycle_end_at_m),
    current_cycle_start_at_m: Number(row.current_cycle_start_at_m),
    renew_at_m: Number(row.renew_at_m),
  }
}

async function waitForSubscriptionStatus(status: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await loadSubscriptionRow()
    if (row.status === status) return row
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  return loadSubscriptionRow()
}

async function listWalletCredits() {
  const result = await db.execute<{
    expires_at: Date
    issued_amount: string
    remaining_amount: string
    source: string
  }>(sql`
    SELECT source, issued_amount, remaining_amount, expires_at
    FROM unprice_wallet_credits
    WHERE project_id = ${projectId}
      AND customer_id = ${customerId}
    ORDER BY created_at, id
  `)

  return result.rows.map((row) => ({
    ...row,
    expires_at: new Date(row.expires_at).getTime(),
    issued_amount: Number(row.issued_amount),
    remaining_amount: Number(row.remaining_amount),
  }))
}

describe("subscription renewal and wallet activation DB lifecycle", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
  })

  it("renews the subscription cycle and issues the next period wallet credit line once", async () => {
    const { services } = createServices()

    const renewed = await services.subscriptions.renewSubscription({
      subscriptionId,
      projectId,
      now: feb1 + 1,
    })
    expect(renewed.err).toBeUndefined()
    expect(renewed.val).toEqual({ status: "active" })

    const subscription = await waitForSubscriptionStatus("active")
    expect(subscription).toMatchObject({
      active: true,
      current_cycle_end_at_m: mar1,
      current_cycle_start_at_m: feb1,
      renew_at_m: mar1,
      status: "active",
    })

    expect(await listWalletCredits()).toEqual([
      {
        expires_at: mar1,
        issued_amount: creditLineAmount,
        remaining_amount: creditLineAmount,
        source: "credit_line",
      },
    ])

    const reactivated = await services.subscriptions.activateWallet({
      subscriptionId,
      projectId,
      now: feb1 + 1,
    })
    expect(reactivated).not.toBeNull()
    if (!reactivated) return
    expect(reactivated.err).toBeUndefined()
    expect(await listWalletCredits()).toHaveLength(1)

    const invoiceCount = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
    `)
    expect(invoiceCount.rows).toEqual([{ count: 0 }])

    const ledgerRows = await db.execute<{ count: number; source_type: string }>(sql`
      SELECT source_type, COUNT(*)::int AS count
      FROM unprice_ledger_idempotency
      WHERE project_id = ${projectId}
      GROUP BY source_type
      ORDER BY source_type
    `)
    expect(ledgerRows.rows).toEqual([{ count: 1, source_type: "wallet_adjust" }])
  })

  it("parks failed wallet activation in pending_activation and retries without duplicate credits", async () => {
    const { analytics, cache, logger, metrics, services, waitUntil } = createServices()
    const failingWallet = walletWithFirstAdjustFailure(services.wallet)
    const subscriptions = createSubscriptionServiceWithWallet({
      base: services,
      logger,
      analytics,
      cache,
      metrics,
      waitUntil,
      wallet: failingWallet,
    })

    const failed = await subscriptions.activateWallet({
      subscriptionId,
      projectId,
      now: jan1 + 1,
    })
    expect(failed).not.toBeNull()
    if (!failed) return
    expect(failed.err?.message).toBe(
      "Wallet activation failed; subscription parked in pending_activation"
    )
    expect(await waitForSubscriptionStatus("pending_activation")).toMatchObject({
      active: true,
      status: "pending_activation",
    })
    expect(await listWalletCredits()).toEqual([])

    const retry = await subscriptions.activateWallet({
      subscriptionId,
      projectId,
      now: jan1 + 1,
    })
    expect(retry).not.toBeNull()
    if (!retry) return
    expect(retry.err).toBeUndefined()
    expect(retry.val).toEqual({ status: "active" })
    expect(await waitForSubscriptionStatus("active")).toMatchObject({
      active: true,
      status: "active",
    })
    expect(await listWalletCredits()).toEqual([
      {
        expires_at: feb1,
        issued_amount: creditLineAmount,
        remaining_amount: creditLineAmount,
        source: "credit_line",
      },
    ])

    const replay = await subscriptions.activateWallet({
      subscriptionId,
      projectId,
      now: jan1 + 1,
    })
    expect(replay).not.toBeNull()
    if (!replay) return
    expect(replay.err).toBeUndefined()
    expect(await listWalletCredits()).toHaveLength(1)
    expect(failingWallet.adjust).toHaveBeenCalledTimes(3)
  })
})
