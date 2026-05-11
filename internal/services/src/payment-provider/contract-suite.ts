import type { PaymentProvider } from "@unprice/db/validators"
import type { BaseError, Result } from "@unprice/error"
import { describe, expect, it } from "vitest"
import type {
  AddInvoiceItemOpts,
  CreateInvoiceOpts,
  CreateSessionOpts,
  InvoiceProviderStatus,
  NormalizedProviderWebhook,
  PaymentProviderCapabilities,
  PaymentProviderInterface,
  PaymentProviderInvoice,
  PaymentProviderWebhookHeaders,
  SignUpOpts,
  UpdateInvoiceItemOpts,
  UpdateInvoiceOpts,
  VerifiedProviderWebhook,
} from "./interface"

type ProviderFactory = () => PaymentProviderInterface

type SessionContractCase = {
  createSessionInput: CreateSessionOpts
  signUpInput: SignUpOpts
  walletTopupSessionInput?: CreateSessionOpts
}

type InvoiceContractCase = {
  createInvoiceInput: CreateInvoiceOpts
  updateInvoiceInput: UpdateInvoiceOpts
  addInvoiceItemInput: AddInvoiceItemOpts
  updateInvoiceItemInput: UpdateInvoiceItemOpts
  collectPaymentInput: {
    invoiceId: string
    paymentMethodId: string
  }
  invoiceId: string
  listPaymentMethodsLimit?: number
}

type WebhookContractCase = {
  rawBody: string
  headers: PaymentProviderWebhookHeaders
  expectedVerified: Partial<VerifiedProviderWebhook>
  expectedNormalized: Partial<NormalizedProviderWebhook>
  invalid?: {
    rawBody?: string
    headers: PaymentProviderWebhookHeaders
    message: RegExp
  }
}

export type PaymentProviderContractSuite = {
  name: string
  provider: PaymentProvider
  capabilities: PaymentProviderCapabilities
  createProvider: ProviderFactory
  createSessionProvider?: ProviderFactory
  createInvoiceProvider?: ProviderFactory
  createWebhookProvider?: ProviderFactory
  sessions?: SessionContractCase
  invoices?: InvoiceContractCase
  webhook: WebhookContractCase
}

function expectOk<T, E extends BaseError>(result: Result<T, E>): T {
  expect(result.err).toBeUndefined()
  if (result.err) {
    throw result.err
  }

  return result.val as T
}

function expectInvoiceProviderStatus(status: InvoiceProviderStatus | null) {
  expect(["draft", "open", "paid", "past_due", "uncollectible", "void", null]).toContain(status)
}

function expectProviderInvoiceShape(invoice: PaymentProviderInvoice) {
  expect(invoice.invoiceId).toEqual(expect.any(String))
  expect(invoice.invoiceUrl).toEqual(expect.any(String))
  expect(typeof invoice.total).toBe("number")
  expectInvoiceProviderStatus(invoice.status)
  expect(invoice.items).toEqual(expect.any(Array))

  for (const item of invoice.items) {
    expect(item).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        amount: expect.any(Number),
        description: expect.any(String),
        productId: expect.any(String),
        currency: expect.any(String),
        quantity: expect.any(Number),
      })
    )
  }
}

