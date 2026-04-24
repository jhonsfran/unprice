import { newId } from "@unprice/db/utils"
import type { Currency } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { Err, type FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { UnPricePaymentProviderError } from "./errors"
import type {
  AddInvoiceItemOpts,
  CreateInvoiceOpts,
  CreateSessionOpts,
  GetSessionOpts,
  GetStatusInvoice,
  InvoiceProviderStatus,
  NormalizedProviderWebhook,
  PaymentMethod,
  PaymentProviderCapabilities,
  PaymentProviderCreateSession,
  PaymentProviderGetSession,
  PaymentProviderInterface,
  PaymentProviderInvoice,
  SignUpOpts,
  UpdateInvoiceItemOpts,
  UpdateInvoiceOpts,
  VerifiedProviderWebhook,
  VerifyWebhookOpts,
} from "./interface"

export class SandboxPaymentProvider implements PaymentProviderInterface {
  public readonly provider = "sandbox"
  public readonly capabilities: PaymentProviderCapabilities = {
    billingPortal: true,
    savedPaymentMethods: true,
    invoiceItemMutation: true,
    asyncPaymentConfirmation: false,
  }

  private readonly logger: Logger
  private providerCustomerId?: string | null
  private readonly webhookSecret?: string

  constructor(opts: {
    logger: Logger
    providerCustomerId?: string | null
    webhookSecret?: string
  }) {
    this.logger = opts.logger
    this.providerCustomerId = opts.providerCustomerId
    this.webhookSecret = opts.webhookSecret
  }

  public getCustomerId(): string | undefined {
    return this.providerCustomerId ?? undefined
  }

  public setCustomerId(customerId: string) {
    this.providerCustomerId = customerId
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
    // Deterministic session id for the sandbox — derived from the caller's
    // topup_id when present so test harnesses can settle without a real
    // provider roundtrip.
    const sessionId = opts.metadata?.topup_id
      ? `sandbox_session_${opts.metadata.topup_id}`
      : `sandbox_session_${newId("event")}`
    return Ok({
      success: true,
      url: opts.successUrl,
      customerId: opts.customerId,
      sessionId,
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

  public async verifyWebhook(
    opts: VerifyWebhookOpts
  ): Promise<Result<VerifiedProviderWebhook, FetchError | UnPricePaymentProviderError>> {
    const signature = opts.signature ?? opts.headers?.["sandbox-signature"]
    const signatureToUse = Array.isArray(signature) ? signature.at(0) : signature

    if (this.webhookSecret && signatureToUse && signatureToUse !== this.webhookSecret) {
      return Err(new UnPricePaymentProviderError({ message: "Invalid sandbox webhook signature" }))
    }

    try {
      const parsedPayload = JSON.parse(opts.rawBody) as Record<string, unknown>
      const eventId = typeof parsedPayload.id === "string" ? parsedPayload.id : newId("event")
      const eventType =
        typeof parsedPayload.type === "string" ? parsedPayload.type : "sandbox.event"

      return Ok({
        eventId,
        eventType,
        occurredAt: Date.now(),
        payload: parsedPayload,
      })
    } catch {
      return Err(new UnPricePaymentProviderError({ message: "Invalid sandbox webhook payload" }))
    }
  }

  public normalizeWebhook(
    event: VerifiedProviderWebhook
  ): Result<NormalizedProviderWebhook, UnPricePaymentProviderError> {
    const payload = event.payload as Record<string, unknown>
    const normalizedEventType: NormalizedProviderWebhook["eventType"] = (() => {
      switch (event.eventType) {
        case "sandbox.payment.succeeded":
          return "payment.succeeded"
        case "sandbox.payment.failed":
          return "payment.failed"
        case "sandbox.payment.reversed":
          return "payment.reversed"
        case "sandbox.payment.dispute_reversed":
          return "payment.dispute_reversed"
        default:
          return "noop"
      }
    })()

    const metadataRaw = payload.metadata
    const metadata: Record<string, string> | undefined =
      metadataRaw && typeof metadataRaw === "object"
        ? Object.fromEntries(
            Object.entries(metadataRaw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined

    return Ok({
      provider: this.provider,
      eventId: event.eventId,
      eventType: normalizedEventType,
      providerEventType: event.eventType,
      occurredAt: event.occurredAt,
      customerId: typeof payload.customerId === "string" ? payload.customerId : undefined,
      subscriptionId:
        typeof payload.subscriptionId === "string" ? payload.subscriptionId : undefined,
      invoiceId: typeof payload.invoiceId === "string" ? payload.invoiceId : undefined,
      invoiceUrl: typeof payload.invoiceUrl === "string" ? payload.invoiceUrl : undefined,
      providerSessionId:
        typeof payload.providerSessionId === "string" ? payload.providerSessionId : undefined,
      amountPaid: typeof payload.amountPaid === "number" ? payload.amountPaid : undefined,
      metadata,
      failureCode: typeof payload.failureCode === "string" ? payload.failureCode : undefined,
      failureMessage:
        typeof payload.failureMessage === "string" ? payload.failureMessage : undefined,
      payload: event.payload,
    })
  }
}
