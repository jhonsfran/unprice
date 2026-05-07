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

describe("StripePaymentProvider", () => {
  beforeEach(() => {
    stripeMocks.checkoutSessionsCreate.mockResolvedValue({
      id: "cs_123",
      url: "https://checkout.stripe.com/cs_123",
    })
  })

  it("scopes checkout session creation to the connected Stripe account", async () => {
    const provider = new StripePaymentProvider({
      token: "sk_platform_test",
      connectedAccountId: "acct_123",
      logger: createMockLogger(),
    })

    const result = await provider.createSession({
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

  it("uses invoice.paid as the canonical successful invoice webhook", () => {
    const provider = new StripePaymentProvider({
      token: "sk_platform_test",
      logger: createMockLogger(),
    })

    const paid = provider.normalizeWebhook({
      eventId: "evt_paid",
      eventType: "invoice.paid",
      occurredAt: 123,
      payload: {
        data: {
          object: {
            id: "in_123",
            customer: "cus_123",
            subscription: "sub_123",
          },
        },
      },
    })
    const paymentSucceeded = provider.normalizeWebhook({
      eventId: "evt_payment_succeeded",
      eventType: "invoice.payment_succeeded",
      occurredAt: 124,
      payload: {
        data: {
          object: {
            id: "in_123",
            customer: "cus_123",
            subscription: "sub_123",
          },
        },
      },
    })

    expect(paid.err).toBeUndefined()
    expect(paid.val?.eventType).toBe("payment.succeeded")
    expect(paid.val?.invoiceId).toBe("in_123")
    expect(paymentSucceeded.err).toBeUndefined()
    expect(paymentSucceeded.val?.eventType).toBe("noop")
    expect(paymentSucceeded.val?.invoiceId).toBe("in_123")
  })
})
