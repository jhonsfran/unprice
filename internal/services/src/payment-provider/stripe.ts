import {
  getPaymentProviderSetupCallbackPrefixUrl,
  getPaymentProviderSignUpCallbackPrefixUrl,
} from "@unprice/config"
import type { Currency } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { Stripe } from "@unprice/stripe"
import { toErrorContext } from "../utils/log-context"
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

export class StripePaymentProvider implements PaymentProviderInterface {
  public readonly provider = "stripe"
  public readonly capabilities: PaymentProviderCapabilities = {
    billingPortal: true,
    savedPaymentMethods: true,
    invoiceItemMutation: true,
    asyncPaymentConfirmation: true,
  }

  private readonly client: Stripe
  private providerCustomerId?: string | null
  private readonly logger: Logger
  private readonly webhookSecret?: string

  constructor(opts: {
    token: string
    providerCustomerId?: string | null
    logger: Logger
    webhookSecret?: string
  }) {
    this.providerCustomerId = opts?.providerCustomerId
    this.logger = opts?.logger
    this.webhookSecret = opts.webhookSecret

    this.client = new Stripe(opts.token, {
      apiVersion: "2023-10-16",
      typescript: true,
    })
  }

  public getCustomerId(): string | undefined {
    return this.providerCustomerId ?? undefined
  }

  public setCustomerId(customerId: string) {
    this.providerCustomerId = customerId
  }

