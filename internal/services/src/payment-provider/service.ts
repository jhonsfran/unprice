import type { PaymentProvider } from "@unprice/db/validators"
import type { FetchError, Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { UnPricePaymentProviderError } from "./errors"
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
import { SandboxPaymentProvider } from "./sandbox"
import { StripePaymentProvider } from "./stripe"

const PROVIDER_CAPABILITIES: Record<PaymentProvider, PaymentProviderCapabilities> = {
  stripe: {
    billingPortal: true,
    savedPaymentMethods: true,
    invoiceItemMutation: true,
    asyncPaymentConfirmation: true,
  },
  sandbox: {
    billingPortal: true,
    savedPaymentMethods: true,
    invoiceItemMutation: true,
    asyncPaymentConfirmation: false,
  },
  square: {
    billingPortal: false,
    savedPaymentMethods: false,
    invoiceItemMutation: false,
    asyncPaymentConfirmation: false,
  },
}

export function getPaymentProviderCapabilities(
  provider: PaymentProvider
): PaymentProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider]
}

export class PaymentProviderService implements PaymentProviderInterface {
  public readonly provider: PaymentProvider
  public readonly capabilities: PaymentProviderCapabilities

  private readonly adapter: PaymentProviderInterface
  private providerCustomerId?: string

  constructor(opts: {
    token: string
    providerCustomerId?: string
    logger: Logger
    paymentProvider: PaymentProvider
    webhookSecret?: string
  }) {
    this.provider = opts.paymentProvider
    this.capabilities = getPaymentProviderCapabilities(opts.paymentProvider)
    this.providerCustomerId = opts.providerCustomerId ?? undefined

    this.adapter = this.createAdapter({
      logger: opts.logger,
      paymentProvider: opts.paymentProvider,
      token: opts.token,
      providerCustomerId: this.providerCustomerId,
      webhookSecret: opts.webhookSecret,
    })
  }

  private createAdapter(opts: {
    token: string
    providerCustomerId?: string
    logger: Logger
    paymentProvider: PaymentProvider
    webhookSecret?: string
  }): PaymentProviderInterface {
    switch (opts.paymentProvider) {
      case "stripe":
        return new StripePaymentProvider({
          token: opts.token,
          providerCustomerId: opts.providerCustomerId,
          logger: opts.logger,
          webhookSecret: opts.webhookSecret,
        })
      case "sandbox":
        return new SandboxPaymentProvider({
          logger: opts.logger,
          providerCustomerId: opts.providerCustomerId,
          webhookSecret: opts.webhookSecret,
        })
      default:
        throw new Error("Payment provider not supported")
    }
  }

  public getCustomerId(): string | undefined {
    return this.providerCustomerId
  }

  public setCustomerId(customerId: string) {
    this.providerCustomerId = customerId
    this.adapter.setCustomerId(customerId)
  }

  public async getSession(
    opts: GetSessionOpts
  ): Promise<Result<PaymentProviderGetSession, FetchError>> {
    return this.adapter.getSession(opts)
  }

  public async createSession(
    opts: CreateSessionOpts
  ): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    return this.adapter.createSession(opts)
  }

  public async signUp(opts: SignUpOpts): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    return this.adapter.signUp(opts)
  }

  public async listPaymentMethods(opts: { limit?: number }): Promise<
    Result<PaymentMethod[], FetchError | UnPricePaymentProviderError>
  > {
    return this.adapter.listPaymentMethods(opts)
  }

  public async createInvoice(
    opts: CreateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.createInvoice(opts)
  }

  public async updateInvoice(
    opts: UpdateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.updateInvoice(opts)
  }

  public async addInvoiceItem(
    opts: AddInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.addInvoiceItem(opts)
  }

  public async updateInvoiceItem(
    opts: UpdateInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.updateInvoiceItem(opts)
  }

  public async getDefaultPaymentMethodId(): Promise<
    Result<{ paymentMethodId: string }, FetchError | UnPricePaymentProviderError>
  > {
    return this.adapter.getDefaultPaymentMethodId()
  }

  public async finalizeInvoice(opts: {
    invoiceId: string
  }): Promise<Result<{ invoiceId: string }, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.finalizeInvoice(opts)
  }

  public async sendInvoice(opts: {
    invoiceId: string
  }): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.sendInvoice(opts)
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
    return this.adapter.collectPayment(opts)
  }

  public async getStatusInvoice(opts: {
    invoiceId: string
  }): Promise<Result<GetStatusInvoice, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.getStatusInvoice(opts)
  }

  public async getInvoice(opts: {
    invoiceId: string
  }): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.getInvoice(opts)
  }

  public async verifyWebhook(
    opts: VerifyWebhookOpts
  ): Promise<Result<VerifiedProviderWebhook, FetchError | UnPricePaymentProviderError>> {
    return this.adapter.verifyWebhook(opts)
  }

  public normalizeWebhook(
    event: VerifiedProviderWebhook
  ): Result<NormalizedProviderWebhook, UnPricePaymentProviderError> {
    return this.adapter.normalizeWebhook(event)
  }
}
