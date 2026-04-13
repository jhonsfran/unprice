import type {
  BillingConfig,
  BillingPeriod,
  CollectionMethod,
  Currency,
  Customer,
  InvoiceItem,
  InvoiceItemExtended,
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
  invoiceItems: InvoiceItemExtended[]
}

export interface InvoiceItemForCreditCheck extends InvoiceItem {
  invoice: Pick<SubscriptionInvoice, "status">
  subscriptionItem: {
    featurePlanVersion: {
      featureType: string
      billingConfig: BillingConfig
    }
  } | null
}

export interface ListPendingPeriodGroupsInput {
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
    amountEstimateCents: number | null
    reason: "normal" | "mid_cycle_change" | "trial" | null
  }>
}

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
  subtotalCents: number
  totalCents: number
  amountCreditUsed: number
  paymentAttempts: { status: string; createdAt: number }[]
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
      | "subtotalCents"
      | "totalCents"
      | "amountCreditUsed"
      | "invoicePaymentProviderId"
      | "invoicePaymentProviderUrl"
      | "paymentAttempts"
      | "metadata"
      | "updatedAtM"
    >
  >
}

export interface FindInvoiceByProviderIdInput {
  projectId: string
  invoicePaymentProviderId: string
}

export interface CreateInvoiceItemsBatchInput {
  items: Array<{
    id: string
    invoiceId: string
    projectId: string
    featurePlanVersionId: string | null
    subscriptionItemId: string | null
    billingPeriodId: string | null
    quantity: number
    cycleStartAt: number
    cycleEndAt: number
    kind: "period" | "tax" | "discount" | "refund" | "adjustment" | "trial"
    unitAmountCents: number | null
    amountSubtotal: number
    amountTotal: number
    prorationFactor: number
    description: string | null
    itemProviderId: string | null
    ledgerEntryId: string | null
  }>
}

export interface ListInvoiceItemBillingPeriodIdsInput {
  invoiceId: string
  projectId: string
}

export interface BatchUpdateInvoiceItemAmountsInput {
  invoiceId: string
  projectId: string
  itemIds: string[]
  updates: Array<{
    id: string
    quantity: number
    totalAmount: number
    unitAmount: number
    subtotalAmount: number
    description?: string
  }>
}

export interface ListInvoiceItemAmountsInput {
  invoiceId: string
  projectId: string
}

export interface UpdateInvoiceItemProviderIdInput {
  itemId: string
  projectId: string
  itemProviderId: string
}

export interface FindInvoiceItemByBillingPeriodInput {
  billingPeriodId: string
  projectId: string
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

  findInvoiceByProviderId(input: FindInvoiceByProviderIdInput): Promise<SubscriptionInvoice | null>

  createInvoiceItemsBatch(input: CreateInvoiceItemsBatchInput): Promise<void>

  listInvoiceItemBillingPeriodIds(
    input: ListInvoiceItemBillingPeriodIdsInput
  ): Promise<Array<{ billingPeriodId: string | null }>>

  batchUpdateInvoiceItemAmounts(input: BatchUpdateInvoiceItemAmountsInput): Promise<void>

  listInvoiceItemAmounts(
    input: ListInvoiceItemAmountsInput
  ): Promise<Array<Pick<InvoiceItem, "amountSubtotal" | "amountTotal">>>

  updateInvoiceItemProviderId(input: UpdateInvoiceItemProviderIdInput): Promise<void>

  findInvoiceItemByBillingPeriod(
    input: FindInvoiceItemByBillingPeriodInput
  ): Promise<InvoiceItemForCreditCheck | null>
}
