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

function createDbMocks() {
  const updateReturning = vi.fn().mockResolvedValue([{ id: "inv_1", status: "paid" }])
  const updateWhere = vi.fn().mockReturnValue({
    returning: updateReturning,
  })
  const updateSet = vi.fn().mockReturnValue({
    where: updateWhere,
  })
  const update = vi.fn().mockReturnValue({
    set: updateSet,
  })

  const insertOnConflict = vi.fn().mockResolvedValue(undefined)
  const insertValues = vi.fn().mockReturnValue({
    onConflictDoNothing: insertOnConflict,
  })
  const insert = vi.fn().mockReturnValue({
    values: insertValues,
  })

  const txUpdateWhere = vi.fn().mockResolvedValue(undefined)
  const txUpdateSet = vi.fn().mockReturnValue({
    where: txUpdateWhere,
  })
  const txUpdate = vi.fn().mockReturnValue({
    set: txUpdateSet,
  })

  const txQuery = {
    ledgerEntries: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ledgers: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  }

  const query = {
    webhookEvents: {
      findFirst: vi.fn(),
    },
    invoices: {
      findFirst: vi.fn(),
    },
    ledgerEntries: {
      findMany: vi.fn(),
    },
    ledgers: {
      findFirst: vi.fn(),
    },
  }

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      query: txQuery,
      update: txUpdate,
    })
  )

  const db = {
    insert,
    update,
    query,
    transaction,
  } as unknown as Database

  return {
    db,
    mocks: {
      insert,
      insertValues,
      insertOnConflict,
      update,
      updateSet,
      updateWhere,
      updateReturning,
      query,
      transaction,
      txQuery,
      txUpdate,
      txUpdateSet,
      txUpdateWhere,
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
  let db: Database
  let dbMocks: ReturnType<typeof createDbMocks>["mocks"]
  let customers: {
    getPaymentProvider: ReturnType<typeof vi.fn>
  }
  let subscriptions: {
    reconcilePaymentOutcome: ReturnType<typeof vi.fn>
  }
  beforeEach(() => {
    const setup = createDbMocks()
    db = setup.db
    dbMocks = setup.mocks
    logger = createLogger()
    paymentProvider = createPaymentProviderService()

    customers = {
      getPaymentProvider: vi.fn().mockResolvedValue({ val: paymentProvider }),
    }

    subscriptions = {
      reconcilePaymentOutcome: vi.fn().mockResolvedValue({ val: { status: "active" } }),
    }
  })

  it("returns provider error when signature verification fails", async () => {
    ;(paymentProvider.verifyWebhook as ReturnType<typeof vi.fn>).mockResolvedValue({
      err: new Error("Missing webhook signature"),
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
        headers: {},
      }
    )

    expect(result.err).toBeInstanceOf(UnPriceCustomerError)
    expect(dbMocks.insert).not.toHaveBeenCalled()
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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_existing",
      status: "processed",
      attempts: 1,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_1", type: "invoice.paid" }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("duplicate")
    expect(dbMocks.query.invoices.findFirst).not.toHaveBeenCalled()
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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_new",
      status: "processing",
      attempts: 1,
    })
    dbMocks.query.invoices.findFirst.mockResolvedValue({
      id: "inv_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      status: "unpaid",
      paidAt: null,
      paymentAttempts: [],
      metadata: {},
      invoicePaymentProviderUrl: null,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_paid", type: "invoice.paid" }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("processed")
    expect(result.val?.outcome).toBe("payment_succeeded")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        subscriptionId: "sub_1",
      })
    )
    expect(dbMocks.update).toHaveBeenCalled()
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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_new",
      status: "processing",
      attempts: 1,
    })
    dbMocks.query.invoices.findFirst.mockResolvedValue({
      id: "inv_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      status: "unpaid",
      paidAt: null,
      paymentAttempts: [],
      metadata: {},
      invoicePaymentProviderUrl: null,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_fail", type: "invoice.payment_failed" }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_new",
      status: "processing",
      attempts: 1,
    })
    dbMocks.query.invoices.findFirst.mockResolvedValue({
      id: "inv_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      status: "failed",
      paidAt: null,
      paymentAttempts: [{ status: "failed", createdAt: Date.now() }],
      metadata: {},
      invoicePaymentProviderUrl: null,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({
          id: "evt_dispute_reversed",
          type: "charge.dispute.funds_reinstated",
        }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_existing_failed",
      status: "failed",
      attempts: 1,
    })
    dbMocks.query.invoices.findFirst.mockResolvedValue({
      id: "inv_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      status: "unpaid",
      paidAt: null,
      paymentAttempts: [],
      metadata: {},
      invoicePaymentProviderUrl: null,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_retry", type: "invoice.paid" }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.status).toBe("processed")
    expect(result.val?.webhookEventId).toBe("webhook_event_existing_failed")
    expect(dbMocks.update).toHaveBeenCalled()
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

    dbMocks.query.webhookEvents.findFirst.mockResolvedValue({
      id: "webhook_event_new",
      status: "processing",
      attempts: 1,
    })
    dbMocks.query.invoices.findFirst.mockResolvedValue({
      id: "inv_1",
      projectId: "proj_1",
      subscriptionId: "sub_1",
      status: "paid",
      paidAt: Date.now(),
      paymentAttempts: [],
      metadata: {},
      invoicePaymentProviderUrl: null,
    })

    const result = await processWebhookEvent(
      {
        services: {
          customers: customers as unknown as never,
          subscriptions: subscriptions as unknown as never,
        },
        db,
        logger,
      },
      {
        projectId: "proj_1",
        provider,
        rawBody: JSON.stringify({ id: "evt_reversed", type: "charge.refunded" }),
        headers: {
          "stripe-signature": "sig",
        },
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.outcome).toBe("payment_reversed")
    expect(subscriptions.reconcilePaymentOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failure",
      })
    )
  })
})
