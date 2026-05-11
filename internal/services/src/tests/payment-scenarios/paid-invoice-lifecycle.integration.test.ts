import type { Analytics } from "@unprice/analytics"
import { sql } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BillingService } from "../../billing/service"
import type { Cache } from "../../cache"
import { type ServiceContext, createServiceContext } from "../../context"
import type { CustomerService } from "../../customers/service"
import { GrantsManager } from "../../entitlements/grants"
import { type LedgerGateway, customerAccountKeys, platformAccountKey } from "../../ledger"
import type { Metrics } from "../../metrics"
import type {
  AddInvoiceItemOpts,
  NormalizedProviderWebhook,
  NormalizedWebhookEventType,
  PaymentProviderInvoice,
  VerifiedProviderWebhook,
} from "../../payment-provider/interface"
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
import { processWebhookEvent } from "../../use-cases/payment-provider/process-webhook-event"
import { UnPriceWalletError, type WalletService } from "../../wallet"

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
const subscriptionPhaseId = "phase_test_monthly_arrear"
const statementKey = "stmt_test_arrear_2026_01"
const paymentMethodId = "pm_test_card"
const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const billableNow = feb1 + 60 * 60 * 1000
const finalizeNow = billableNow + 60 * 1000
const collectNow = finalizeNow + 60 * 1000
const webhookPaidAt = collectNow + 30 * 1000
const webhookProcessedAt = webhookPaidAt + 5 * 1000
const webhookRetryProcessedAt = webhookProcessedAt + 60 * 1000
const webhookFailedAt = collectNow + 45 * 1000
const webhookFailedProcessedAt = webhookFailedAt + 5 * 1000
const webhookReversedAt = webhookPaidAt + 60 * 1000
const webhookReversedProcessedAt = webhookReversedAt + 5 * 1000
const webhookDisputeReversedAt = webhookReversedAt + 60 * 1000
const webhookDisputeReversedProcessedAt = webhookDisputeReversedAt + 5 * 1000
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function parseWebhookBody(rawBody: string): { id: string; type: string; payload: unknown } {
  const payload: unknown = JSON.parse(rawBody)
  if (typeof payload !== "object" || payload === null) {
    return { id: "evt_paid_lifecycle", type: "invoice.paid", payload }
  }

  const id = "id" in payload && typeof payload.id === "string" ? payload.id : "evt_paid_lifecycle"
  const type = "type" in payload && typeof payload.type === "string" ? payload.type : "invoice.paid"

  return { id, type, payload }
}

function webhookOccurredAt(providerEventType: string): number {
  switch (providerEventType) {
    case "invoice.payment_failed":
      return webhookFailedAt
    case "charge.refunded":
      return webhookReversedAt
    case "charge.dispute.funds_reinstated":
      return webhookDisputeReversedAt
    default:
      return webhookPaidAt
  }
}

function normalizeProviderEventType(providerEventType: string): NormalizedWebhookEventType {
  switch (providerEventType) {
    case "invoice.payment_failed":
      return "payment.failed"
    case "charge.refunded":
      return "payment.reversed"
    case "charge.dispute.funds_reinstated":
      return "payment.dispute_reversed"
    default:
      return "payment.succeeded"
  }
}

function failureMessage(providerEventType: string): string | undefined {
  switch (providerEventType) {
    case "invoice.payment_failed":
      return "Card declined"
    case "charge.refunded":
      return "Charge refunded"
    default:
      return undefined
  }
}

class AsyncWebhookPaymentProvider {
  readonly provider = "sandbox" as const
  readonly capabilities = {
    billingPortal: true,
    savedPaymentMethods: true,
    invoiceItemMutation: true,
    asyncPaymentConfirmation: true,
    webhookSetup: "manual" as const,
  }
  readonly providerInvoiceId = "provider_inv_lifecycle"
  readonly providerInvoiceUrl = "https://provider.example/invoices/provider_inv_lifecycle"
  readonly items: PaymentProviderInvoice["items"] = []
  private providerCustomerId: string | undefined = "provider_cus_lifecycle"

