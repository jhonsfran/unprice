import { type Database, and, eq, inArray, lte, sql } from "@unprice/db"
import { billingPeriods, invoices } from "@unprice/db/schema"
import type { InvoiceStatus } from "@unprice/db/validators"
import type { BillingPeriod, SubscriptionInvoice } from "@unprice/db/validators"
import type {
  BillingPeriodWithItem,
  BillingRepository,
  CapPendingPeriodsAtPhaseEndInput,
  CreateInvoiceInput,
  CreatePeriodsBatchInput,
  FindInvoiceByIdInput,
  FindInvoiceByProviderIdInput,
  FindInvoiceByStatementKeyInput,
  FindInvoiceWithDetailsInput,
  GetLastPeriodForItemInput,
  InvoiceWithDetails,
  ListInvoicedPeriodsExceedingPhaseEndInput,
  ListPendingPeriodGroupsInput,
  ListPendingPeriodsForStatementInput,
  MarkPeriodsInvoicedInput,
  PeriodGroupRow,
  ShortenBillingPeriodInput,
  UpdateInvoiceInput,
  VoidPendingPeriodsInput,
} from "./repository"
import { billingStrategyFor } from "./strategy"

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
    // Periods billed at period_end need their `invoiceAt` capped so they
    // don't fire after the phase has been shortened. Period-start invoicing
    // already fired at cycle start, so leave it alone.
    const capStrategy = billingStrategyFor(input.whenToBill)
    await this.db
      .update(billingPeriods)
      .set({
        cycleEndAt: sql`LEAST(${billingPeriods.cycleEndAt}, ${input.phaseEndAt})`,
        invoiceAt:
          capStrategy.billPhaseTrigger === "period_end"
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
    // ON CONFLICT DO UPDATE with a no-op SET so RETURNING always yields the
    // row (existing or newly inserted). The previous DO NOTHING + fallback
    // SELECT pattern had a window where the SELECT could miss a concurrently
    // committed row, which would silently return early from billPeriod and
    // strand periods in `pending`. The unique key
    // (projectId, subscriptionId, customerId, statementKey) guarantees a
    // single canonical invoice per statement.
    const rows = await this.db
      .insert(invoices)
      .values(input)
      .onConflictDoUpdate({
        target: [
          invoices.projectId,
          invoices.subscriptionId,
          invoices.customerId,
          invoices.statementKey,
        ],
        set: { projectId: sql`${invoices.projectId}` },
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
      with: { customer: true },
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

  async updateInvoiceIfStatus(input: {
    invoiceId: string
    projectId: string
    allowedFromStatuses: ReadonlyArray<InvoiceStatus>
    data: UpdateInvoiceInput["data"]
  }): Promise<SubscriptionInvoice | null> {
    if (input.allowedFromStatuses.length === 0) {
      return null
    }
    const rows = await this.db
      .update(invoices)
      .set(input.data)
      .where(
        and(
          eq(invoices.id, input.invoiceId),
          eq(invoices.projectId, input.projectId),
          inArray(invoices.status, input.allowedFromStatuses as InvoiceStatus[])
        )
      )
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
}
