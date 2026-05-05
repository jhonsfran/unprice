import type {
  BillingPeriod,
  CollectionMethod,
  Currency,
  Customer,
  InvoiceStatus,
  PaymentProvider,
  SubscriptionInvoice,
} from "@unprice/db/validators"

export interface BillingPeriodWithItem extends BillingPeriod {
  subscriptionItem: {
    id: string
    units: number | null
    featurePlanVersion: {
      id: string
      featureType: string
      billingConfig: Record<string, unknown>
      feature: { slug: string; title: string }
    }
  }
}

export interface InvoiceWithDetails extends SubscriptionInvoice {
  customer: Customer
}

export interface ListPendingPeriodGroupsInput {
  lateEventGraceMs?: number
  projectId: string
  subscriptionId: string
  now: number
  limit?: number
}

export interface PeriodGroupRow {
  projectId: string
  subscriptionId: string
  subscriptionPhaseId: string
  statementKey: string
  invoiceAt: number
}

export interface ListPendingPeriodsForStatementInput {
  projectId: string
  subscriptionId: string
  subscriptionPhaseId: string
  statementKey: string
}

export interface VoidPendingPeriodsInput {
  projectId: string
  subscriptionId: string
  subscriptionPhaseId: string
  statementKey: string
}

export interface MarkPeriodsInvoicedInput {
  projectId: string
  subscriptionId: string
  periodIds: string[]
  invoiceId: string
}

export interface CapPendingPeriodsAtPhaseEndInput {
  phaseId: string
  phaseEndAt: number
  whenToBill: "pay_in_advance" | "pay_in_arrear"
}

export interface ListInvoicedPeriodsExceedingPhaseEndInput {
  phaseId: string
  phaseEndAt: number
}

export interface ShortenBillingPeriodInput {
  periodId: string
  cycleEndAt: number
}

export interface GetLastPeriodForItemInput {
  projectId: string
  subscriptionId: string
  subscriptionPhaseId: string
  subscriptionItemId: string
}

export interface CreatePeriodsBatchInput {
  periods: Array<{
    id: string
    projectId: string
    subscriptionId: string
    customerId: string
    subscriptionPhaseId: string
    subscriptionItemId: string
    status: "pending"
    type: "normal" | "trial"
    cycleStartAt: number
    cycleEndAt: number
    statementKey: string
    invoiceAt: number
    whenToBill: "pay_in_advance" | "pay_in_arrear"
    invoiceId: string | null
    amountEstimate: number | null
    reason: "normal" | "mid_cycle_change" | "trial" | null
  }>
}

/**
 * Invoices are header-only rows. Lines are projected from the ledger on read —
 * no `invoice_items` storage. Totals are reconciled from ledger projection
 * when needed; `totalAmount` is a ledger-scale snapshot stamped at
 * materialization time.
 */
export interface CreateInvoiceInput {
  id: string
  projectId: string
  subscriptionId: string
  customerId: string
  requiredPaymentMethod: boolean
  paymentMethodId: string | null
  status: "draft"
  statementDateString: string
  statementKey: string
  statementStartAt: number
  statementEndAt: number
  whenToBill: "pay_in_advance" | "pay_in_arrear"
  collectionMethod: CollectionMethod
  invoicePaymentProviderId: string
  invoicePaymentProviderUrl: string
  paymentProvider: PaymentProvider
  currency: Currency
  pastDueAt: number
  dueAt: number
  paidAt: number | null
  totalAmount: number
  issueDate: number | null
  metadata: Record<string, unknown> | null
}

export interface FindInvoiceByStatementKeyInput {
  projectId: string
  subscriptionId: string
  customerId: string
  statementKey: string
}

export interface FindInvoiceByIdInput {
  invoiceId: string
  projectId: string
}

export interface FindInvoiceWithDetailsInput {
  invoiceId: string
  projectId: string
}

export interface UpdateInvoiceInput {
  invoiceId: string
  projectId: string
  data: Partial<
    Pick<
      SubscriptionInvoice,
      | "status"
      | "paidAt"
      | "sentAt"
      | "issueDate"
      | "totalAmount"
      | "invoicePaymentProviderId"
      | "invoicePaymentProviderUrl"
      | "metadata"
      | "updatedAtM"
    >
  >
}

export interface UpdateInvoiceIfStatusInput {
  invoiceId: string
  projectId: string
  allowedFromStatuses: ReadonlyArray<InvoiceStatus>
  data: UpdateInvoiceInput["data"]
}

export interface FindInvoiceByProviderIdInput {
  projectId: string
  invoicePaymentProviderId: string
}

export interface BillingRepository {
  withTransaction<T>(fn: (txRepo: BillingRepository) => Promise<T>): Promise<T>

  listPendingPeriodGroups(input: ListPendingPeriodGroupsInput): Promise<PeriodGroupRow[]>

  listPendingPeriodsForStatement(
    input: ListPendingPeriodsForStatementInput
  ): Promise<BillingPeriodWithItem[]>

  voidPendingPeriods(input: VoidPendingPeriodsInput): Promise<void>

  markPeriodsInvoiced(input: MarkPeriodsInvoicedInput): Promise<void>

  capPendingPeriodsAtPhaseEnd(input: CapPendingPeriodsAtPhaseEndInput): Promise<void>

  listInvoicedPeriodsExceedingPhaseEnd(
    input: ListInvoicedPeriodsExceedingPhaseEndInput
  ): Promise<BillingPeriod[]>

  shortenBillingPeriod(input: ShortenBillingPeriodInput): Promise<void>

  getLastPeriodForItem(input: GetLastPeriodForItemInput): Promise<BillingPeriod | null>

  createPeriodsBatch(input: CreatePeriodsBatchInput): Promise<void>

  createInvoice(input: CreateInvoiceInput): Promise<SubscriptionInvoice | null>

  findInvoiceByStatementKey(
    input: FindInvoiceByStatementKeyInput
  ): Promise<SubscriptionInvoice | null>

  findInvoiceById(input: FindInvoiceByIdInput): Promise<SubscriptionInvoice | null>

  findInvoiceWithDetails(input: FindInvoiceWithDetailsInput): Promise<InvoiceWithDetails | null>

  updateInvoice(input: UpdateInvoiceInput): Promise<SubscriptionInvoice | null>

  /**
   * Conditional update used by webhook handlers: applies `data` only when the
   * invoice is currently in one of `allowedFromStatuses`. Returns `null` when
   * no row matched (e.g. invoice already in target state, or in a terminal
   * state not allowed by the transition). Callers MUST treat null as "skip
   * downstream side effects" — the transition either already happened or is
   * disallowed by the state machine.
   */
  updateInvoiceIfStatus(input: UpdateInvoiceIfStatusInput): Promise<SubscriptionInvoice | null>

  findInvoiceByProviderId(input: FindInvoiceByProviderIdInput): Promise<SubscriptionInvoice | null>
}