  getCustomerId = vi.fn(() => this.providerCustomerId)

  setCustomerId = vi.fn((customerId: string) => {
    this.providerCustomerId = customerId
  })

  getSession = vi.fn(async () =>
    Ok({
      customerId: this.providerCustomerId ?? "provider_cus_lifecycle",
      metadata: {},
      subscriptionId: null,
    })
  )

  createSession = vi.fn(async () =>
    Ok({
      customerId: this.providerCustomerId ?? "provider_cus_lifecycle",
      success: true,
      url: "https://provider.example/session",
    })
  )

  signUp = vi.fn(async () =>
    Ok({
      customerId: this.providerCustomerId ?? "provider_cus_lifecycle",
      sessionId: "sess_lifecycle",
      success: true,
      url: "https://provider.example/session",
    })
  )

  listPaymentMethods = vi.fn(async () =>
    Ok([
      {
        brand: "visa",
        expMonth: 12,
        expYear: 2030,
        id: paymentMethodId,
        last4: "4242",
        name: "Visa ending in 4242",
      },
    ])
  )

  getDefaultPaymentMethodId = vi.fn(async () => Ok({ paymentMethodId }))

  createInvoice = vi.fn(async () =>
    Ok({
      invoiceId: this.providerInvoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      items: [],
      status: "draft" as const,
      total: 0,
    })
  )

  addInvoiceItem = vi.fn(async (opts: AddInvoiceItemOpts) => {
    this.items.push({
      amount: opts.totalAmount,
      currency: opts.currency,
      description: opts.description ?? opts.name,
      id: `provider_item_${this.items.length + 1}`,
      metadata: opts.metadata,
      productId: opts.productId ?? "",
      quantity: opts.quantity,
    })
    return Ok(undefined)
  })

  updateInvoiceItem = vi.fn(async () => Ok(undefined))

  finalizeInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) => Ok({ invoiceId }))

  sendInvoice = vi.fn(async () => Ok(undefined))

  updateInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) =>
    Ok(this.providerInvoice(invoiceId, "draft"))
  )

  getInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) =>
    Ok(this.providerInvoice(invoiceId, "open"))
  )

  getStatusInvoice = vi.fn(async ({ invoiceId }: { invoiceId: string }) =>
    Ok({
      invoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      paymentAttempts: [],
      status: "open" as const,
    })
  )

  collectPayment = vi.fn(async ({ invoiceId }: { invoiceId: string; paymentMethodId: string }) =>
    Ok({
      invoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      status: "open" as const,
    })
  )

  verifyWebhook = vi.fn(async ({ rawBody }: { rawBody: string }) => {
    const parsed = parseWebhookBody(rawBody)
    return Ok({
      eventId: parsed.id,
      eventType: parsed.type,
      occurredAt: webhookOccurredAt(parsed.type),
      payload: parsed.payload,
    })
  })

  normalizeWebhook = vi.fn((event: VerifiedProviderWebhook) =>
    Ok({
      customerId,
      eventId: event.eventId,
      eventType: normalizeProviderEventType(event.eventType),
      failureMessage: failureMessage(event.eventType),
      invoiceId: this.providerInvoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      occurredAt: event.occurredAt,
      payload: event.payload,
      provider: this.provider,
      providerEventType: event.eventType,
      subscriptionId,
    } satisfies NormalizedProviderWebhook)
  )

  private providerInvoice(invoiceId: string, status: PaymentProviderInvoice["status"]) {
    return {
      invoiceId,
      invoiceUrl: this.providerInvoiceUrl,
      items: this.items,
      status,
      total: this.items.reduce((sum, item) => sum + item.amount, 0),
    }
  }
}

