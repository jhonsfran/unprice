import { type Database, and, eq, inArray, lte, sql } from "@unprice/db"
import { billingPeriods, invoiceItems, invoices } from "@unprice/db/schema"
import type { BillingPeriod, InvoiceItem, SubscriptionInvoice } from "@unprice/db/validators"
import type {
  BatchUpdateInvoiceItemAmountsInput,
  BillingPeriodWithItem,
  BillingRepository,
  CapPendingPeriodsAtPhaseEndInput,
  CreateInvoiceInput,
  CreateInvoiceItemsBatchInput,
  CreatePeriodsBatchInput,
  FindInvoiceByIdInput,
  FindInvoiceByProviderIdInput,
  FindInvoiceByStatementKeyInput,
  FindInvoiceItemByBillingPeriodInput,
  FindInvoiceWithDetailsInput,
  GetLastPeriodForItemInput,
  InvoiceItemForCreditCheck,
  InvoiceWithDetails,
  ListInvoiceItemAmountsInput,
  ListInvoiceItemBillingPeriodIdsInput,
  ListInvoicedPeriodsExceedingPhaseEndInput,
  ListPendingPeriodGroupsInput,
  ListPendingPeriodsForStatementInput,
  MarkPeriodsInvoicedInput,
  PeriodGroupRow,
  ShortenBillingPeriodInput,
  UpdateInvoiceInput,
  UpdateInvoiceItemProviderIdInput,
  VoidPendingPeriodsInput,
} from "./repository"

type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0]

export class DrizzleBillingRepository implements BillingRepository {
  constructor(private readonly db: DbExecutor) {}

  async withTransaction<T>(fn: (txRepo: BillingRepository) => Promise<T>): Promise<T> {
    return (this.db as Database).transaction(async (tx) => {
      return fn(new DrizzleBillingRepository(tx))
    })
  }

  async listPendingPeriodGroups(input: ListPendingPeriodGroupsInput): Promise<PeriodGroupRow[]> {
    return this.db
      .select({
        projectId: billingPeriods.projectId,
        subscriptionId: billingPeriods.subscriptionId,
        subscriptionPhaseId: billingPeriods.subscriptionPhaseId,
        statementKey: billingPeriods.statementKey,
        invoiceAt: billingPeriods.invoiceAt,
      })
      .from(billingPeriods)
      .groupBy(
        billingPeriods.projectId,
        billingPeriods.subscriptionId,
        billingPeriods.subscriptionPhaseId,
        billingPeriods.statementKey,
        billingPeriods.invoiceAt
      )
      .where(
        and(
          eq(billingPeriods.status, "pending"),
          lte(billingPeriods.invoiceAt, input.now),
          eq(billingPeriods.projectId, input.projectId),
          eq(billingPeriods.subscriptionId, input.subscriptionId)
        )
      )
      .limit(input.limit ?? 500)
  }

  async listPendingPeriodsForStatement(
    input: ListPendingPeriodsForStatementInput
  ): Promise<BillingPeriodWithItem[]> {
    const rows = await this.db.query.billingPeriods.findMany({
      with: {
        subscriptionItem: {
          with: {
            featurePlanVersion: {
              with: {
                feature: true,
              },
            },
          },
        },
      },
      where: (table, ops) =>
        ops.and(
          ops.eq(table.status, "pending"),
          ops.eq(table.projectId, input.projectId),
          ops.eq(table.subscriptionId, input.subscriptionId),
          ops.eq(table.subscriptionPhaseId, input.subscriptionPhaseId),
          ops.eq(table.statementKey, input.statementKey)
        ),
    })
    return rows as BillingPeriodWithItem[]
  }

  async voidPendingPeriods(input: VoidPendingPeriodsInput): Promise<void> {
    await this.db
      .update(billingPeriods)
      .set({ status: "voided" })
      .where(
        and(
          eq(billingPeriods.projectId, input.projectId),
          eq(billingPeriods.subscriptionId, input.subscriptionId),
          eq(billingPeriods.subscriptionPhaseId, input.subscriptionPhaseId),
          eq(billingPeriods.statementKey, input.statementKey),
          eq(billingPeriods.status, "pending")
        )
      )
  }

  async markPeriodsInvoiced(input: MarkPeriodsInvoicedInput): Promise<void> {
    await this.db
      .update(billingPeriods)
      .set({
        status: "invoiced",
        invoiceId: input.invoiceId,
      })
      .where(
        and(
          inArray(billingPeriods.id, input.periodIds),
          eq(billingPeriods.projectId, input.projectId),
          eq(billingPeriods.subscriptionId, input.subscriptionId)
        )
      )
  }