  public async signUp(opts: SignUpOpts): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    try {
      // check if customer has a payment method already
      if (this.providerCustomerId) {
        /**
         * Customer is already configured, create a billing portal session
         */
        const session = await this.client.billingPortal.sessions.create({
          customer: this.providerCustomerId,
          return_url: opts.cancelUrl,
        })

        return Ok({ success: true as const, url: session.url, customerId: opts.customer.id })
      }

      // do not use `new URL(...).searchParams` here, because it will escape the curly braces and stripe will not replace them with the session id
      // we pass urls as metadata and the call one of our endpoints to handle the session validation and then redirect the user to the success or cancel url
      const apiCallbackUrl = `${getPaymentProviderSignUpCallbackPrefixUrl("stripe")}/{CHECKOUT_SESSION_ID}/${opts.customer.projectId}`

      // create a new session for registering a payment method
      const session = await this.client.checkout.sessions.create({
        client_reference_id: opts.customer.id,
        customer_email: opts.customer.email,
        billing_address_collection: "required",
        mode: "setup",
        tax_id_collection: {
          enabled: true,
        },
        metadata: {
          successUrl: opts.successUrl,
          cancelUrl: opts.cancelUrl,
          customerSessionId: opts.customerSessionId,
        },
        success_url: apiCallbackUrl,
        cancel_url: opts.cancelUrl,
        customer_creation: "always",
        currency: opts.customer.currency,
      })

      if (!session.url) return Ok({ success: false as const, url: "", customerId: "" })

      return Ok({ success: true as const, url: session.url, customerId: opts.customer.id })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error creating session", {
        error: toErrorContext(e),
        ...opts,
      })

      return Err(
        new FetchError({
          message: e.message,
          retry: true,
        })
      )
    }
  }

  public async createSession(
    opts: CreateSessionOpts
  ): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    if (opts.kind === "wallet_topup") {
      return this.createWalletTopupSession(opts)
    }

    try {
      // check if customer has a payment method already
      if (this.providerCustomerId) {
        /**
         * Customer is already configured, create a billing portal session
         */
        const session = await this.client.billingPortal.sessions.create({
          customer: this.providerCustomerId,
          return_url: opts.cancelUrl,
        })

        return Ok({ success: true as const, url: session.url, customerId: opts.customerId })
      }

      // do not use `new URL(...).searchParams` here, because it will escape the curly braces and stripe will not replace them with the session id
      // we pass urls as metadata and the call one of our endpoints to handle the session validation and then redirect the user to the success or cancel url
      const apiCallbackUrl = `${getPaymentProviderSetupCallbackPrefixUrl("stripe")}/{CHECKOUT_SESSION_ID}/${opts.projectId}`

      // create a new session for registering a payment method
      const session = await this.client.checkout.sessions.create({
        client_reference_id: opts.customerId,
        customer_email: opts.email,
        billing_address_collection: "required",
        mode: "setup",
        tax_id_collection: {
          enabled: true,
        },
        metadata: {
          successUrl: opts.successUrl,
          cancelUrl: opts.cancelUrl,
          customerId: opts.customerId,
          projectId: opts.projectId,
        },
        success_url: apiCallbackUrl,
        cancel_url: opts.cancelUrl,
        customer_creation: "always",
        currency: opts.currency,
      })

      if (!session.url) return Ok({ success: false as const, url: "", customerId: "" })

      return Ok({
        success: true as const,
        url: session.url,
        customerId: opts.customerId,
        sessionId: session.id,
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error creating session", {
        error: toErrorContext(e),
        ...opts,
      })

      return Err(
        new FetchError({
          message: e.message,
          retry: true,
        })
      )
    }
  }

  private async createWalletTopupSession(
    opts: CreateSessionOpts
  ): Promise<Result<PaymentProviderCreateSession, FetchError>> {
    if (!opts.amount || opts.amount <= 0) {
      return Err(
        new FetchError({
          message: "wallet_topup requires a positive amount",
          retry: false,
        })
      )
    }

    // scale-8 minor → Stripe minor (e.g. USD cents). $1 = 100_000_000 scale-8
    // = 100 cents; factor = 1e6.
    const unitAmount = Math.round(opts.amount / 1_000_000)

    try {
      const session = await this.client.checkout.sessions.create({
        mode: "payment",
        client_reference_id: opts.customerId,
        customer_email: opts.email,
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: opts.currency.toLowerCase(),
              unit_amount: unitAmount,
              product_data: {
                name: opts.description ?? "Wallet top-up",
              },
            },
          },
        ],
        metadata: {
          ...(opts.metadata ?? {}),
          // Defense-in-depth duplicates of what the caller should already
          // include; harmless if overlapping.
          kind: "wallet_topup",
          customerId: opts.customerId,
          projectId: opts.projectId,
        },
        payment_intent_data: {
          metadata: {
            ...(opts.metadata ?? {}),
            kind: "wallet_topup",
            customerId: opts.customerId,
            projectId: opts.projectId,
          },
        },
      })

      if (!session.url) return Ok({ success: false as const, url: "", customerId: opts.customerId })

      return Ok({
        success: true as const,
        url: session.url,
        customerId: opts.customerId,
        sessionId: session.id,
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError
      this.logger.error("Error creating wallet topup session", {
        error: toErrorContext(e),
        customerId: opts.customerId,
        projectId: opts.projectId,
      })
      return Err(new FetchError({ message: e.message, retry: true }))
    }
  }

  public async getSession(
    opts: GetSessionOpts
  ): Promise<Result<PaymentProviderGetSession, FetchError>> {
    try {
      const session = await this.client.checkout.sessions.retrieve(opts.sessionId)

      return Ok({
        metadata: session.metadata,
        customerId: session.customer as string,
        subscriptionId: session.subscription as string,
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error getting session", { error: toErrorContext(e), ...opts })

      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public async listPaymentMethods(opts: { limit?: number }): Promise<
    Result<PaymentMethod[], FetchError | UnPricePaymentProviderError>
  > {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    try {
      const paymentMethods = await this.client.paymentMethods.list({
        customer: this.providerCustomerId ?? undefined,
        limit: opts.limit,
      })

      return Ok(
        paymentMethods.data.map((pm) => ({
          id: pm.id,
          name: pm.billing_details.name,
          last4: pm.card?.last4,
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
          brand: pm.card?.brand,
        }))
      )
    } catch (error) {
      const e = error as Error

      this.logger.error("Error listing payment methods", {
        error: toErrorContext(e),
        ...opts,
      })

      return Err(
        new FetchError({
          message: e.message,
          retry: true,
        })
      )
    }
  }

  public async createInvoice(
    opts: CreateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    // const dueDate only if collection method is send_invoice
    let dueDate: number | undefined
    if (opts.collectionMethod === "send_invoice") {
      dueDate = opts.dueDate ? Math.floor(opts.dueDate / 1000) : undefined
    }

    // create an invoice
    const result = await this.client.invoices
      .create({
        customer: this.providerCustomerId,
        currency: opts.currency,
        auto_advance: false,
        collection_method: opts.collectionMethod,
        description: opts.description,
        due_date: dueDate,
        custom_fields: [
          {
            name: "Customer",
            value: opts.customerName,
          },
          {
            name: "Email",
            value: opts.email,
          },
          ...(opts.customFields ?? []),
        ],
      })
      .then((invoice) =>
        Ok({
          invoiceId: invoice.id,
          invoiceUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "",
          status: invoice.status,
          items: [],
          total: invoice.total,
        })
      )
      .catch((error) => {
        const e = error as Stripe.errors.StripeError

        this.logger.error("Error creating invoice", { error: toErrorContext(e), ...opts })

        return Err(new FetchError({ message: e.message, retry: false }))
      })

    return result
  }

  async updateInvoice(
    opts: UpdateInvoiceOpts
  ): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    // const dueDate only if collection method is send_invoice
    let dueDate: number | undefined
    if (opts.collectionMethod === "send_invoice") {
      dueDate = opts.dueDate ? Math.floor(opts.dueDate / 1000) : undefined
    }

    // create an invoice
    const result = await this.client.invoices
      .update(opts.invoiceId, {
        auto_advance: false,
        collection_method: opts.collectionMethod,
        description: opts.description,
        due_date: dueDate,
        custom_fields: opts.customFields,
      })
      .then((invoice) =>
        Ok({
          invoiceId: invoice.id,
          invoiceUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "",
          status: invoice.status,
          total: invoice.total,
          items: invoice.lines.data.map((item) => ({
            id: item.id,
            amount: item.amount,
            description: item.description ?? "",
            currency: item.currency as Currency,
            quantity: item.quantity ?? 0,
            productId: (item.price?.product as string) ?? "",
            metadata: item.metadata,
          })),
        })
      )
      .catch((error) => {
        const e = error as Stripe.errors.StripeError

        this.logger.error("Error updating invoice", { error: toErrorContext(e), ...opts })

        return Err(new FetchError({ message: e.message, retry: false }))
      })

    return result
  }

  async addInvoiceItem(
    opts: AddInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    const {
      invoiceId,
      name,
      productId,
      isProrated,
      unitAmount,
      quantity,
      currency,
      description,
      metadata,
      period,
    } = opts

    const descriptionItem = description ?? (isProrated ? `${name} (prorated)` : name)

    if (productId && unitAmount === undefined) {
      return Err(
        new UnPricePaymentProviderError({
          message: "Unit decimal amount is required for product based invoice items",
        })
      )
    }

    // If productId is provided use price_data; otherwise use 'amount' (can be negative)
    const payload = productId
      ? {
          customer: this.providerCustomerId,
          invoice: invoiceId,
          quantity,
          price_data: {
            currency,
            product: productId,
            unit_amount: unitAmount,
          },
          description: descriptionItem,
          metadata,
          period,
        }
      : {
          customer: this.providerCustomerId,
          invoice: invoiceId,
          amount: opts.totalAmount, // <-- use 'amount' for arbitrary lines
          currency,
          description: descriptionItem,
          metadata,
          period,
        }

    return await this.client.invoiceItems
      .create(payload)
      .then(() => {
        return Ok(undefined)
      })
      .catch((error) => {
        const e = error as Stripe.errors.StripeError

        this.logger.error("Error adding invoice item", { error: toErrorContext(e), ...opts })

        return Err(new FetchError({ message: e.message, retry: false }))
      })
  }

  async updateInvoiceItem(
    opts: UpdateInvoiceItemOpts
  ): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    const {
      invoiceItemId,
      totalAmount,
      quantity,
      description,
      metadata,
      name,
      isProrated,
      period,
    } = opts
    const descriptionItem = description ?? (isProrated ? `${name} (prorated)` : name)

    return await this.client.invoiceItems
      .update(invoiceItemId, {
        amount: totalAmount,
        quantity,
        description: descriptionItem,
        metadata,
        period,
      })
      .then(() => Ok(undefined))
      .catch((error) => {
        const e = error as Stripe.errors.StripeError

        this.logger.error("Error adding invoice item", { error: toErrorContext(e), ...opts })

        return Err(new FetchError({ message: e.message, retry: false }))
      })
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
    try {
      const invoice = await this.client.invoices.pay(opts.invoiceId, {
        payment_method: opts.paymentMethodId,
      })

      return Ok({
        invoiceId: invoice.id,
        status: invoice.status ?? "open",
        invoiceUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "",
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error collecting payment", { error: toErrorContext(e), ...opts })

      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public async getStatusInvoice(opts: {
    invoiceId: string
  }): Promise<Result<GetStatusInvoice, FetchError | UnPricePaymentProviderError>> {
    try {
      const invoice = await this.client.invoices.retrieve(opts.invoiceId)

      if (!invoice.status) {
        return Err(new UnPricePaymentProviderError({ message: "Invoice status not found" }))
      }

      let paidAt: number | undefined
      let voidedAt: number | undefined
      let paymentAttempts: {
        status: string
        createdAt: number
      }[] = []

      // Check if the invoice is paid
      if (invoice.paid) {
        if (invoice.payment_intent) {
          // The payment_intent object contains details about the payment
          const paymentIntent = await this.client.paymentIntents.retrieve(
            invoice.payment_intent as string
          )

          paidAt = paymentIntent.created

          paymentAttempts = [
            {
              status: paymentIntent.status,
              createdAt: paymentIntent.created, // Unix timestamp
            },
          ]
        }
      }

      // TODO: fix this
      if (invoice.status === "void") {
        voidedAt = invoice.created
      }

      return Ok({
        status: invoice.status,
        invoiceId: invoice.id,
        paidAt,
        voidedAt,
        invoiceUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "",
        paymentAttempts,
        items: invoice.lines.data.map((item) => ({
          id: item.id,
          amount: item.amount,
          description: item.description ?? "",
          currency: item.currency as Currency,
          quantity: item.quantity ?? 0,
          productId: (item.price?.product as string) ?? "",
          metadata: item.metadata,
        })),
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error getting invoice status", { error: toErrorContext(e), ...opts })

      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public async getInvoice(opts: {
    invoiceId: string
  }): Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>> {
    try {
      const invoice = await this.client.invoices.retrieve(opts.invoiceId)

      return Ok({
        invoiceUrl: invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? "",
        status: invoice.status,
        invoiceId: invoice.id,
        total: invoice.total,
        items: invoice.lines.data.map((item) => ({
          id: item.id,
          amount: item.amount,
          description: item.description ?? "",
          currency: item.currency as Currency,
          quantity: item.quantity ?? 0,
          productId: (item.price?.product as string) ?? "",
          metadata: item.metadata,
        })),
      })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error getting invoice", { error: toErrorContext(e), ...opts })

      return Err(
        new FetchError({
          message: e.message,
          retry: false,
        })
      )
    }
  }

  public async sendInvoice(opts: {
    invoiceId: string
  }): Promise<Result<void, FetchError | UnPricePaymentProviderError>> {
    try {
      await this.client.invoices.sendInvoice(opts.invoiceId)

      return Ok(undefined)
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error sending invoice", { error: toErrorContext(e), ...opts })

      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public async finalizeInvoice(opts: {
    invoiceId: string
  }): Promise<Result<{ invoiceId: string }, FetchError | UnPricePaymentProviderError>> {
    try {
      const invoice = await this.client.invoices.finalizeInvoice(opts.invoiceId)

      return Ok({ invoiceId: invoice.id })
    } catch (error) {
      const e = error as Stripe.errors.StripeError

      this.logger.error("Error finalizing invoice", { error: toErrorContext(e), ...opts })

      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public async getDefaultPaymentMethodId(): Promise<
    Result<{ paymentMethodId: string }, FetchError | UnPricePaymentProviderError>
  > {
    if (!this.providerCustomerId)
      return Err(
        new UnPricePaymentProviderError({ message: "Customer payment provider id not set" })
      )

    const paymentMethods = await this.client.paymentMethods.list({
      customer: this.providerCustomerId,
      limit: 1,
    })

    const paymentMethod = paymentMethods.data.at(0)

    if (!paymentMethod) {
      return Err(new UnPricePaymentProviderError({ message: "No payment methods found" }))
    }

    return Ok({ paymentMethodId: paymentMethod.id })
  }

  public async verifyWebhook(
    opts: VerifyWebhookOpts
  ): Promise<Result<VerifiedProviderWebhook, FetchError | UnPricePaymentProviderError>> {
    const signature = opts.signature ?? opts.headers?.["stripe-signature"]
    const signatureToUse = Array.isArray(signature) ? signature.at(0) : signature
    const secret = opts.secret ?? this.webhookSecret

    if (!secret) {
      return Err(new UnPricePaymentProviderError({ message: "Webhook secret not configured" }))
    }

    if (!signatureToUse) {
      return Err(new UnPricePaymentProviderError({ message: "Missing webhook signature" }))
    }

    try {
      const event = this.client.webhooks.constructEvent(opts.rawBody, signatureToUse, secret)

      return Ok({
        eventId: event.id,
        eventType: event.type,
        occurredAt: event.created * 1000,
        payload: event as unknown,
      })
    } catch (error) {
      const e = error as Error
      this.logger.error("Error verifying stripe webhook", {
        error: toErrorContext(e),
      })
      return Err(new FetchError({ message: e.message, retry: false }))
    }
  }

  public normalizeWebhook(
    event: VerifiedProviderWebhook
  ): Result<NormalizedProviderWebhook, UnPricePaymentProviderError> {
    const payload = event.payload as {
      data?: {
        object?: Record<string, unknown>
      }
    }

    const object = payload.data?.object
    const customerValue = object?.customer
    const subscriptionValue = object?.subscription
    const invoiceValue = object?.invoice
    const hostedInvoiceUrl = object?.hosted_invoice_url
    const failureCode = object?.failure_code
    const failureMessage = object?.failure_message
    const paymentFailureCode = object?.last_payment_error_code
    const paymentFailureMessage = object?.last_payment_error_message

    const metadataRaw = object?.metadata
    const metadata: Record<string, string> | undefined =
      metadataRaw && typeof metadataRaw === "object"
        ? Object.fromEntries(
            Object.entries(metadataRaw as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          )
        : undefined

    const isCheckoutSession = event.eventType.startsWith("checkout.session.")
    const providerSessionId = isCheckoutSession && typeof object?.id === "string" ? object.id : undefined

    // Stripe's amount_total is in the currency's smallest unit (cents).
    // Convert to scale-8 minor by multiplying by 1e6.
    const amountTotal = typeof object?.amount_total === "number" ? object.amount_total : undefined
    const amountPaid = typeof amountTotal === "number" ? amountTotal * 1_000_000 : undefined

    const customerId =
      typeof customerValue === "string"
        ? customerValue
        : customerValue &&
            typeof customerValue === "object" &&
            "id" in customerValue &&
            typeof customerValue.id === "string"
          ? customerValue.id
          : undefined
    const subscriptionId =
      typeof subscriptionValue === "string"
        ? subscriptionValue
        : subscriptionValue &&
            typeof subscriptionValue === "object" &&
            "id" in subscriptionValue &&
            typeof subscriptionValue.id === "string"
          ? subscriptionValue.id
          : undefined
    const invoiceId =
      typeof object?.id === "string" && event.eventType.startsWith("invoice.")
        ? object.id
        : typeof invoiceValue === "string"
          ? invoiceValue
          : invoiceValue &&
              typeof invoiceValue === "object" &&
              "id" in invoiceValue &&
              typeof invoiceValue.id === "string"
            ? invoiceValue.id
            : undefined
    const invoiceUrl = typeof hostedInvoiceUrl === "string" ? hostedInvoiceUrl : undefined

    const normalizedEventType: NormalizedProviderWebhook["eventType"] = (() => {
      switch (event.eventType) {
        case "invoice.paid":
        case "invoice.payment_succeeded":
          return "payment.succeeded"
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          // Only treat checkout completions as payment events when the
          // Stripe `payment_status` confirms settlement; async flows can
          // complete with `payment_status: "unpaid"` before settlement.
          return object?.payment_status === "paid" ? "payment.succeeded" : "noop"
        case "checkout.session.async_payment_failed":
          return "payment.failed"
        case "invoice.payment_failed":
          return "payment.failed"
        case "charge.refunded":
        case "charge.dispute.created":
        case "charge.dispute.funds_withdrawn":
          return "payment.reversed"
        case "charge.dispute.funds_reinstated":
          return "payment.dispute_reversed"
        default:
          return "noop"
      }
    })()

    return Ok({
      provider: this.provider,
      eventId: event.eventId,
      eventType: normalizedEventType,
      providerEventType: event.eventType,
      occurredAt: event.occurredAt,
      customerId,
      subscriptionId,
      invoiceId,
      invoiceUrl,
      providerSessionId,
      amountPaid,
      metadata,
      failureCode:
        typeof failureCode === "string"
          ? failureCode
          : typeof paymentFailureCode === "string"
            ? paymentFailureCode
            : undefined,
      failureMessage:
        typeof failureMessage === "string"
          ? failureMessage
          : typeof paymentFailureMessage === "string"
            ? paymentFailureMessage
            : undefined,
      payload: event.payload,
    })
  }
}
