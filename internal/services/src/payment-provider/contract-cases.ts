import type { Logger } from "@unprice/logs"
import { Stripe } from "@unprice/stripe"
import { vi } from "vitest"
import type { PaymentProviderContractSuite } from "./contract-suite"
import { SandboxPaymentProvider } from "./sandbox"
import type { ActivePaymentProvider } from "./service"
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
  paymentMethods: {
    list: ReturnType<typeof vi.fn>
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
    paymentMethods: {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: "pm_contract",
            billing_details: { name: "Contract Card" },
            card: {
              brand: "visa",
              exp_month: 12,
              exp_year: 2030,
              last4: "4242",
            },
          },
        ],
      }),
    },
  } satisfies StripeClientStub
}

const sandboxWebhookSecret = "sandbox_contract_secret"
const sandboxInvoiceId = "provider_invoice_contract"

function createSandboxProvider(providerCustomerId = "provider_customer_contract") {
  return new SandboxPaymentProvider({
    logger: createMockLogger(),
    providerCustomerId,
    webhookSecret: sandboxWebhookSecret,
  })
}

const stripeWebhookSecret = "whsec_provider_contract"
const stripeWebhookCreated = Math.floor(Date.now() / 1000)
const stripeWebhookPayload = JSON.stringify({
  id: "evt_stripe_contract_paid",
  object: "event",
  api_version: "2023-10-16",
  created: stripeWebhookCreated,
  type: "invoice.paid",
  data: {
    object: {
      id: "in_contract_paid",
      object: "invoice",
      customer: { id: "cus_stripe_contract" },
      subscription: "sub_stripe_contract",
      hosted_invoice_url: "https://invoice.stripe.com/i/in_contract_paid",
      metadata: {
        invoice_id: "inv_contract",
        kind: "subscription",
        nested: { ignored: true },
      },
    },
  },
})
const stripeWebhookSignature = new Stripe("sk_test_contract", {
  apiVersion: "2023-10-16",
}).webhooks.generateTestHeaderString({
  payload: stripeWebhookPayload,
  secret: stripeWebhookSecret,
  timestamp: stripeWebhookCreated,
})

function createStripeProvider({
  patchClient = false,
  providerCustomerId,
}: {
  patchClient?: boolean
  providerCustomerId?: string
} = {}) {
  const provider = new StripePaymentProvider({
    token: "sk_test_contract",
    providerCustomerId,
    webhookSecret: stripeWebhookSecret,
    logger: createMockLogger(),
  })

  if (patchClient) {
    setStripeClient(provider, createStripeClientStub())
  }

  return provider
}