  async capPendingPeriodsAtPhaseEnd(input: CapPendingPeriodsAtPhaseEndInput): Promise<void> {
    await this.db
      .update(billingPeriods)
      .set({
        cycleEndAt: sql`LEAST(${billingPeriods.cycleEndAt}, ${input.phaseEndAt})`,
        invoiceAt:
          input.whenToBill === "pay_in_arrear"
            ? sql`LEAST(${billingPeriods.invoiceAt}, ${input.phaseEndAt})`
            : billingPeriods.invoiceAt,
      })
      .where(
        and(
          eq(billingPeriods.subscriptionPhaseId, input.phaseId),
          eq(billingPeriods.status, "pending"),
          sql`${billingPeriods.cycleEndAt} > ${input.phaseEndAt}`
        )
      )
  }

  async listInvoicedPeriodsExceedingPhaseEnd(
    input: ListInvoicedPeriodsExceedingPhaseEndInput
  ): Promise<BillingPeriod[]> {
    const rows = await this.db.query.billingPeriods.findMany({
      where: (bp, ops) =>
        ops.and(
          ops.eq(bp.subscriptionPhaseId, input.phaseId),
          ops.eq(bp.status, "invoiced"),
          ops.gt(bp.cycleEndAt, input.phaseEndAt)
        ),
    })
    return rows as BillingPeriod[]
  }

  async shortenBillingPeriod(input: ShortenBillingPeriodInput): Promise<void> {
    await this.db
      .update(billingPeriods)
      .set({ cycleEndAt: input.cycleEndAt })
      .where(eq(billingPeriods.id, input.periodId))
  }

  async getLastPeriodForItem(input: GetLastPeriodForItemInput): Promise<BillingPeriod | null> {
    const result = await this.db.query.billingPeriods.findFirst({
      where: (bp, ops) =>
        ops.and(
          ops.eq(bp.projectId, input.projectId),
          ops.eq(bp.subscriptionId, input.subscriptionId),
          ops.eq(bp.subscriptionPhaseId, input.subscriptionPhaseId),
          ops.eq(bp.subscriptionItemId, input.subscriptionItemId)
        ),
      orderBy: (bp, ops) => ops.desc(bp.cycleEndAt),
    })
    return (result as BillingPeriod) ?? null
  }

  async createPeriodsBatch(input: CreatePeriodsBatchInput): Promise<void> {
    if (input.periods.length === 0) return
    await this.db
      .insert(billingPeriods)
      .values(input.periods)
      .onConflictDoNothing({
        target: [
          billingPeriods.projectId,
          billingPeriods.subscriptionId,
          billingPeriods.subscriptionPhaseId,
          billingPeriods.subscriptionItemId,
          billingPeriods.cycleStartAt,
          billingPeriods.cycleEndAt,
        ],
      })
  }

  async createInvoice(input: CreateInvoiceInput): Promise<SubscriptionInvoice | null> {
    const rows = await this.db
      .insert(invoices)
      .values(input)
      .onConflictDoNothing({
        target: [
          invoices.projectId,
          invoices.subscriptionId,
          invoices.customerId,
          invoices.statementKey,
        ],
      })
      .returning()
    return (rows[0] as SubscriptionInvoice) ?? null
  }

  async findInvoiceByStatementKey(
    input: FindInvoiceByStatementKeyInput
  ): Promise<SubscriptionInvoice | null> {
    const result = await this.db.query.invoices.findFirst({
      where: (inv, ops) =>
        ops.and(
          ops.eq(inv.statementKey, input.statementKey),
          ops.eq(inv.projectId, input.projectId),
          ops.eq(inv.subscriptionId, input.subscriptionId),
          ops.eq(inv.customerId, input.customerId)
        ),
    })
    return (result as SubscriptionInvoice) ?? null
  }

  async findInvoiceById(input: FindInvoiceByIdInput): Promise<SubscriptionInvoice | null> {
    const result = await this.db.query.invoices.findFirst({
      where: (inv, ops) =>
        ops.and(ops.eq(inv.id, input.invoiceId), ops.eq(inv.projectId, input.projectId)),
    })
    return (result as SubscriptionInvoice) ?? null
  }

  async findInvoiceWithDetails(
    input: FindInvoiceWithDetailsInput
  ): Promise<InvoiceWithDetails | null> {
    const result = await this.db.query.invoices.findFirst({
      with: {
        customer: true,
        invoiceItems: {
          with: {
            featurePlanVersion: {
              with: {
                feature: true,
              },
            },
          },
        },
      },
      where: (inv, ops) =>
        ops.and(ops.eq(inv.id, input.invoiceId), ops.eq(inv.projectId, input.projectId)),
    })
    return (result as InvoiceWithDetails) ?? null
  }

