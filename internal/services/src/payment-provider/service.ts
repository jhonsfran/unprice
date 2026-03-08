import type { PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, type Result } from "@unprice/error"
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
import { SandboxPaymentProvider } from "./sandbox"
import { StripePaymentProvider } from "./stripe"

export class PaymentProviderService implements PaymentProviderInterface {
  private readonly logger: Logger
  private readonly paymentProvider: PaymentProvider
  private readonly stripe?: StripePaymentProvider
  private readonly sandbox?: SandboxPaymentProvider
  private readonly providerCustomerId?: string

  constructor(opts: {
    token: string
    providerCustomerId?: string
    logger: Logger
    paymentProvider: PaymentProvider
  }) {
    this.logger = opts.logger
    this.paymentProvider = opts.paymentProvider

    switch (this.paymentProvider) {
      case "stripe": {
        this.providerCustomerId = opts.providerCustomerId ?? undefined

        this.stripe = new StripePaymentProvider({
          token: opts.token,
          providerCustomerId: this.providerCustomerId,
          logger: this.logger,
        })
        break
      }
      case "sandbox": {
        this.providerCustomerId = opts.providerCustomerId ?? undefined

        this.sandbox = new SandboxPaymentProvider({
          logger: this.logger,
          providerCustomerId: this.providerCustomerId,
        })
        break
      }
      default:
        throw new Error("Payment provider not supported")
    }
  }

  public getCustomerId(): string | undefined {
    return this.providerCustomerId
  }

  public setCustomerId(customerId: string) {
    switch (this.paymentProvider) {
      case "stripe": {
        this.stripe?.setCustomerId(customerId)
        break
      }
      case "sandbox": {
        this.sandbox?.setCustomerId(customerId)
        break
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async getSession(
    opts: GetSessionOpts
  ): Promise<Result<PaymentProviderGetSession, FetchError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        const result = await this.stripe!.getSession(opts)
        return result
      }
      case "sandbox": {
        return await this.sandbox!.getSession(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async createSession(
    opts: CreateSessionOpts
  ): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        const result = await this.stripe!.createSession(opts)
        return result
      }
      case "sandbox": {
        return await this.sandbox!.createSession(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async signUp(opts: SignUpOpts): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.signUp(opts)
      }
      case "sandbox": {
        return await this.sandbox!.signUp(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async upsertProduct(
    props: Stripe.ProductCreateParams & { id: string }
  ): Promise<Result<{ productId: string }, FetchError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.upsertProduct(props)
      }
      case "sandbox": {
        return await this.sandbox!.upsertProduct(props)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async listPaymentMethods(opts: { limit?: number }): Promise<
    Result<PaymentMethod[], FetchError | UnPricePaymentProviderError>
  > {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.listPaymentMethods(opts)
      }
      case "sandbox": {
        return await this.sandbox!.listPaymentMethods(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async createInvoice(
    opts: CreateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.createInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.createInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async updateInvoice(
    opts: UpdateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.updateInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.updateInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async addInvoiceItem(
    opts: AddInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.addInvoiceItem(opts)
      }
      case "sandbox": {
        return await this.sandbox!.addInvoiceItem(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async updateInvoiceItem(
    opts: UpdateInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.updateInvoiceItem(opts)
      }
      case "sandbox": {
        return await this.sandbox!.updateInvoiceItem(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async getDefaultPaymentMethodId(): Promise<
    Result<{ paymentMethodId: string }, FetchError | UnPricePaymentProviderError>
  > {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.getDefaultPaymentMethodId()
      }
      case "sandbox": {
        return await this.sandbox!.getDefaultPaymentMethodId()
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async finalizeInvoice(opts: {
    invoiceId: string
  }): Promise<Result<{ invoiceId: string }, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.finalizeInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.finalizeInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async sendInvoice(opts: {
    invoiceId: string
  }): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.sendInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.sendInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
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
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.collectPayment(opts)
      }
      case "sandbox": {
        return await this.sandbox!.collectPayment(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async getStatusInvoice(opts: {
    invoiceId: string
  }): Promise<Result<GetStatusInvoice, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.getStatusInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.getStatusInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }

  public async getInvoice(opts: {
    invoiceId: string
  }): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    switch (this.paymentProvider) {
      case "stripe": {
        return await this.stripe!.getInvoice(opts)
      }
      case "sandbox": {
        return await this.sandbox!.getInvoice(opts)
      }
      default: {
        return Err(new FetchError({ message: "Payment provider not supported", retry: false }))
      }
    }
  }
}
