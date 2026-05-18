import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { StripePaymentProvider } from "./stripe"

const stripeMocks = vi.hoisted(() => ({
  checkoutSessionsCreate: vi.fn(),
}))

vi.mock("@unprice/stripe", () => ({
  Stripe: vi.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: stripeMocks.checkoutSessionsCreate,
      },
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  })),
}))

function createMockLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function makeEvent(eventType: string, objectOverrides: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${eventType}`,
    eventType,
    occurredAt: 1_700_000_000,
    payload: {
      data: {
        object: {
          id: "in_123",
          customer: "cus_123",
          subscription: "sub_123",
          ...objectOverrides,
        },
      },
    },
  }
}

describe("StripePaymentProvider", () => {
  let provider: StripePaymentProvider

  beforeEach(() => {
    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_123",
      url: "https://checkout.stripe.com/cs_123",
    })
    provider = new StripePaymentProvider({
      token: "sk_platform_test",
      logger: createMockLogger(),
    })
  })

  it("scopes checkout session creation to the connected Stripe account", async () => {
    const connectedProvider = new StripePaymentProvider({
      token: "sk_platform_test",
      connectedAccountId: "acct_123",
      logger: createMockLogger(),
    })

    const result = await connectedProvider.createSession({
      currency: "usd",
      customerId: "cus_123",
      projectId: "proj_123",
      email: "customer@example.com",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    })

    expect(result.err).toBeUndefined()
    expect(stripeMocks.checkoutSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: "cus_123",
        mode: "setup",
      }),
      { stripeAccount: "acct_123" }
    )
  })

  // -----------------------------------------------------------------------
  // Webhook normalizeWebhook — event type mapping
  // -----------------------------------------------------------------------

  describe("normalizeWebhook event type mapping", () => {
    it("uses invoice.paid as the canonical successful invoice webhook", () => {
      const paid = provider.normalizeWebhook(makeEvent("invoice.paid"))
      expect(paid.val?.eventType).toBe("payment.succeeded")
      expect(paid.val?.invoiceId).toBe("in_123")
    })

    it("suppresses invoice.payment_succeeded as noop (duplicate of invoice.paid)", () => {
      const result = provider.normalizeWebhook(makeEvent("invoice.payment_succeeded"))
      expect(result.val?.eventType).toBe("noop")
      expect(result.val?.invoiceId).toBe("in_123")
    })

    it("maps invoice.payment_failed to payment.failed", () => {
      const result = provider.normalizeWebhook(makeEvent("invoice.payment_failed"))
      expect(result.val?.eventType).toBe("payment.failed")
    })

    it("maps checkout.session.completed with paid status to payment.succeeded", () => {
      const result = provider.normalizeWebhook(
        makeEvent("checkout.session.completed", { payment_status: "paid" })
      )
      expect(result.val?.eventType).toBe("payment.succeeded")
    })

    it("maps checkout.session.completed with unpaid status to noop", () => {
      const result = provider.normalizeWebhook(
        makeEvent("checkout.session.completed", { payment_status: "unpaid" })
      )
      expect(result.val?.eventType).toBe("noop")
    })

    it("maps checkout.session.async_payment_succeeded (paid) to payment.succeeded", () => {
      const result = provider.normalizeWebhook(
        makeEvent("checkout.session.async_payment_succeeded", { payment_status: "paid" })
      )
      expect(result.val?.eventType).toBe("payment.succeeded")
    })

    it("maps checkout.session.async_payment_failed to payment.failed", () => {
      const result = provider.normalizeWebhook(makeEvent("checkout.session.async_payment_failed"))
      expect(result.val?.eventType).toBe("payment.failed")
    })

    it("maps charge.refunded to payment.reversed", () => {
      const result = provider.normalizeWebhook(makeEvent("charge.refunded"))
      expect(result.val?.eventType).toBe("payment.reversed")
    })

    it("maps charge.dispute.created to payment.reversed", () => {
      const result = provider.normalizeWebhook(makeEvent("charge.dispute.created"))
      expect(result.val?.eventType).toBe("payment.reversed")
    })

    it("maps charge.dispute.funds_withdrawn to payment.reversed", () => {
      const result = provider.normalizeWebhook(makeEvent("charge.dispute.funds_withdrawn"))
      expect(result.val?.eventType).toBe("payment.reversed")
    })

    it("maps charge.dispute.funds_reinstated to payment.dispute_reversed", () => {
      const result = provider.normalizeWebhook(makeEvent("charge.dispute.funds_reinstated"))
      expect(result.val?.eventType).toBe("payment.dispute_reversed")
    })

    it("maps unknown event types to noop", () => {
      const result = provider.normalizeWebhook(makeEvent("customer.updated"))
      expect(result.val?.eventType).toBe("noop")
    })
  })

  // -----------------------------------------------------------------------
  // Webhook normalizeWebhook — field extraction
  // -----------------------------------------------------------------------

  describe("normalizeWebhook field extraction", () => {
    it("extracts customerId from expanded customer object", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.paid", { customer: { id: "cus_expanded" } })
      )
      expect(result.val?.customerId).toBe("cus_expanded")
    })

    it("extracts subscriptionId from expanded subscription object", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.paid", { subscription: { id: "sub_expanded" } })
      )
      expect(result.val?.subscriptionId).toBe("sub_expanded")
    })

    it("extracts invoiceId from invoice field for charge events", () => {
      const result = provider.normalizeWebhook(
        makeEvent("charge.refunded", { id: "ch_123", invoice: "in_456" })
      )
      expect(result.val?.invoiceId).toBe("in_456")
    })

    it("extracts invoiceId from expanded invoice object", () => {
      const result = provider.normalizeWebhook(
        makeEvent("charge.refunded", { id: "ch_123", invoice: { id: "in_expanded" } })
      )
      expect(result.val?.invoiceId).toBe("in_expanded")
    })

    it("sets providerSessionId for checkout events", () => {
      const result = provider.normalizeWebhook(
        makeEvent("checkout.session.completed", { id: "cs_789", payment_status: "paid" })
      )
      expect(result.val?.providerSessionId).toBe("cs_789")
    })

    it("does not set providerSessionId for non-checkout events", () => {
      const result = provider.normalizeWebhook(makeEvent("invoice.paid"))
      expect(result.val?.providerSessionId).toBeUndefined()
    })

    it("converts amount_total from Stripe cents to scale-8 minor", () => {
      const result = provider.normalizeWebhook(
        makeEvent("checkout.session.completed", {
          payment_status: "paid",
          amount_total: 5000, // $50.00 in cents
        })
      )
      // 5000 * 1_000_000 = 5_000_000_000
      expect(result.val?.amountPaid).toBe(5_000_000_000)
    })

    it("extracts failure codes from the object", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.payment_failed", {
          failure_code: "card_declined",
          failure_message: "Your card was declined",
        })
      )
      expect(result.val?.failureCode).toBe("card_declined")
      expect(result.val?.failureMessage).toBe("Your card was declined")
    })

    it("falls back to last_payment_error fields when failure_code is absent", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.payment_failed", {
          last_payment_error_code: "insufficient_funds",
          last_payment_error_message: "Insufficient funds",
        })
      )
      expect(result.val?.failureCode).toBe("insufficient_funds")
      expect(result.val?.failureMessage).toBe("Insufficient funds")
    })

    it("extracts metadata as string-value-only map", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.paid", {
          metadata: { plan: "pro", version: "2", nested: { bad: true } },
        })
      )
      expect(result.val?.metadata).toEqual({ plan: "pro", version: "2" })
    })

    it("extracts hosted_invoice_url", () => {
      const result = provider.normalizeWebhook(
        makeEvent("invoice.paid", {
          hosted_invoice_url: "https://invoice.stripe.com/i/xxx",
        })
      )
      expect(result.val?.invoiceUrl).toBe("https://invoice.stripe.com/i/xxx")
    })
  })
})