async function enableAsyncCollectionFixture() {
  await db.execute(sql`
    UPDATE unprice_subscription_phases
    SET payment_method_id = ${paymentMethodId},
        updated_at_m = ${jan1}
    WHERE project_id = ${projectId}
      AND id = ${subscriptionPhaseId}
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
    paymentMethodId,
    requiredPaymentMethod: false,
    currentPhase: null,
  }
}

async function createDraftInvoice({
  analytics,
  ledger,
  logger,
}: {
  analytics: Analytics
  ledger: LedgerGateway
  logger: Logger
}) {
  const ensureAccounts = await ledger.ensureCustomerAccounts(customerId, "EUR")
  expect(ensureAccounts.err).toBeUndefined()

  const rating = new RatingService({
    logger,
    analytics,
    grantsManager: new GrantsManager({ db, logger }),
  })

  const result = await billPeriod({
    context: await loadSubscriptionContext(),
    logger,
    db,
    repo: new DrizzleSubscriptionRepository(db),
    ratingService: rating,
    ledgerService: ledger,
  })
  expect(result.phasesProcessed).toBe(1)

  const invoices = await db.execute<{ id: string; total_amount: number }>(sql`
    SELECT id, total_amount
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND subscription_id = ${subscriptionId}
      AND customer_id = ${customerId}
      AND statement_key = ${statementKey}
  `)

  const invoice = invoices.rows[0]
  if (!invoice) {
    throw new Error("Expected billPeriod to create a draft invoice")
  }

  expect(Number(invoice.total_amount)).toBe(invoiceTotal)
  return invoice.id
}

function customerServiceFor(provider: AsyncWebhookPaymentProvider): CustomerService {
  return {
    getPaymentProvider: vi
      .fn()
      .mockResolvedValue(Ok(provider as unknown as PaymentProviderService)),
    validatePaymentMethod: vi.fn().mockResolvedValue(
      Ok({
        paymentMethodId,
        requiredPaymentMethod: false,
      })
    ),
  } as unknown as CustomerService
}

function createBillingService({
  analytics,
  ledger,
  logger,
  provider,
  wallet,
}: {
  analytics: Analytics
  ledger: LedgerGateway
  logger: Logger
  provider: AsyncWebhookPaymentProvider
  wallet: WalletService
}) {
  return new BillingService({
    db,
    logger,
    analytics,
    waitUntil: (promise) => {
      void promise
    },
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService: customerServiceFor(provider),
    grantsManager: new GrantsManager({ db, logger }),
    ratingService: new RatingService({
      logger,
      analytics,
      grantsManager: new GrantsManager({ db, logger }),
    }),
    ledgerService: ledger,
    walletService: wallet,
  })
}

function walletWithFirstSettlementFailure(realWallet: WalletService) {
  type SettleReceivableArgs = Parameters<WalletService["settleReceivable"]>
  type SettleReceivableReturn = ReturnType<WalletService["settleReceivable"]>

  let failuresRemaining = 1
  const settleReceivable = vi.fn((...args: SettleReceivableArgs): SettleReceivableReturn => {
    if (failuresRemaining > 0) {
      failuresRemaining -= 1
      return Promise.resolve(
        Err(new UnPriceWalletError({ message: "WALLET_LEDGER_FAILED" }))
      ) as SettleReceivableReturn
    }

    return realWallet.settleReceivable(...args)
  })

  const wallet = new Proxy(realWallet, {
    get(target, prop, receiver) {
      if (prop === "settleReceivable") {
        return settleReceivable
      }

      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as WalletService & { settleReceivable: typeof settleReceivable }

  return wallet
}

async function getAccountBalance(accountName: string) {
  const result = await db.execute<{ balance: string }>(sql`
    SELECT balance
    FROM pgledger_accounts_view
    WHERE name = ${accountName}
    LIMIT 1
  `)
  return result.rows[0]?.balance ?? null
}

async function expectSettlementRows(invoiceId: string, expectedCount: number) {
  const rows = await db.execute<{
    source_id: string
    source_type: string
    statement_key: string | null
  }>(sql`
    SELECT source_type, source_id, statement_key
    FROM unprice_ledger_idempotency
    WHERE project_id = ${projectId}
      AND source_type = 'wallet_settle_receivable'
    ORDER BY source_id
  `)

  if (expectedCount === 0) {
    expect(rows.rows).toEqual([])
    return
  }

  expect(rows.rows).toEqual([
    {
      source_id: `invoice_receivable:${invoiceId}`,
      source_type: "wallet_settle_receivable",
      statement_key: null,
    },
  ])
}

async function expectWebhookEvent({
  attempts,
  processedAt,
  providerEventId,
  status,
}: {
  attempts: number
  processedAt: number
  providerEventId: string
  status: "failed" | "processed"
}) {
  const webhookEvents = await db.execute<{
    attempts: number
    error_payload: { message?: string } | null
    processed_at_m: string | null
    provider_event_id: string
    signature: string | null
    status: string
  }>(sql`
    SELECT provider_event_id, status, attempts, processed_at_m, signature, error_payload
    FROM unprice_webhook_events
    WHERE project_id = ${projectId}
      AND provider_event_id = ${providerEventId}
  `)

  expect(webhookEvents.rows[0]).toMatchObject({
    attempts,
    provider_event_id: providerEventId,
    signature: "sig_lifecycle",
    status,
  })
  expect(Number(webhookEvents.rows[0]?.processed_at_m)).toBe(processedAt)
  return webhookEvents.rows[0]
}

async function getInvoiceState(invoiceId: string) {
  const invoices = await db.execute<{
    metadata: {
      note?: string
      reason?: string
      subscriptionReconciledOutcome?: string
    } | null
    paid_at_m: string | null
    status: string
  }>(sql`
    SELECT status, paid_at_m, metadata
    FROM unprice_invoices
    WHERE project_id = ${projectId}
      AND id = ${invoiceId}
  `)

  const invoice = invoices.rows[0]
  if (!invoice) {
    throw new Error(`Expected invoice ${invoiceId} to exist`)
  }

  return invoice
}

async function expectSubscriptionStatus(status: "active" | "past_due") {
  let lastRows: Array<{ status: string }> = []

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const subscriptions = await db.execute<{ status: string }>(sql`
      SELECT status
      FROM unprice_subscriptions
      WHERE project_id = ${projectId}
        AND id = ${subscriptionId}
    `)
    lastRows = subscriptions.rows

    if (subscriptions.rows[0]?.status === status) {
      expect(subscriptions.rows).toEqual([{ status }])
      return
    }

    await delay(10)
  }

  expect(lastRows).toEqual([{ status }])
}

async function processProviderWebhook({
  analytics,
  eventId,
  eventType,
  logger,
  processedAt,
  provider,
  services,
  waitUntil,
  wallet = services.wallet,
}: {
  analytics: Analytics
  eventId: string
  eventType: string
  logger: Logger
  processedAt: number
  provider: AsyncWebhookPaymentProvider
  services: ServiceContext
  waitUntil: (promise: Promise<unknown>) => void
  wallet?: WalletService
}) {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(processedAt)
  try {
    return await processWebhookEvent(
      {
        services: {
          customers: customerServiceFor(provider),
          subscriptions: services.subscriptions,
          wallet,
        },
        db,
        logger,
        analytics,
        waitUntil,
      },
      {
        projectId,
        provider: "sandbox",
        rawBody: JSON.stringify({ id: eventId, type: eventType }),
        headers: { "sandbox-signature": "sig_lifecycle" },
      }
    )
  } finally {
    dateNow.mockRestore()
  }
}

function createLifecycleRuntime(loggerErrors: unknown[] = []) {
  const logger = createLogger(loggerErrors)
  const analytics = createAnalytics({ events: 1200 })
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    void promise
  })
  const services = createServiceContext({
    db,
    logger,
    analytics,
    waitUntil,
    cache: {} as Cache,
    metrics: {} as Metrics,
  })
  const provider = new AsyncWebhookPaymentProvider()
  const billing = createBillingService({
    analytics,
    ledger: services.ledger,
    logger,
    provider,
    wallet: services.wallet,
  })

  return { analytics, billing, logger, provider, services, waitUntil }
}

async function prepareCollectedUnpaidInvoice({
  analytics,
  billing,
  logger,
  services,
}: ReturnType<typeof createLifecycleRuntime>) {
  const invoiceId = await createDraftInvoice({
    analytics,
    ledger: services.ledger,
    logger,
  })

  const finalized = await billing.finalizeInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now: finalizeNow,
  })
  expect(finalized.err).toBeUndefined()

  const collected = await billing.billingInvoice({
    projectId,
    subscriptionId,
    invoiceId,
    now: collectNow,
  })
  expect(collected.err).toBeUndefined()
  expect(collected.val).toMatchObject({
    status: "unpaid",
    total: invoiceTotal,
  })

  return invoiceId
}

describe("paid invoice lifecycle integration", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures })
    await enableAsyncCollectionFixture()
  })

  it("bills, finalizes, collects asynchronously, processes the paid webhook, settles receivables, and dedupes replay", async () => {
    const loggerErrors: unknown[] = []
    const logger = createLogger(loggerErrors)
    const analytics = createAnalytics({ events: 1200 })
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      void promise
    })
    const services = createServiceContext({
      db,
      logger,
      analytics,
      waitUntil,
      cache: {} as Cache,
      metrics: {} as Metrics,
    })
    const provider = new AsyncWebhookPaymentProvider()
    const billing = createBillingService({
      analytics,
      ledger: services.ledger,
      logger,
      provider,
      wallet: services.wallet,
    })
    const invoiceId = await createDraftInvoice({
      analytics,
      ledger: services.ledger,
      logger,
    })

    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe(
      "-219.00000000"
    )
    await expectSettlementRows(invoiceId, 0)

    const finalized = await billing.finalizeInvoice({
      projectId,
      subscriptionId,
      invoiceId,
      now: finalizeNow,
    })
    expect(finalized.err).toBeUndefined()
    expect(finalized.val).toMatchObject({
      invoiceId,
      providerInvoiceId: provider.providerInvoiceId,
      providerInvoiceUrl: provider.providerInvoiceUrl,
      status: "unpaid",
    })
    expect(provider.createInvoice).toHaveBeenCalledTimes(1)
    expect(provider.addInvoiceItem).toHaveBeenCalledTimes(2)
    expect(provider.finalizeInvoice).toHaveBeenCalledWith({
      invoiceId: provider.providerInvoiceId,
    })

    const collected = await billing.billingInvoice({
      projectId,
      subscriptionId,
      invoiceId,
      now: collectNow,
    })
    expect(collected.err).toBeUndefined()
    expect(collected.val).toMatchObject({
      status: "unpaid",
      total: invoiceTotal,
    })
    expect(provider.getStatusInvoice).toHaveBeenCalledWith({
      invoiceId: provider.providerInvoiceId,
    })
    expect(provider.collectPayment).toHaveBeenCalledWith({
      invoiceId: provider.providerInvoiceId,
      paymentMethodId,
    })
    await expectSettlementRows(invoiceId, 0)

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(webhookProcessedAt)
    try {
      const paidWebhook = await processWebhookEvent(
        {
          services: {
            customers: customerServiceFor(provider),
            subscriptions: services.subscriptions,
            wallet: services.wallet,
          },
          db,
          logger,
          analytics,
          waitUntil,
        },
        {
          projectId,
          provider: "sandbox",
          rawBody: JSON.stringify({ id: "evt_paid_lifecycle", type: "invoice.paid" }),
          headers: { "sandbox-signature": "sig_lifecycle" },
        }
      )

      expect(paidWebhook.err).toBeUndefined()
      expect(paidWebhook.val).toMatchObject({
        invoiceId,
        outcome: "payment_succeeded",
        providerEventId: "evt_paid_lifecycle",
        status: "processed",
        subscriptionId,
      })

      const replay = await processWebhookEvent(
        {
          services: {
            customers: customerServiceFor(provider),
            subscriptions: services.subscriptions,
            wallet: services.wallet,
          },
          db,
          logger,
          analytics,
          waitUntil,
        },
        {
          projectId,
          provider: "sandbox",
          rawBody: JSON.stringify({ id: "evt_paid_lifecycle", type: "invoice.paid" }),
          headers: { "sandbox-signature": "sig_lifecycle" },
        }
      )

      expect(replay.err).toBeUndefined()
      expect(replay.val).toMatchObject({
        outcome: "payment_succeeded",
        providerEventId: "evt_paid_lifecycle",
        status: "duplicate",
      })
    } finally {
      dateNow.mockRestore()
    }

    const invoices = await db.execute<{
      invoice_payment_provider_id: string | null
      metadata: { subscriptionReconciledOutcome?: string } | null
      paid_at_m: string | null
      status: string
    }>(sql`
      SELECT status, paid_at_m, invoice_payment_provider_id, metadata
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND id = ${invoiceId}
    `)
    expect(invoices.rows[0]).toMatchObject({
      invoice_payment_provider_id: provider.providerInvoiceId,
      status: "paid",
    })
    expect(Number(invoices.rows[0]?.paid_at_m)).toBe(webhookPaidAt)
    expect(invoices.rows[0]?.metadata?.subscriptionReconciledOutcome).toBe("success")

    await expectWebhookEvent({
      attempts: 1,
      processedAt: webhookProcessedAt,
      providerEventId: "evt_paid_lifecycle",
      status: "processed",
    })

    await expectSettlementRows(invoiceId, 1)
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe("0.00000000")

    const settlementEntries = await db.execute<{ amount: string; name: string }>(sql`
      SELECT a.name, e.amount
      FROM unprice_ledger_idempotency i
      JOIN pgledger_entries_view e ON e.transfer_id = i.transfer_id
      JOIN pgledger_accounts_view a ON a.id = e.account_id
      WHERE i.project_id = ${projectId}
        AND i.source_type = 'wallet_settle_receivable'
        AND i.source_id = ${`invoice_receivable:${invoiceId}`}
      ORDER BY a.name
    `)
    expect(settlementEntries.rows).toEqual([
      {
        amount: "219.00000000",
        name: customerAccountKeys(customerId).receivable,
      },
      {
        amount: "-219.00000000",
        name: platformAccountKey("topup", projectId),
      },
    ])

    const locks = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM unprice_subscription_locks
      WHERE project_id = ${projectId}
        AND subscription_id = ${subscriptionId}
    `)
    expect(locks.rows).toEqual([{ count: 0 }])
    expect(loggerErrors).toEqual([])
    expect(analytics.getUsageBillingFeatures).toHaveBeenCalledTimes(1)
  })

  it("processes a payment.failed webhook against real invoice, webhook, and subscription rows", async () => {
    const loggerErrors: unknown[] = []
    const runtime = createLifecycleRuntime(loggerErrors)
    const { analytics, logger, provider, services, waitUntil } = runtime
    const invoiceId = await prepareCollectedUnpaidInvoice(runtime)

    const failed = await processProviderWebhook({
      analytics,
      eventId: "evt_failed_lifecycle",
      eventType: "invoice.payment_failed",
      logger,
      processedAt: webhookFailedProcessedAt,
      provider,
      services,
      waitUntil,
    })

    expect(failed.err).toBeUndefined()
    expect(failed.val).toMatchObject({
      invoiceId,
      outcome: "payment_failed",
      providerEventId: "evt_failed_lifecycle",
      status: "processed",
      subscriptionId,
    })
    await expectWebhookEvent({
      attempts: 1,
      processedAt: webhookFailedProcessedAt,
      providerEventId: "evt_failed_lifecycle",
      status: "processed",
    })

    const invoice = await getInvoiceState(invoiceId)
    expect(invoice.status).toBe("unpaid")
    expect(invoice.paid_at_m).toBeNull()
    expect(invoice.metadata).toMatchObject({
      note: "Card declined",
      reason: "payment_failed",
      subscriptionReconciledOutcome: "failure",
    })
    await expectSubscriptionStatus("past_due")
    await expectSettlementRows(invoiceId, 0)
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe(
      "-219.00000000"
    )
    expect(loggerErrors).toEqual([])
  })

  it("persists a failed webhook attempt when settlement fails, then recovers on provider replay", async () => {
    const loggerErrors: unknown[] = []
    const logger = createLogger(loggerErrors)
    const analytics = createAnalytics({ events: 1200 })
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      void promise
    })
    const services = createServiceContext({
      db,
      logger,
      analytics,
      waitUntil,
      cache: {} as Cache,
      metrics: {} as Metrics,
    })
    const provider = new AsyncWebhookPaymentProvider()
    const flakyWallet = walletWithFirstSettlementFailure(services.wallet)
    const billing = createBillingService({
      analytics,
      ledger: services.ledger,
      logger,
      provider,
      wallet: services.wallet,
    })
    const invoiceId = await createDraftInvoice({
      analytics,
      ledger: services.ledger,
      logger,
    })

    const finalized = await billing.finalizeInvoice({
      projectId,
      subscriptionId,
      invoiceId,
      now: finalizeNow,
    })
    expect(finalized.err).toBeUndefined()

    const collected = await billing.billingInvoice({
      projectId,
      subscriptionId,
      invoiceId,
      now: collectNow,
    })
    expect(collected.err).toBeUndefined()
    expect(collected.val?.status).toBe("unpaid")

    const dateNow = vi.spyOn(Date, "now").mockReturnValue(webhookProcessedAt)
    try {
      const firstAttempt = await processWebhookEvent(
        {
          services: {
            customers: customerServiceFor(provider),
            subscriptions: services.subscriptions,
            wallet: flakyWallet,
          },
          db,
          logger,
          analytics,
          waitUntil,
        },
        {
          projectId,
          provider: "sandbox",
          rawBody: JSON.stringify({
            id: "evt_paid_lifecycle_retry",
            type: "invoice.paid",
          }),
          headers: { "sandbox-signature": "sig_lifecycle" },
        }
      )

      expect(firstAttempt.err?.message).toContain("Failed to settle prepaid invoice")

      const failedEvent = await expectWebhookEvent({
        attempts: 1,
        processedAt: webhookProcessedAt,
        providerEventId: "evt_paid_lifecycle_retry",
        status: "failed",
      })
      expect(failedEvent?.error_payload?.message).toContain("Failed to settle prepaid invoice")

      const unpaidInvoice = await db.execute<{
        paid_at_m: string | null
        status: string
      }>(sql`
        SELECT status, paid_at_m
        FROM unprice_invoices
        WHERE project_id = ${projectId}
          AND id = ${invoiceId}
      `)
      expect(unpaidInvoice.rows).toEqual([{ paid_at_m: null, status: "unpaid" }])
      await expectSettlementRows(invoiceId, 0)
      expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe(
        "-219.00000000"
      )

      dateNow.mockReturnValue(webhookRetryProcessedAt)
      const retry = await processWebhookEvent(
        {
          services: {
            customers: customerServiceFor(provider),
            subscriptions: services.subscriptions,
            wallet: flakyWallet,
          },
          db,
          logger,
          analytics,
          waitUntil,
        },
        {
          projectId,
          provider: "sandbox",
          rawBody: JSON.stringify({
            id: "evt_paid_lifecycle_retry",
            type: "invoice.paid",
          }),
          headers: { "sandbox-signature": "sig_lifecycle" },
        }
      )

      expect(retry.err).toBeUndefined()
      expect(retry.val).toMatchObject({
        invoiceId,
        outcome: "payment_succeeded",
        providerEventId: "evt_paid_lifecycle_retry",
        status: "processed",
        subscriptionId,
      })
    } finally {
      dateNow.mockRestore()
    }

    const processedEvent = await expectWebhookEvent({
      attempts: 2,
      processedAt: webhookRetryProcessedAt,
      providerEventId: "evt_paid_lifecycle_retry",
      status: "processed",
    })
    expect(processedEvent?.error_payload).toBeNull()

    const paidInvoice = await db.execute<{
      metadata: { subscriptionReconciledOutcome?: string } | null
      paid_at_m: string | null
      status: string
    }>(sql`
      SELECT status, paid_at_m, metadata
      FROM unprice_invoices
      WHERE project_id = ${projectId}
        AND id = ${invoiceId}
    `)
    expect(paidInvoice.rows[0]?.status).toBe("paid")
    expect(Number(paidInvoice.rows[0]?.paid_at_m)).toBe(webhookPaidAt)
    expect(paidInvoice.rows[0]?.metadata?.subscriptionReconciledOutcome).toBe("success")

    await expectSettlementRows(invoiceId, 1)
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe("0.00000000")
    expect(flakyWallet.settleReceivable).toHaveBeenCalledTimes(2)
    expect(loggerErrors).toEqual([])
  })

  it("reverses a paid invoice and reinstates it on dispute reversal without duplicate settlement", async () => {
    const loggerErrors: unknown[] = []
    const runtime = createLifecycleRuntime(loggerErrors)
    const { analytics, logger, provider, services, waitUntil } = runtime
    const invoiceId = await prepareCollectedUnpaidInvoice(runtime)

    const paid = await processProviderWebhook({
      analytics,
      eventId: "evt_paid_before_reversal",
      eventType: "invoice.paid",
      logger,
      processedAt: webhookProcessedAt,
      provider,
      services,
      waitUntil,
    })
    expect(paid.err).toBeUndefined()
    expect(paid.val?.outcome).toBe("payment_succeeded")
    await expectSettlementRows(invoiceId, 1)
    await expectSubscriptionStatus("active")
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe("0.00000000")

    const reversed = await processProviderWebhook({
      analytics,
      eventId: "evt_reversed_lifecycle",
      eventType: "charge.refunded",
      logger,
      processedAt: webhookReversedProcessedAt,
      provider,
      services,
      waitUntil,
    })
    expect(reversed.err).toBeUndefined()
    expect(reversed.val).toMatchObject({
      invoiceId,
      outcome: "payment_reversed",
      providerEventId: "evt_reversed_lifecycle",
      status: "processed",
      subscriptionId,
    })
    await expectWebhookEvent({
      attempts: 1,
      processedAt: webhookReversedProcessedAt,
      providerEventId: "evt_reversed_lifecycle",
      status: "processed",
    })

    const reversedInvoice = await getInvoiceState(invoiceId)
    expect(reversedInvoice.status).toBe("failed")
    expect(Number(reversedInvoice.paid_at_m)).toBe(webhookPaidAt)
    expect(reversedInvoice.metadata).toMatchObject({
      note: "Charge refunded",
      reason: "payment_failed",
      subscriptionReconciledOutcome: "failure",
    })
    await expectSubscriptionStatus("past_due")
    await expectSettlementRows(invoiceId, 1)
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe("0.00000000")

    const disputeReversed = await processProviderWebhook({
      analytics,
      eventId: "evt_dispute_reversed_lifecycle",
      eventType: "charge.dispute.funds_reinstated",
      logger,
      processedAt: webhookDisputeReversedProcessedAt,
      provider,
      services,
      waitUntil,
    })
    expect(disputeReversed.err).toBeUndefined()
    expect(disputeReversed.val).toMatchObject({
      invoiceId,
      outcome: "payment_dispute_reversed",
      providerEventId: "evt_dispute_reversed_lifecycle",
      status: "processed",
      subscriptionId,
    })
    await expectWebhookEvent({
      attempts: 1,
      processedAt: webhookDisputeReversedProcessedAt,
      providerEventId: "evt_dispute_reversed_lifecycle",
      status: "processed",
    })

    const reinstatedInvoice = await getInvoiceState(invoiceId)
    expect(reinstatedInvoice.status).toBe("paid")
    expect(Number(reinstatedInvoice.paid_at_m)).toBe(webhookPaidAt)
    expect(reinstatedInvoice.metadata).toMatchObject({
      note: "Payment reinstated after dispute reversal",
      reason: "payment_received",
      subscriptionReconciledOutcome: "success",
    })
    await expectSubscriptionStatus("active")
    await expectSettlementRows(invoiceId, 1)
    expect(await getAccountBalance(customerAccountKeys(customerId).receivable)).toBe("0.00000000")
    expect(loggerErrors).toEqual([])
  })
})
