import type { CollectionMethod, Currency, PaymentProvider } from "@unprice/db/validators"
import type { FetchError, Result } from "@unprice/error"
import type { UnPricePaymentProviderError } from "./errors"

export interface PaymentProviderCreateSession {
  success: boolean
  url: string
  customerId: string
  /**
   * Provider-side checkout session identifier. Populated when a session
   * was created (setup or wallet_topup); undefined for billing-portal
   * branches where no new session is created.
   */
  sessionId?: string
}

export interface PaymentProviderGetSession {
  metadata: {
    [name: string]: string
  } | null
  customerId: string
  subscriptionId: string | null
}

export interface GetSessionOpts {
  sessionId: string
}

/**
 * Discriminates between the two session flavors driven through the same
 * provider primitive. `setup` (default) creates a payment-method setup
 * session for future subscription charges. `wallet_topup` creates a
 * one-off payment session whose settlement credits the customer wallet.
 */
export type CreateSessionKind = "setup" | "wallet_topup"

export interface CreateSessionOpts {
  currency: string
  customerId: string
  projectId: string
  email: string
  successUrl: string
  cancelUrl: string
  /** Defaults to "setup" when omitted. */
  kind?: CreateSessionKind
  /**
   * Amount in pgledger scale-8 minor units. Required when
   * `kind === "wallet_topup"`. Providers convert to their own scale
   * at the boundary.
   */
  amount?: number
  /** Arbitrary metadata propagated through the provider back via webhook. */
  metadata?: Record<string, string>
  /** Line-item description shown on the checkout page. */
  description?: string
}

export interface SignUpOpts {
  customer: { id: string; email: string; currency: string; projectId: string }
  customerSessionId: string
  successUrl: string
  cancelUrl: string
}

export type PaymentProviderCapabilities = {
  billingPortal: boolean
  savedPaymentMethods: boolean
  invoiceItemMutation: boolean
  asyncPaymentConfirmation: boolean
}

export type PaymentProviderWebhookHeaders = Record<string, string | string[] | undefined>

export type VerifyWebhookOpts = {
  rawBody: string
  signature?: string
  headers?: PaymentProviderWebhookHeaders
  secret?: string
}

export type VerifiedProviderWebhook = {
  eventId: string
  eventType: string
  occurredAt: number
  payload: unknown
}

export type NormalizedWebhookEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.reversed"
  | "payment.dispute_reversed"
  | "noop"

export type NormalizedProviderWebhook = {
  provider: PaymentProvider
  eventId: string
  eventType: NormalizedWebhookEventType
  providerEventType: string
  occurredAt: number
  customerId?: string
  subscriptionId?: string
  invoiceId?: string
  invoiceUrl?: string
  failureCode?: string
  failureMessage?: string
  /**
   * Provider-side session identifier for checkout.session events. Used to
   * match a wallet top-up against its `wallet_topups` row.
   */
  providerSessionId?: string
  /** Amount settled by the provider, in pgledger scale-8 minor units. */
  amountPaid?: number
  /**
   * Metadata propagated from the session/payment intent. For wallet
   * top-ups this carries `kind`, `topup_id`, `customer_id`, `project_id`,
   * `currency`.
   */
  metadata?: Record<string, string>
  payload: unknown
}

export interface CreateInvoiceOpts {
  currency: Currency
  customerName: string
  email: string
  collectionMethod: CollectionMethod
  description: string
  dueDate?: number
  customFields?: {
    name: string
    value: string
  }[]
}

export interface UpdateInvoiceOpts {
  invoiceId: string
  collectionMethod: CollectionMethod
  description: string
  dueDate?: number
  customFields?: {
    name: string
    value: string
  }[]
}

export interface AddInvoiceItemOpts {
  invoiceId: string
  name: string
  productId?: string
  description?: string
  isProrated: boolean
  totalAmount: number
  unitAmount?: number
  quantity: number
  currency: Currency
  period?: {
    start: number
    end: number
  }
  metadata?: Record<string, string>
}