export function definePaymentProviderContractTests(suite: PaymentProviderContractSuite) {
  describe(`${suite.name} payment provider contract`, () => {
    it("exposes stable provider identity and capabilities", () => {
      const provider = suite.createProvider()

      expect(provider.provider).toBe(suite.provider)
      expect(provider.capabilities).toEqual(suite.capabilities)
    })

    it("keeps provider customer identity mutable through the interface", () => {
      const provider = suite.createProvider()

      provider.setCustomerId("provider_customer_contract")

      expect(provider.getCustomerId()).toBe("provider_customer_contract")
    })

    const sessions = suite.sessions
    if (sessions) {
      it("creates setup, sign-up, and optional wallet top-up sessions", async () => {
        const provider = (suite.createSessionProvider ?? suite.createProvider)()

        const setup = expectOk(await provider.createSession(sessions.createSessionInput))
        expect(setup).toEqual(
          expect.objectContaining({
            success: true,
            url: expect.any(String),
            customerId: sessions.createSessionInput.customerId,
          })
        )

        const signup = expectOk(await provider.signUp(sessions.signUpInput))
        expect(signup).toEqual(
          expect.objectContaining({
            success: true,
            url: expect.any(String),
            customerId: sessions.signUpInput.customer.id,
          })
        )

        if (sessions.walletTopupSessionInput) {
          const topup = expectOk(await provider.createSession(sessions.walletTopupSessionInput))
          expect(topup).toEqual(
            expect.objectContaining({
              success: true,
              url: expect.any(String),
              customerId: sessions.walletTopupSessionInput.customerId,
              sessionId: expect.any(String),
            })
          )
        }
      })
    }

    const invoices = suite.invoices
    if (invoices) {
      it("implements the invoice and payment-method lifecycle surface", async () => {
        const provider = (suite.createInvoiceProvider ?? suite.createProvider)()

        const paymentMethods = expectOk(
          await provider.listPaymentMethods({
            limit: invoices.listPaymentMethodsLimit ?? 1,
          })
        )
        expect(paymentMethods.length).toBeGreaterThan(0)
        expect(paymentMethods[0]).toEqual(
          expect.objectContaining({
            id: expect.any(String),
          })
        )

        const defaultPaymentMethod = expectOk(await provider.getDefaultPaymentMethodId())
        expect(defaultPaymentMethod.paymentMethodId).toEqual(expect.any(String))

        const created = expectOk(await provider.createInvoice(invoices.createInvoiceInput))
        expectProviderInvoiceShape(created)

        const updated = expectOk(await provider.updateInvoice(invoices.updateInvoiceInput))
        expectProviderInvoiceShape(updated)

        expectOk(await provider.addInvoiceItem(invoices.addInvoiceItemInput))
        expectOk(await provider.updateInvoiceItem(invoices.updateInvoiceItemInput))

        const finalized = expectOk(
          await provider.finalizeInvoice({ invoiceId: invoices.invoiceId })
        )
        expect(finalized.invoiceId).toEqual(expect.any(String))

        expectOk(await provider.sendInvoice({ invoiceId: invoices.invoiceId }))

        const collected = expectOk(await provider.collectPayment(invoices.collectPaymentInput))
        expect(collected).toEqual(
          expect.objectContaining({
            invoiceId: expect.any(String),
            status: expect.any(String),
            invoiceUrl: expect.any(String),
          })
        )
        expectInvoiceProviderStatus(collected.status)

        const status = expectOk(await provider.getStatusInvoice({ invoiceId: invoices.invoiceId }))
        expect(status).toEqual(
          expect.objectContaining({
            invoiceId: expect.any(String),
            status: expect.any(String),
            invoiceUrl: expect.any(String),
            paymentAttempts: expect.any(Array),
          })
        )
        expectInvoiceProviderStatus(status.status)

        const invoice = expectOk(await provider.getInvoice({ invoiceId: invoices.invoiceId }))
        expectProviderInvoiceShape(invoice)
      })
    }

    it("verifies a provider webhook and normalizes it to the canonical event shape", async () => {
      const provider = (suite.createWebhookProvider ?? suite.createProvider)()

      const verified = expectOk(
        await provider.verifyWebhook({
          rawBody: suite.webhook.rawBody,
          headers: suite.webhook.headers,
        })
      )
      expect(verified).toMatchObject(suite.webhook.expectedVerified)

      const normalized = expectOk(provider.normalizeWebhook(verified))
      expect(normalized).toMatchObject({
        provider: suite.provider,
        ...suite.webhook.expectedNormalized,
      })
    })

    const invalidWebhook = suite.webhook.invalid
    if (invalidWebhook) {
      it("rejects an invalid provider webhook before normalization", async () => {
        const provider = (suite.createWebhookProvider ?? suite.createProvider)()
        const invalid = await provider.verifyWebhook({
          rawBody: invalidWebhook.rawBody ?? suite.webhook.rawBody,
          headers: invalidWebhook.headers,
        })

        expect(invalid.err).toBeDefined()
        expect(invalid.err?.message).toMatch(invalidWebhook.message)
      })
    }
  })
}
