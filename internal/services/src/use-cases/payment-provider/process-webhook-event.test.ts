import type { Database } from "@unprice/db"
import type { PaymentProvider } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UnPriceCustomerError } from "../../customers/errors"
import type { PaymentProviderService } from "../../payment-provider/service"
import { processWebhookEvent } from "./process-webhook-event"

vi.mock("@unprice/db/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/utils")>()
  return {
    ...actual,
    newId: vi.fn().mockReturnValue("webhook_event_new"),
  }
})

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

type LockOutcome = { acquired: boolean }

function createDbMocks(opts?: {
  lockAcquired?: boolean
  webhookEventState?: { id: string; status: string; attempts: number } | null
  invoice?: Record<string, unknown> | null
  updateInvoiceReturns?: Array<Record<string, unknown>>
}) {
  const lockAcquired = opts?.lockAcquired ?? true
  const webhookEventState = opts?.webhookEventState
  const invoice = opts?.invoice ?? null
  const updateInvoiceReturns = opts?.updateInvoiceReturns ?? [{ id: "inv_1", status: "paid" }]

  // db-level update (used by DrizzleBillingRepository.updateInvoiceIfStatus)
  const updateReturning = vi.fn().mockResolvedValue(updateInvoiceReturns)
  const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning })
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  const update = vi.fn().mockReturnValue({ set: updateSet })

  // tx-level: insert webhook_events
  const txInsertOnConflict = vi.fn().mockResolvedValue(undefined)
  const txInsertValues = vi.fn().mockReturnValue({ onConflictDoNothing: txInsertOnConflict })
  const txInsert = vi.fn().mockReturnValue({ values: txInsertValues })

  // tx-level: update webhook_events status
  const txUpdateWhere = vi.fn().mockResolvedValue(undefined)
  const txUpdateSet = vi.fn().mockReturnValue({ where: txUpdateWhere })
  const txUpdate = vi.fn().mockReturnValue({ set: txUpdateSet })

  // tx-level: try-advisory-xact-lock
  const txExecute = vi.fn().mockImplementation(async () => ({
    rows: [{ acquired: lockAcquired } satisfies LockOutcome],
  }))

  // tx-level: webhook_events lookup
  const txWebhookFindFirst = vi.fn().mockImplementation(async () => {
    if (typeof webhookEventState === "undefined") {
      // Default: return the row we just inserted (matches newWebhookEventId).
      return {
        id: "webhook_event_new",
        status: "processing",
        attempts: 1,
      }
    }
    return webhookEventState
  })

  const txQuery = {
    webhookEvents: {
      findFirst: txWebhookFindFirst,
    },
  }

  // db-level: invoices.findFirst (used by repo.findInvoiceByProviderId)
  const invoicesFindFirst = vi.fn().mockResolvedValue(invoice)

  const query = {
    webhookEvents: {
      findFirst: vi.fn(),
    },
    invoices: {
      findFirst: invoicesFindFirst,
    },
  }

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      execute: txExecute,
      insert: txInsert,
      update: txUpdate,
      query: txQuery,
    })
  )

  const db = {
    update,
    query,
    transaction,
  } as unknown as Database

  return {
    db,
    mocks: {
      update,
      updateSet,
      updateWhere,
      updateReturning,
      query,
      invoicesFindFirst,
      transaction,
      txExecute,
      txInsert,
      txInsertValues,
      txInsertOnConflict,
      txUpdate,
      txUpdateSet,
      txUpdateWhere,
      txWebhookFindFirst,
    },
  }
}

function createPaymentProviderService(): PaymentProviderService {
  return {
    verifyWebhook: vi.fn(),
    normalizeWebhook: vi.fn(),
  } as unknown as PaymentProviderService
}