  async updateInvoice(input: UpdateInvoiceInput): Promise<SubscriptionInvoice | null> {
    const rows = await this.db
      .update(invoices)
      .set(input.data)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.projectId, input.projectId)))
      .returning()
    return (rows[0] as SubscriptionInvoice) ?? null
  }

  async findInvoiceByProviderId(
    input: FindInvoiceByProviderIdInput
  ): Promise<SubscriptionInvoice | null> {
    const result = await this.db.query.invoices.findFirst({
      where: (inv, ops) =>
        ops.and(
          ops.eq(inv.projectId, input.projectId),
          ops.eq(inv.invoicePaymentProviderId, input.invoicePaymentProviderId)
        ),
    })
    return (result as SubscriptionInvoice) ?? null
  }

  async createInvoiceItemsBatch(input: CreateInvoiceItemsBatchInput): Promise<void> {
    if (input.items.length === 0) return
    await this.db
      .insert(invoiceItems)
      .values(input.items)
      .onConflictDoNothing({
        target: [invoiceItems.projectId, invoiceItems.invoiceId, invoiceItems.billingPeriodId],
        where: sql`${invoiceItems.billingPeriodId} IS NOT NULL`,
      })
  }

  async listInvoiceItemBillingPeriodIds(
    input: ListInvoiceItemBillingPeriodIdsInput
  ): Promise<Array<{ billingPeriodId: string | null }>> {
    return this.db.query.invoiceItems.findMany({
      columns: { billingPeriodId: true },
      where: (item, ops) =>
        ops.and(ops.eq(item.invoiceId, input.invoiceId), ops.eq(item.projectId, input.projectId)),
    })
  }

  async batchUpdateInvoiceItemAmounts(input: BatchUpdateInvoiceItemAmountsInput): Promise<void> {
    if (input.updates.length === 0) return

    const quantityChunks = [sql`(case`]
    const totalAmountChunks = [sql`(case`]
    const unitAmountChunks = [sql`(case`]
    const subtotalAmountChunks = [sql`(case`]
    const descriptionChunks = [sql`(case`]

    for (const item of input.updates) {
      quantityChunks.push(
        sql`when ${invoiceItems.id} = ${item.id} then cast(${item.quantity} as int)`
      )
      totalAmountChunks.push(
        sql`when ${invoiceItems.id} = ${item.id} then cast(${item.totalAmount} as int)`
      )
      unitAmountChunks.push(
        sql`when ${invoiceItems.id} = ${item.id} then cast(${item.unitAmount} as int)`
      )
      subtotalAmountChunks.push(
        sql`when ${invoiceItems.id} = ${item.id} then cast(${item.subtotalAmount} as int)`
      )
      descriptionChunks.push(
        sql`when ${invoiceItems.id} = ${item.id} then ${item.description ?? null}`
      )
    }

    quantityChunks.push(sql`end)`)
    totalAmountChunks.push(sql`end)`)
    unitAmountChunks.push(sql`end)`)
    subtotalAmountChunks.push(sql`end)`)
    descriptionChunks.push(sql`end)`)

    await this.db
      .update(invoiceItems)
      .set({
        quantity: sql.join(quantityChunks, sql.raw(" ")),
        unitAmountCents: sql.join(unitAmountChunks, sql.raw(" ")),
        amountTotal: sql.join(totalAmountChunks, sql.raw(" ")),
        amountSubtotal: sql.join(subtotalAmountChunks, sql.raw(" ")),
        description: sql.join(descriptionChunks, sql.raw(" ")),
      })
      .where(
        and(
          eq(invoiceItems.invoiceId, input.invoiceId),
          eq(invoiceItems.projectId, input.projectId),
          inArray(invoiceItems.id, input.itemIds)
        )
      )
  }

  async listInvoiceItemAmounts(
    input: ListInvoiceItemAmountsInput
  ): Promise<Array<Pick<InvoiceItem, "amountSubtotal" | "amountTotal">>> {
    return this.db.query.invoiceItems.findMany({
      columns: { amountSubtotal: true, amountTotal: true },
      where: (item, ops) =>
        ops.and(ops.eq(item.projectId, input.projectId), ops.eq(item.invoiceId, input.invoiceId)),
    })
  }

  async updateInvoiceItemProviderId(input: UpdateInvoiceItemProviderIdInput): Promise<void> {
    await this.db
      .update(invoiceItems)
      .set({ itemProviderId: input.itemProviderId })
      .where(and(eq(invoiceItems.id, input.itemId), eq(invoiceItems.projectId, input.projectId)))
  }

  async findInvoiceItemByBillingPeriod(
    input: FindInvoiceItemByBillingPeriodInput
  ): Promise<InvoiceItemForCreditCheck | null> {
    const result = await this.db.query.invoiceItems.findFirst({
      with: {
        invoice: {
          columns: { status: true },
        },
        subscriptionItem: {
          with: {
            featurePlanVersion: {
              columns: { featureType: true, billingConfig: true },
            },
          },
        },
      },
      where: (ii, ops) =>
        ops.and(
          ops.eq(ii.billingPeriodId, input.billingPeriodId),
          ops.eq(ii.projectId, input.projectId)
        ),
    })
    return (result as InvoiceItemForCreditCheck) ?? null
  }
}
