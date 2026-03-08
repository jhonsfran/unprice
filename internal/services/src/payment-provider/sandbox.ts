import { newId } from "@unprice/db/utils"
import type { Currency } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { type FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Stripe } from "@unprice/stripe"
import type { UnPricePaymentProviderError } from "./errors"
import type {
  AddInvoiceItemOpts,
  CreateInvoiceOpts,
  CreateSessionOpts,
  GetSessionOpts,
  GetStatusInvoice,
  InvoiceProviderStatus,
  PaymentMethod,
  PaymentProviderCreateSession,
  PaymentProviderGetSession,
  PaymentProviderInterface,
  PaymentProviderInvoice,
  SignUpOpts,
  UpdateInvoiceItemOpts,
  UpdateInvoiceOpts,
} from "./interface"

export class SandboxPaymentProvider implements PaymentProviderInterface {
  private readonly logger: Logger
  private providerCustomerId?: string | null

  constructor(opts: { logger: Logger; providerCustomerId?: string | null }) {
    this.logger = opts.logger
    this.providerCustomerId = opts.providerCustomerId
  }

  public setCustomerId(customerId: string) {
    this.providerCustomerId = customerId
  }

  public async upsertProduct(
    props: Stripe.ProductCreateParams & { id: string }
  ): Promise<Result<{ productId: string }, FetchError>> {
    this.logger.info("Sandbox: upsertProduct", props as unknown as Record<string, unknown>)
    return Ok({ productId: props.id })
  }

  public async signUp(opts: SignUpOpts): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    this.logger.info("Sandbox: signUp", opts as unknown as Record<string, unknown>)
    return Ok({
      success: true,
      url: opts.successUrl,
      customerId: opts.customer.id,
    })
  }

  public async createSession(
    opts: CreateSessionOpts
  ): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    this.logger.info("Sandbox: createSession", opts as unknown as Record<string, unknown>)
    return Ok({
      success: true,
      url: opts.successUrl,
      customerId: opts.customerId,
    })
  }

  public async getSession(
    opts: GetSessionOpts
  ): Promise<Result<PaymentProviderGetSession, FetchError>> {
    this.logger.info("Sandbox: getSession", opts as unknown as Record<string, unknown>)
    return Ok({
      metadata: {},
      customerId: "sandbox_customer",
      subscriptionId: null,
    })
  }

  public async listPaymentMethods(opts: { limit?: number }): Promise<
    Result<PaymentMethod[], FetchError | UnPricePaymentProviderError>
  > {
    this.logger.info("Sandbox: listPaymentMethods", opts as unknown as Record<string, unknown>)
    return Ok([
      {
        id: "pm_sandbox_1234",
        name: "Sandbox Card",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
        brand: "visa",
      },
    ])
  }

  public async createInvoice(
    opts: CreateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: createInvoice", opts as unknown as Record<string, unknown>)
    const invoiceId = newId("invoice")
    return Ok({
      invoiceId,
      invoiceUrl: `https://example.com/sandbox/invoice/${invoiceId}`,
      status: "open",
      total: 0,
      items: [],
    })
  }

  public async updateInvoice(
    opts: UpdateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: updateInvoice", opts as unknown as Record<string, unknown>)
    return Ok({
      invoiceId: opts.invoiceId,
      invoiceUrl: `https://example.com/sandbox/invoice/${opts.invoiceId}`,
      status: "open",
      total: 0,
      items: [],
    })
  }

  public async addInvoiceItem(
    opts: AddInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: addInvoiceItem", opts as unknown as Record<string, unknown>)
    return Ok(undefined)
  }

  public async updateInvoiceItem(
    opts: UpdateInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: updateInvoiceItem", opts as unknown as Record<string, unknown>)
    return Ok(undefined)
  }

  public async collectPayment(opts: {
    invoiceId: string
    paymentMethodId: string
  }): Promise<
    Result<
      { invoiceId: string; status: InvoiceProviderStatus; invoiceUrl: string },
      FetchError | UnPricePaymentProviderError
    >
  > {
    this.logger.info("Sandbox: collectPayment", opts as unknown as Record<string, unknown>)
    return Ok({
      invoiceId: opts.invoiceId,
      status: "paid",
      invoiceUrl: `https://example.com/sandbox/invoice/${opts.invoiceId}`,
    })
  }

  public async getStatusInvoice(opts: {
    invoiceId: string
  }): Promise<Result<GetStatusInvoice, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: getStatusInvoice", opts as unknown as Record<string, unknown>)
    return Ok({
      status: "paid",
      invoiceId: opts.invoiceId,
      paidAt: Math.floor(Date.now() / 1000),
      invoiceUrl: `https://example.com/sandbox/invoice/${opts.invoiceId}`,
      paymentAttempts: [
        {
          status: "succeeded",
          createdAt: Math.floor(Date.now() / 1000),
        },
      ],
      items: [],
    })
  }

  public async getInvoice(opts: {
    invoiceId: string
  }): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: getInvoice", opts as unknown as Record<string, unknown>)
    return Ok({
      invoiceId: opts.invoiceId,
      invoiceUrl: `https://example.com/sandbox/invoice/${opts.invoiceId}`,
      status: "paid",
      total: 1000,
      items: [
        {
          id: "ii_sandbox_1",
          amount: 1000,
          description: "Sandbox Item",
          currency: "USD" as Currency,
          quantity: 1,
          productId: "prod_sandbox_1",
          metadata: {},
        },
      ],
    })
  }

  public async sendInvoice(opts: {
    invoiceId: string
  }): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: sendInvoice", opts as unknown as Record<string, unknown>)
    return Ok(undefined)
  }

  public async finalizeInvoice(opts: {
    invoiceId: string
  }): Promise<Result<{ invoiceId: string }, FetchError | UnPricePaymentProviderError>> {
    this.logger.info("Sandbox: finalizeInvoice", opts as unknown as Record<string, unknown>)
    return Ok({ invoiceId: opts.invoiceId })
  }

  public async getDefaultPaymentMethodId(): Promise<
    Result<{ paymentMethodId: string }, FetchError | UnPricePaymentProviderError>
  > {
    this.logger.info("Sandbox: getDefaultPaymentMethodId")
    return Ok({ paymentMethodId: "pm_sandbox_default" })
  }
}