export interface UpdateInvoiceItemOpts {
  invoiceItemId: string
  totalAmount: number
  name: string
  isProrated: boolean
  quantity: number
  metadata?: Record<string, string>
  description?: string
  period?: {
    start: number
    end: number
  }
}

export type PaymentMethod = {
  id: string
  name: string | null
  last4?: string
  expMonth?: number
  expYear?: number
  brand?: string
}

export type GetStatusInvoice = {
  status: InvoiceProviderStatus
  invoiceId: string
  paidAt?: number
  voidedAt?: number
  invoiceUrl: string
  paymentAttempts: {
    status: string
    createdAt: number
  }[]
}

export type PaymentProviderInvoice = {
  invoiceUrl: string
  status: InvoiceProviderStatus | null
  invoiceId: string
  total: number
  items: {
    id: string
    amount: number
    description: string
    productId: string
    currency: Currency
    quantity: number
    metadata?: Record<string, string>
  }[]
}

export type InvoiceProviderStatus =
  | "open"
  | "paid"
  | "void"
  | "draft"
  | "uncollectible"
  | "past_due"

// Cache interface so you can swap out the cache implementation
export interface PaymentProviderInterface {
  readonly provider: PaymentProvider
  readonly capabilities: PaymentProviderCapabilities

  getCustomerId: () => string | undefined
  setCustomerId: (customerId: string) => void

  getSession: (opts: GetSessionOpts) => Promise<Result<PaymentProviderGetSession, FetchError>>

  createSession: (
    opts: CreateSessionOpts
  ) => Promise<Result<PaymentProviderCreateSession, FetchError>>

  signUp: (opts: SignUpOpts) => Promise<Result<PaymentProviderCreateSession, FetchError>>

  listPaymentMethods: (opts: { limit?: number }) => Promise<
    Result<PaymentMethod[], FetchError | UnPricePaymentProviderError>
  >

  createInvoice: (
    opts: CreateInvoiceOpts
  ) => Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>>

  updateInvoice: (
    opts: UpdateInvoiceOpts
  ) => Promise<Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>>

  addInvoiceItem: (
    opts: AddInvoiceItemOpts
  ) => Promise<Result<void, FetchError | UnPricePaymentProviderError>>

  getDefaultPaymentMethodId: () => Promise<
    Result<{ paymentMethodId: string }, FetchError | UnPricePaymentProviderError>
  >

  finalizeInvoice: (opts: { invoiceId: string }) => Promise<
    Result<{ invoiceId: string }, FetchError | UnPricePaymentProviderError>
  >

  sendInvoice: (opts: { invoiceId: string }) => Promise<
    Result<void, FetchError | UnPricePaymentProviderError>
  >

  collectPayment: (opts: { invoiceId: string; paymentMethodId: string }) => Promise<
    Result<
      { invoiceId: string; status: InvoiceProviderStatus; invoiceUrl: string },
      FetchError | UnPricePaymentProviderError
    >
  >

  getStatusInvoice: (opts: { invoiceId: string }) => Promise<
    Result<GetStatusInvoice, FetchError | UnPricePaymentProviderError>
  >

  getInvoice: (opts: { invoiceId: string }) => Promise<
    Result<PaymentProviderInvoice, FetchError | UnPricePaymentProviderError>
  >

  updateInvoiceItem: (
    opts: UpdateInvoiceItemOpts
  ) => Promise<Result<void, FetchError | UnPricePaymentProviderError>>

  verifyWebhook: (
    opts: VerifyWebhookOpts
  ) => Promise<Result<VerifiedProviderWebhook, FetchError | UnPricePaymentProviderError>>

  normalizeWebhook: (
    event: VerifiedProviderWebhook
  ) => Result<NormalizedProviderWebhook, UnPricePaymentProviderError>
}
