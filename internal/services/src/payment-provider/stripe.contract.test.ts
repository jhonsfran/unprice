import type { Logger } from "@unprice/logs"
import { Stripe } from "@unprice/stripe"
import { describe, expect, it, vi } from "vitest"
import { StripePaymentProvider } from "./stripe"

type StripeClientStub = {
  billingPortal: {
    sessions: {
      create: ReturnType<typeof vi.fn>
    }
  }
  checkout: {
    sessions: {
      create: ReturnType<typeof vi.fn>
    }
  }
  invoices: {
    create: ReturnType<typeof vi.fn>
    finalizeInvoice: ReturnType<typeof vi.fn>
    pay: ReturnType<typeof vi.fn>
    retrieve: ReturnType<typeof vi.fn>
    sendInvoice: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  invoiceItems: {
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  paymentIntents: {
    retrieve: ReturnType<typeof vi.fn>
  }
}

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

function setStripeClient(provider: StripePaymentProvider, client: StripeClientStub) {
  ;(provider as unknown as { client: StripeClientStub }).client = client
}

function stripeInvoiceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_contract",
    status: "draft",
    paid: false,
    total: 700,
    hosted_invoice_url: "https://invoice.stripe.com/i/in_contract",
    invoice_pdf: "https://invoice.stripe.com/i/in_contract.pdf",
    created: 1_770_000_000,
    payment_intent: null,
    lines: {
      data: [],
    },
    ...overrides,
  }
}

function stripeInvoiceLineFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "il_usage",
    amount: 1200,
    description: "Usage overage",
    currency: "usd",
    quantity: 3,
    price: {
      product: "prod_usage",
    },
    metadata: {
      billing_period_id: "bp_123",
      subscription_id: "sub_123",
      subscription_item_id: "item_123",
      kind: "subscription",
    },
    ...overrides,
  }
}

function createStripeClientStub() {
  return {
    billingPortal: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "bps_contract",
          url: "https://billing.stripe.com/session/bps_contract",
        }),
      },
    },
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: "cs_contract_setup",
          url: "https://checkout.stripe.com/cs_contract_setup",
        }),
      },
    },
    invoices: {
      create: vi.fn().mockResolvedValue(stripeInvoiceFixture()),
      finalizeInvoice: vi.fn().mockResolvedValue({ id: "in_contract" }),
      pay: vi.fn().mockResolvedValue(
        stripeInvoiceFixture({
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/paid",
        })
      ),
      retrieve: vi.fn().mockResolvedValue(stripeInvoiceFixture()),
      sendInvoice: vi.fn().mockResolvedValue(stripeInvoiceFixture()),
      update: vi.fn().mockResolvedValue(stripeInvoiceFixture()),
    },
    invoiceItems: {
      create: vi.fn().mockResolvedValue({ id: "ii_created" }),
      update: vi.fn().mockResolvedValue({ id: "ii_updated" }),
    },
    paymentIntents: {
      retrieve: vi.fn().mockResolvedValue({
        id: "pi_contract",
        status: "succeeded",
        created: 1_770_000_456,
      }),
    },
  } satisfies StripeClientStub
}