describe("processWebhookEvent", () => {
  const provider: PaymentProvider = "stripe"

  let paymentProvider: PaymentProviderService
  let logger: Logger
  let customers: {
    getPaymentProvider: ReturnType<typeof vi.fn>
  }
  let subscriptions: {
    reconcilePaymentOutcome: ReturnType<typeof vi.fn>
  }
  let wallet: {
    settleTopUp: ReturnType<typeof vi.fn>
    settleReceivable: ReturnType<typeof vi.fn>
    adjust: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    logger = createLogger()
    paymentProvider = createPaymentProviderService()

    customers = {
      getPaymentProvider: vi.fn().mockResolvedValue({ val: paymentProvider }),
    }

    subscriptions = {
      reconcilePaymentOutcome: vi.fn().mockResolvedValue({ val: { status: "active" } }),
    }

    wallet = {
      settleTopUp: vi.fn().mockResolvedValue({
        val: { topupId: "wtup_test", ledgerTransferId: "tr_test" },
      }),
      settleReceivable: vi.fn().mockResolvedValue({
        val: { ledgerTransferId: "tr_recv_test" },
      }),
      adjust: vi.fn().mockResolvedValue({
        val: { clampedAmount: 0, unclampedRemainder: 0 },
      }),
    }
  })

  function callServices(db: Database) {
    return {
      services: {
        customers: customers as unknown as never,
        subscriptions: subscriptions as unknown as never,
        wallet: wallet as unknown as never,
      },
      db,
      logger,
    }
  }

  it("returns provider error when signature verification fails", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      err: new Error("Missing webhook signature"),
    })
    const { db, mocks } = createDbMocks()

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
      headers: {},
    })

    expect(result.err).toBeInstanceOf(UnPriceCustomerError)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it("returns duplicate when advisory lock is held by a concurrent worker", async () => {
    // Simulates two simultaneous deliveries: this caller fails to acquire
    // the lock because another worker already holds it. Critical regression
    // guard: no INSERT, no invoice update, no settle, no reconcile.
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_concurrent",
        eventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_concurrent",
        eventType: "payment.succeeded",
        providerEventType: "invoice.paid",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        payload: {},
      },
    })

    const { db, mocks } = createDbMocks({
      lockAcquired: false,
      webhookEventState: { id: "webhook_event_existing", status: "processing", attempts: 1 },
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_concurrent", type: "invoice.paid" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("duplicate")
    expect(result.val?.webhookEventId).toBe("webhook_event_existing")
    expect(mocks.txInsert).not.toHaveBeenCalled()
    expect(mocks.txUpdate).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(wallet.settleReceivable).not.toHaveBeenCalled()
    expect(subscriptions.reconcilePaymentOutcome).not.toHaveBeenCalled()
  })

  it("returns duplicate when webhook event already processed", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_1",
        eventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_1",
        eventType: "payment.succeeded",
        providerEventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })

    const { db, mocks } = createDbMocks({
      webhookEventState: { id: "webhook_event_existing", status: "processed", attempts: 1 },
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("duplicate")
    expect(mocks.invoicesFindFirst).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("marks invoice paid and confirms pending settlement on payment success", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_paid",
        eventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_paid",
        eventType: "payment.succeeded",
        providerEventType: "invoice.paid",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        payload: {},
      },
    })

    const { db, mocks } = createDbMocks({
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "unpaid",
        paidAt: null,
        paymentAttempts: [],
        metadata: {},
        invoicePaymentProviderUrl: null,
        totalAmount: 5_000_000_000,
        currency: "USD",
        whenToBill: "pay_in_advance",
        customerId: "cus_1",
      },
      updateInvoiceReturns: [{ id: "inv_1", status: "paid" }],
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_paid", type: "invoice.paid" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("processed")
    expect(result.val?.outcome).toBe("payment_succeeded")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        subscriptionId: "sub_1",
      })
    )
    expect(mocks.update).toHaveBeenCalled()
    expect(wallet.settleReceivable).toHaveBeenCalledTimes(1)
    expect(wallet.settleReceivable).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        customerId: "cus_1",
        paidAmount: 5_000_000_000,
        idempotencyKey: "invoice_receivable:inv_1",
      })
    )
    // Regression: invoice settlement must not double-fund usage runway by
    // posting `topup → purchased`. The customer's allowance is granted at
    // activation (`credit_line → granted`); funding `purchased` here would
    // duplicate the flat-fee dollars.
    expect(wallet.adjust).not.toHaveBeenCalled()
  })

  it("skips downstream side effects when invoice already in target state (state-machine guard)", async () => {
    // Late or out-of-order webhook: invoice already paid. The conditional
    // update returns 0 rows; we must not call settleReceivable or
    // reconcilePaymentOutcome a second time.
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_late",
        eventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_late",
        eventType: "payment.succeeded",
        providerEventType: "invoice.paid",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        payload: {},
      },
    })

    const { db } = createDbMocks({
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "paid",
        paidAt: Date.now(),
        paymentAttempts: [],
        metadata: {},
        invoicePaymentProviderUrl: null,
        totalAmount: 5_000_000_000,
        currency: "USD",
        whenToBill: "pay_in_advance",
        customerId: "cus_1",
      },
      updateInvoiceReturns: [], // conditional update doesn't match
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_late", type: "invoice.paid" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("processed")
    expect(result.val?.outcome).toBe("payment_succeeded")
    expect(wallet.settleReceivable).not.toHaveBeenCalled()
    expect(subscriptions.reconcilePaymentOutcome).not.toHaveBeenCalled()
  })

  it("transitions invoice to unpaid on payment failure and notifies subscription machine", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_fail",
        eventType: "invoice.payment_failed",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_fail",
        eventType: "payment.failed",
        providerEventType: "invoice.payment_failed",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        failureMessage: "Card declined",
        payload: {},
      },
    })

    const { db } = createDbMocks({
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "unpaid",
        paidAt: null,
        paymentAttempts: [],
        metadata: {},
        invoicePaymentProviderUrl: null,
      },
      updateInvoiceReturns: [{ id: "inv_1", status: "unpaid" }],
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_fail", type: "invoice.payment_failed" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.outcome).toBe("payment_failed")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
      })
    )
  })

  it("reinstates invoice and confirms settlement on dispute reversal", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_dispute_reversed",
        eventType: "charge.dispute.funds_reinstated",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_dispute_reversed",
        eventType: "payment.dispute_reversed",
        providerEventType: "charge.dispute.funds_reinstated",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        payload: {},
      },
    })

    const { db } = createDbMocks({
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "failed",
        paidAt: null,
        paymentAttempts: [{ status: "failed", createdAt: Date.now() }],
        metadata: {},
        invoicePaymentProviderUrl: null,
        totalAmount: 1000,
        currency: "USD",
        customerId: "cus_1",
        whenToBill: "pay_in_advance",
      },
      updateInvoiceReturns: [{ id: "inv_1", status: "paid" }],
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({
        id: "evt_dispute_reversed",
        type: "charge.dispute.funds_reinstated",
      }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.outcome).toBe("payment_dispute_reversed")
    expect(result.val?.invoiceId).toBe("inv_1")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        subscriptionId: "sub_1",
      })
    )
  })

  it("retries a previously failed webhook event", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_retry",
        eventType: "invoice.paid",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_retry",
        eventType: "payment.succeeded",
        providerEventType: "invoice.paid",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        payload: {},
      },
    })

    const { db, mocks } = createDbMocks({
      webhookEventState: { id: "webhook_event_existing_failed", status: "failed", attempts: 1 },
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "unpaid",
        paidAt: null,
        paymentAttempts: [],
        metadata: {},
        invoicePaymentProviderUrl: null,
        totalAmount: 1000,
        currency: "USD",
        customerId: "cus_1",
        whenToBill: "pay_in_advance",
      },
      updateInvoiceReturns: [{ id: "inv_1", status: "paid" }],
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_retry", type: "invoice.paid" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("processed")
    expect(result.val?.webhookEventId).toBe("webhook_event_existing_failed")
    // The retry path must bump attempts on the existing row + final mark
    // it processed.
    expect(mocks.txUpdate).toHaveBeenCalled()
  })

  it("reopens settlement on payment reversal events", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      val: {
        eventId: "evt_reversed",
        eventType: "charge.refunded",
        occurredAt: Date.now(),
        payload: {},
      },
    })
    ;(paymentProvider.normalizeWebhook as ReturnType<typeof vi.fn>).mockReturnValue({
      val: {
        provider,
        eventId: "evt_reversed",
        eventType: "payment.reversed",
        providerEventType: "charge.refunded",
        occurredAt: Date.now(),
        invoiceId: "in_provider_1",
        failureMessage: "Charge refunded",
        payload: {},
      },
    })

    const { db } = createDbMocks({
      invoice: {
        id: "inv_1",
        projectId: "proj_1",
        subscriptionId: "sub_1",
        status: "paid",
        paidAt: Date.now(),
        paymentAttempts: [],
        metadata: {},
        invoicePaymentProviderUrl: null,
      },
      updateInvoiceReturns: [{ id: "inv_1", status: "failed" }],
    })

    const result = await processWebhookEvent(callServices(db), {
      projectId: "proj_1",
      provider,
      rawBody: JSON.stringify({ id: "evt_reversed", type: "charge.refunded" }),
      headers: { "stripe-signature": "sig" },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.outcome).toBe("payment_reversed")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
      })
    )
  })
})