export const paymentProviderContractSuites = {
  sandbox: {
    name: "SandboxPaymentProvider",
    provider: "sandbox",
    capabilities: {
      billingPortal: true,
      savedPaymentMethods: true,
      invoiceItemMutation: true,
      asyncPaymentConfirmation: false,
      webhookSetup: "manual",
    },
    createProvider: () => createSandboxProvider(),
    sessions: {
      createSessionInput: {
        cancelUrl: "https://app.example.com/cancel",
        currency: "USD",
        customerId: "cus_contract",
        email: "customer@example.com",
        projectId: "proj_contract",
        successUrl: "https://app.example.com/success",
      },
      signUpInput: {
        cancelUrl: "https://app.example.com/signup/cancel",
        customer: {
          currency: "USD",
          email: "customer@example.com",
          id: "cus_contract_signup",
          projectId: "proj_contract",
        },
        customerSessionId: "customer_session_contract",
        successUrl: "https://app.example.com/signup/success",
      },
      walletTopupSessionInput: {
        amount: 2_500_000_000,
        cancelUrl: "https://app.example.com/wallet/cancel",
        currency: "USD",
        customerId: "cus_contract",
        description: "Wallet top-up",
        email: "customer@example.com",
        kind: "wallet_topup",
        metadata: {
          topup_id: "wtup_contract",
        },
        projectId: "proj_contract",
        successUrl: "https://app.example.com/wallet/success",
      },
    },
    invoices: {
      invoiceId: sandboxInvoiceId,
      createInvoiceInput: {
        collectionMethod: "charge_automatically",
        currency: "USD",
        customerName: "Contract Customer",
        description: "Contract invoice",
        email: "customer@example.com",
      },
      updateInvoiceInput: {
        collectionMethod: "charge_automatically",
        description: "Updated contract invoice",
        invoiceId: sandboxInvoiceId,
      },
      addInvoiceItemInput: {
        currency: "USD",
        invoiceId: sandboxInvoiceId,
        isProrated: false,
        metadata: {
          billing_period_id: "bp_contract",
          kind: "subscription",
        },
        name: "Contract usage",
        quantity: 3,
        totalAmount: 1_200,
      },
      updateInvoiceItemInput: {
        invoiceItemId: "provider_invoice_item_contract",
        isProrated: false,
        metadata: {
          billing_period_id: "bp_contract",
          kind: "subscription",
        },
        name: "Contract usage",
        quantity: 3,
        totalAmount: 900,
      },
      collectPaymentInput: {
        invoiceId: sandboxInvoiceId,
        paymentMethodId: "pm_sandbox_contract",
      },
    },
    webhook: {
      rawBody: JSON.stringify({
        amountPaid: 2_500_000_000,
        customerId: "provider_customer_contract",
        id: "evt_sandbox_contract_paid",
        invoiceId: sandboxInvoiceId,
        invoiceUrl: "https://provider.example.com/invoices/provider_invoice_contract",
        metadata: {
          invoice_id: "inv_contract",
          kind: "subscription",
          nested: { ignored: true },
        },
        subscriptionId: "provider_subscription_contract",
        type: "sandbox.payment.succeeded",
      }),
      headers: {
        "sandbox-signature": sandboxWebhookSecret,
      },
      expectedVerified: {
        eventId: "evt_sandbox_contract_paid",
        eventType: "sandbox.payment.succeeded",
      },
      expectedNormalized: {
        amountPaid: 2_500_000_000,
        customerId: "provider_customer_contract",
        eventId: "evt_sandbox_contract_paid",
        eventType: "payment.succeeded",
        invoiceId: sandboxInvoiceId,
        invoiceUrl: "https://provider.example.com/invoices/provider_invoice_contract",
        metadata: {
          invoice_id: "inv_contract",
          kind: "subscription",
        },
        providerEventType: "sandbox.payment.succeeded",
        subscriptionId: "provider_subscription_contract",
      },
      invalid: {
        headers: {
          "sandbox-signature": "wrong_secret",
        },
        message: /invalid sandbox webhook signature/i,
      },
    },
  },
  stripe: {
    name: "StripePaymentProvider",
    provider: "stripe",
    capabilities: {
      billingPortal: true,
      savedPaymentMethods: true,
      invoiceItemMutation: true,
      asyncPaymentConfirmation: true,
      webhookSetup: "platform_managed",
    },
    createProvider: () => createStripeProvider(),
    createSessionProvider: () => createStripeProvider({ patchClient: true }),
    createInvoiceProvider: () =>
      createStripeProvider({
        patchClient: true,
        providerCustomerId: "cus_stripe_contract",
      }),
    createWebhookProvider: () => createStripeProvider(),
    sessions: {
      createSessionInput: {
        cancelUrl: "https://app.example.com/cancel",
        currency: "USD",
        customerId: "cus_internal_contract",
        email: "customer@example.com",
        projectId: "proj_internal_contract",
        successUrl: "https://app.example.com/success",
      },
      signUpInput: {
        cancelUrl: "https://app.example.com/signup/cancel",
        customer: {
          currency: "USD",
          email: "customer@example.com",
          id: "cus_internal_signup_contract",
          projectId: "proj_internal_contract",
        },
        customerSessionId: "customer_session_contract",
        successUrl: "https://app.example.com/signup/success",
      },
      walletTopupSessionInput: {
        amount: 2_500_000_000,
        cancelUrl: "https://app.example.com/wallet/cancel",
        currency: "EUR",
        customerId: "cus_internal_contract",
        description: "Wallet top-up",
        email: "customer@example.com",
        kind: "wallet_topup",
        metadata: {
          customer_id: "cus_internal_contract",
          project_id: "proj_internal_contract",
          requested_amount: "2500000000",
          topup_id: "wtup_contract",
        },
        projectId: "proj_internal_contract",
        successUrl: "https://app.example.com/wallet/success",
      },
    },
    invoices: {
      invoiceId: "in_contract",
      createInvoiceInput: {
        collectionMethod: "charge_automatically",
        currency: "USD",
        customerName: "Contract Customer",
        description: "Contract invoice",
        email: "customer@example.com",
      },
      updateInvoiceInput: {
        collectionMethod: "charge_automatically",
        description: "Updated contract invoice",
        invoiceId: "in_contract",
      },
      addInvoiceItemInput: {
        currency: "USD",
        invoiceId: "in_contract",
        isProrated: false,
        metadata: {
          billing_period_id: "bp_contract",
          kind: "subscription",
        },
        name: "Contract usage",
        quantity: 3,
        totalAmount: 1_200,
      },
      updateInvoiceItemInput: {
        invoiceItemId: "ii_contract",
        isProrated: false,
        metadata: {
          billing_period_id: "bp_contract",
          kind: "subscription",
        },
        name: "Contract usage",
        quantity: 3,
        totalAmount: 900,
      },
      collectPaymentInput: {
        invoiceId: "in_contract",
        paymentMethodId: "pm_contract",
      },
    },
    webhook: {
      rawBody: stripeWebhookPayload,
      headers: {
        "stripe-signature": stripeWebhookSignature,
      },
      expectedVerified: {
        eventId: "evt_stripe_contract_paid",
        eventType: "invoice.paid",
        occurredAt: stripeWebhookCreated * 1000,
      },
      expectedNormalized: {
        customerId: "cus_stripe_contract",
        eventId: "evt_stripe_contract_paid",
        eventType: "payment.succeeded",
        invoiceId: "in_contract_paid",
        invoiceUrl: "https://invoice.stripe.com/i/in_contract_paid",
        metadata: {
          invoice_id: "inv_contract",
          kind: "subscription",
        },
        providerEventType: "invoice.paid",
        subscriptionId: "sub_stripe_contract",
      },
      invalid: {
        rawBody: stripeWebhookPayload.replace("invoice.paid", "invoice.payment_failed"),
        headers: {
          "stripe-signature": stripeWebhookSignature,
        },
        message: /signature/i,
      },
    },
  },
} satisfies Record<ActivePaymentProvider, PaymentProviderContractSuite>