describe("StripePaymentProvider contract fixtures", () => {
  it("verifies a real signed Stripe webhook payload and rejects tampering", async () => {
    const webhookSecret = "whsec_contract_test"
    const stripe = new Stripe("sk_test_contract", { apiVersion: "2023-10-16" })
    const eventCreated = Math.floor(Date.now() / 1000)
    const provider = new StripePaymentProvider({
      token: "sk_test_contract",
      webhookSecret,
      logger: createMockLogger(),
    })
    const payload = JSON.stringify({
      id: "evt_invoice_paid_contract",
      object: "event",
      api_version: "2023-10-16",
      created: eventCreated,
      type: "invoice.paid",
      data: {
        object: {
          id: "in_contract_paid",
          object: "invoice",
          customer: { id: "cus_stripe_contract" },
          subscription: "sub_stripe_contract",
          hosted_invoice_url: "https://invoice.stripe.com/i/in_contract_paid",
          metadata: {
            invoice_id: "inv_internal_123",
            subscription_id: "sub_internal_123",
            ignored_object: { nested: true },
          },
        },
      },
    })
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      timestamp: eventCreated,
    })

    const verified = await provider.verifyWebhook({
      rawBody: payload,
      headers: { "stripe-signature": signature },
    })
    expect(verified.err).toBeUndefined()
    expect(verified.val).toMatchObject({
      eventId: "evt_invoice_paid_contract",
      eventType: "invoice.paid",
      occurredAt: eventCreated * 1000,
    })

    if (!verified.val) {
      throw new Error("Expected verified webhook payload")
    }

    const normalized = provider.normalizeWebhook(verified.val)
    expect(normalized.err).toBeUndefined()
    expect(normalized.val).toMatchObject({
      provider: "stripe",
      eventId: "evt_invoice_paid_contract",
      eventType: "payment.succeeded",
      providerEventType: "invoice.paid",
      customerId: "cus_stripe_contract",
      subscriptionId: "sub_stripe_contract",
      invoiceId: "in_contract_paid",
      invoiceUrl: "https://invoice.stripe.com/i/in_contract_paid",
      metadata: {
        invoice_id: "inv_internal_123",
        subscription_id: "sub_internal_123",
      },
    })

    const tampered = await provider.verifyWebhook({
      rawBody: payload.replace("invoice.paid", "invoice.payment_failed"),
      headers: { "stripe-signature": signature },
    })
    expect(tampered.err?.message).toMatch(/signature/i)
  })

  it("passes connected-account request options through Stripe invoice calls", async () => {
    const provider = new StripePaymentProvider({
      token: "sk_test_contract",
      providerCustomerId: "cus_stripe_contract",
      connectedAccountId: "acct_contract",
      logger: createMockLogger(),
    })
    const client = createStripeClientStub()
    setStripeClient(provider, client)

    await provider.createSession({
      currency: "USD",
      customerId: "cus_internal",
      projectId: "proj_internal",
      email: "customer@example.com",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    })
    await provider.createInvoice({
      currency: "USD",
      customerName: "Test Customer",
      email: "customer@example.com",
      collectionMethod: "charge_automatically",
      description: "January statement",
      dueDate: 1_770_000_000_000,
    })
    await provider.addInvoiceItem({
      invoiceId: "in_contract",
      name: "Events",
      isProrated: false,
      totalAmount: 1200,
      quantity: 3,
      currency: "USD",
      metadata: { billing_period_id: "bp_123" },
      period: { start: 1_770_000_000, end: 1_772_678_400 },
    })
    await provider.updateInvoiceItem({
      invoiceItemId: "ii_existing",
      totalAmount: 900,
      name: "Events",
      isProrated: false,
      quantity: 3,
      metadata: { billing_period_id: "bp_123" },
      period: { start: 1_770_000_000, end: 1_772_678_400 },
    })
    await provider.finalizeInvoice({ invoiceId: "in_contract" })
    await provider.collectPayment({ invoiceId: "in_contract", paymentMethodId: "pm_card_visa" })
    await provider.sendInvoice({ invoiceId: "in_contract" })
    await provider.getInvoice({ invoiceId: "in_contract" })

    const connectedAccount = { stripeAccount: "acct_contract" }
    expect(client.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_stripe_contract" }),
      connectedAccount
    )
    expect(client.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_stripe_contract" }),
      connectedAccount
    )
    expect(client.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ invoice: "in_contract", amount: 1200 }),
      connectedAccount
    )
    expect(client.invoiceItems.update).toHaveBeenCalledWith(
      "ii_existing",
      expect.objectContaining({ amount: 900, quantity: 3 }),
      connectedAccount
    )
    expect(client.invoices.finalizeInvoice).toHaveBeenCalledWith(
      "in_contract",
      undefined,
      connectedAccount
    )
    expect(client.invoices.pay).toHaveBeenCalledWith(
      "in_contract",
      { payment_method: "pm_card_visa" },
      connectedAccount
    )
    expect(client.invoices.sendInvoice).toHaveBeenCalledWith(
      "in_contract",
      undefined,
      connectedAccount
    )
    expect(client.invoices.retrieve).toHaveBeenCalledWith(
      "in_contract",
      undefined,
      connectedAccount
    )
  })

  it("maps Stripe invoice fixtures to provider invoice and item shapes", async () => {
    const provider = new StripePaymentProvider({
      token: "sk_test_contract",
      providerCustomerId: "cus_stripe_contract",
      logger: createMockLogger(),
    })
    const client = createStripeClientStub()
    client.invoices.retrieve.mockResolvedValue(
      stripeInvoiceFixture({
        id: "in_shape",
        status: "paid",
        paid: true,
        total: 700,
        hosted_invoice_url: null,
        invoice_pdf: "https://invoice.stripe.com/i/in_shape.pdf",
        payment_intent: "pi_shape",
        lines: {
          data: [
            stripeInvoiceLineFixture(),
            stripeInvoiceLineFixture({
              id: "il_adjustment",
              amount: -500,
              description: null,
              currency: "eur",
              quantity: null,
              price: { product: { id: "prod_adjustment" } },
              metadata: { kind: "proration_credit", billing_period_id: "bp_adjustment" },
            }),
          ],
        },
      })
    )
    setStripeClient(provider, client)

    const invoice = await provider.getInvoice({ invoiceId: "in_shape" })
    expect(invoice.err).toBeUndefined()
    expect(invoice.val).toEqual({
      invoiceId: "in_shape",
      invoiceUrl: "https://invoice.stripe.com/i/in_shape.pdf",
      status: "paid",
      total: 700,
      items: [
        {
          id: "il_usage",
          amount: 1200,
          description: "Usage overage",
          currency: "USD",
          quantity: 3,
          productId: "prod_usage",
          metadata: {
            billing_period_id: "bp_123",
            subscription_id: "sub_123",
            subscription_item_id: "item_123",
            kind: "subscription",
          },
        },
        {
          id: "il_adjustment",
          amount: -500,
          description: "",
          currency: "EUR",
          quantity: 0,
          productId: "prod_adjustment",
          metadata: { kind: "proration_credit", billing_period_id: "bp_adjustment" },
        },
      ],
    })

    const status = await provider.getStatusInvoice({ invoiceId: "in_shape" })
    expect(status.err).toBeUndefined()
    expect(status.val).toMatchObject({
      invoiceId: "in_shape",
      invoiceUrl: "https://invoice.stripe.com/i/in_shape.pdf",
      status: "paid",
      paidAt: 1_770_000_456,
      paymentAttempts: [{ status: "succeeded", createdAt: 1_770_000_456 }],
    })
    expect(client.paymentIntents.retrieve).toHaveBeenCalledWith("pi_shape", undefined, undefined)
  })
})
