import { type Database, and, eq, inArray, isNull, sql } from "@unprice/db"
import { ledgerEntries, ledgers } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import type { Currency, LedgerEntry, LedgerSettlementType } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Metrics } from "../metrics"
import { toErrorContext } from "../utils/log-context"
import { UnPriceLedgerError } from "./errors"

type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0]
type LedgerEntryType = "debit" | "credit"
type InvoiceItemKind = "period" | "tax" | "discount" | "refund" | "adjustment" | "trial"

interface LedgerIdentity {
  projectId: string
  customerId: string
  currency: Currency
}

interface PostLedgerEntryInput extends LedgerIdentity {
  amountCents: number
  sourceType: string
  sourceId: string
  now?: number
  db?: DbExecutor
  description?: string | null
  statementKey?: string | null
  subscriptionId?: string | null
  subscriptionPhaseId?: string | null
  subscriptionItemId?: string | null
  billingPeriodId?: string | null
  featurePlanVersionId?: string | null
  invoiceItemKind?: InvoiceItemKind
  cycleStartAt?: number | null
  cycleEndAt?: number | null
  quantity?: number | null
  unitAmountCents?: number | null
  amountSubtotalCents?: number | null
  amountTotalCents?: number | null
  metadata?: Record<string, unknown>
}

export class LedgerService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly metrics: Metrics

  constructor({
    db,
    logger,
    metrics,
  }: {
    db: Database
    logger: Logger
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.metrics = metrics
  }

  public async postDebit(
    input: PostLedgerEntryInput
  ): Promise<Result<LedgerEntry, UnPriceLedgerError>> {
    return this.postEntry({ ...input, entryType: "debit" })
  }

  public async postCredit(
    input: PostLedgerEntryInput
  ): Promise<Result<LedgerEntry, UnPriceLedgerError>> {
    return this.postEntry({ ...input, entryType: "credit" })
  }

  public async getUnsettledEntries(input: {
    projectId: string
    customerId: string
    currency: Currency
    statementKey?: string
    subscriptionId?: string
    db?: DbExecutor
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const executor = input.db ?? this.db

      const entries = await executor.query.ledgerEntries.findMany({
        where: (entry, ops) =>
          ops.and(
            ops.eq(entry.projectId, input.projectId),
            ops.eq(entry.customerId, input.customerId),
            ops.eq(entry.currency, input.currency),
            ops.isNull(entry.settledAt),
            input.statementKey ? ops.eq(entry.statementKey, input.statementKey) : undefined,
            input.subscriptionId ? ops.eq(entry.subscriptionId, input.subscriptionId) : undefined
          ),
        orderBy: (entry, ops) => [ops.asc(entry.createdAtM), ops.asc(entry.id)],
      })

      return Ok(entries)
    } catch (error) {
      this.logger.error("ledger.get_unsettled_entries_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        customerId: input.customerId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_UNSETTLED_ENTRIES_FAILED" }))
    }
  }

  public async getUnsettledBalance(input: {
    projectId: string
    customerId: string
    currency: Currency
    db?: DbExecutor
  }): Promise<Result<number, UnPriceLedgerError>> {
    try {
      const executor = input.db ?? this.db
      const ledger = await this.getLedgerByIdentity(executor, input)
      return Ok(ledger?.unsettledBalanceCents ?? 0)
    } catch (error) {
      this.logger.error("ledger.get_unsettled_balance_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        customerId: input.customerId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_UNSETTLED_BALANCE_FAILED" }))
    }
  }

  public async markSettled(input: {
    projectId: string
    entryIds: string[]
    settlementType: LedgerSettlementType
    settlementArtifactId: string
    settlementPendingProviderConfirmation?: boolean
    now?: number
    db?: DbExecutor
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    if (input.entryIds.length === 0) {
      return Ok([])
    }

    const now = input.now ?? Date.now()
    const executor = input.db ?? this.db

    try {
      const settle = async (tx: DbExecutor) => {
        const entries = await tx.query.ledgerEntries.findMany({
          where: (entry, ops) =>
            ops.and(ops.eq(entry.projectId, input.projectId), inArray(entry.id, input.entryIds)),
        })

        if (entries.length === 0) {
          return []
        }

        const unsettledEntries = entries.filter((entry) => entry.settledAt === null)

        if (unsettledEntries.length > 0) {
          await tx
            .update(ledgerEntries)
            .set({
              settlementType: input.settlementType,
              settlementArtifactId: input.settlementArtifactId,
              settlementPendingProviderConfirmation:
                input.settlementPendingProviderConfirmation ?? false,
              settledAt: now,
            })
            .where(
              and(
                eq(ledgerEntries.projectId, input.projectId),
                inArray(
                  ledgerEntries.id,
                  unsettledEntries.map((entry) => entry.id)
                ),
                isNull(ledgerEntries.settledAt)
              )
            )

          const signedByLedger = unsettledEntries.reduce((acc, entry) => {
            acc.set(entry.ledgerId, (acc.get(entry.ledgerId) ?? 0) + entry.signedAmountCents)
            return acc
          }, new Map<string, number>())

          for (const [ledgerId, signedAmount] of signedByLedger.entries()) {
            await tx
              .update(ledgers)
              .set({
                unsettledBalanceCents: sql`${ledgers.unsettledBalanceCents} - ${signedAmount}`,
              })
              .where(and(eq(ledgers.projectId, input.projectId), eq(ledgers.id, ledgerId)))
          }
        }

        return tx.query.ledgerEntries.findMany({
          where: (entry, ops) =>
            ops.and(ops.eq(entry.projectId, input.projectId), inArray(entry.id, input.entryIds)),
        })
      }

      // If the caller already passed a transaction, run directly on it
      // to avoid unnecessary nested transactions. Otherwise, wrap in one.
      const result = input.db ? await settle(executor) : await executor.transaction(settle)

      return Ok(result)
    } catch (error) {
      this.logger.error("ledger.mark_settled_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        settlementArtifactId: input.settlementArtifactId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_MARK_SETTLED_FAILED" }))
    }
  }

  private async postEntry(
    input: PostLedgerEntryInput & { entryType: LedgerEntryType }
  ): Promise<Result<LedgerEntry, UnPriceLedgerError>> {
    const now = input.now ?? Date.now()
    const executor = input.db ?? this.db
    const amountCents = this.normalizeAmount(input.amountCents)

    if (amountCents < 0) {
      return Err(new UnPriceLedgerError({ message: "LEDGER_INVALID_AMOUNT" }))
    }

    if (!input.sourceType || !input.sourceId) {
      return Err(new UnPriceLedgerError({ message: "LEDGER_SOURCE_IDENTITY_REQUIRED" }))
    }

    const signedAmount = input.entryType === "debit" ? amountCents : -amountCents
    const idempotencyKey = await hashStringSHA256(`${input.sourceType}:${input.sourceId}`)

    try {
      const entry = await executor.transaction(async (tx) => {
        await this.ensureLedger(tx, input)

        // Serialize writes per ledger to keep running balances deterministic.
        await tx.execute(
          sql`
            select ${ledgers.id}
            from ${ledgers}
            where ${ledgers.projectId} = ${input.projectId}
              and ${ledgers.customerId} = ${input.customerId}
              and ${ledgers.currency} = ${input.currency}
            for update
          `
        )

        const ledger = await tx.query.ledgers.findFirst({
          where: (table, ops) =>
            ops.and(
              ops.eq(table.projectId, input.projectId),
              ops.eq(table.customerId, input.customerId),
              ops.eq(table.currency, input.currency)
            ),
        })

        if (!ledger) {
          throw new UnPriceLedgerError({ message: "LEDGER_NOT_FOUND" })
        }

        const existingEntry = await tx.query.ledgerEntries.findFirst({
          where: (entry, ops) =>
            ops.and(
              ops.eq(entry.projectId, input.projectId),
              ops.eq(entry.ledgerId, ledger.id),
              ops.eq(entry.sourceType, input.sourceType),
              ops.eq(entry.sourceId, input.sourceId)
            ),
        })

        if (existingEntry) {
          return existingEntry
        }

        const nextBalanceCents = ledger.balanceCents + signedAmount
        const nextUnsettledBalanceCents = ledger.unsettledBalanceCents + signedAmount

        const insertedEntry = await tx
          .insert(ledgerEntries)
          .values({
            id: newId("ledger_entry"),
            projectId: input.projectId,
            ledgerId: ledger.id,
            customerId: input.customerId,
            currency: input.currency,
            entryType: input.entryType,
            amountCents,
            signedAmountCents: signedAmount,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            idempotencyKey,
            description: input.description ?? null,
            statementKey: input.statementKey ?? null,
            subscriptionId: input.subscriptionId ?? null,
            subscriptionPhaseId: input.subscriptionPhaseId ?? null,
            subscriptionItemId: input.subscriptionItemId ?? null,
            billingPeriodId: input.billingPeriodId ?? null,
            featurePlanVersionId: input.featurePlanVersionId ?? null,
            invoiceItemKind: input.invoiceItemKind ?? "period",
            cycleStartAt: input.cycleStartAt ?? null,
            cycleEndAt: input.cycleEndAt ?? null,
            quantity: input.quantity ?? 1,
            unitAmountCents: input.unitAmountCents ?? null,
            amountSubtotalCents: input.amountSubtotalCents ?? amountCents,
            amountTotalCents: input.amountTotalCents ?? amountCents,
            balanceAfterCents: nextBalanceCents,
            settlementType: null,
            settlementArtifactId: null,
            settlementPendingProviderConfirmation: false,
            settledAt: null,
            metadata: input.metadata ?? null,
            createdAtM: now,
            updatedAtM: now,
          })
          .onConflictDoNothing()
          .returning()
          .then((rows) => rows[0])

        if (!insertedEntry) {
          const idempotentEntry = await tx.query.ledgerEntries.findFirst({
            where: (entry, ops) =>
              ops.and(
                ops.eq(entry.projectId, input.projectId),
                ops.eq(entry.ledgerId, ledger.id),
                ops.eq(entry.sourceType, input.sourceType),
                ops.eq(entry.sourceId, input.sourceId)
              ),
          })

          if (!idempotentEntry) {
            throw new UnPriceLedgerError({ message: "LEDGER_ENTRY_UPSERT_FAILED" })
          }

          return idempotentEntry
        }

        await tx
          .update(ledgers)
          .set({
            balanceCents: nextBalanceCents,
            unsettledBalanceCents: nextUnsettledBalanceCents,
            lastEntryAt: now,
          })
          .where(and(eq(ledgers.projectId, input.projectId), eq(ledgers.id, ledger.id)))

        return insertedEntry
      })

      return Ok(entry)
    } catch (error) {
      this.logger.error("ledger.post_entry_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        customerId: input.customerId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      })

      if (error instanceof UnPriceLedgerError) {
        return Err(error)
      }

      return Err(new UnPriceLedgerError({ message: "LEDGER_POST_ENTRY_FAILED" }))
    }
  }

  private normalizeAmount(amount: number): number {
    if (!Number.isFinite(amount)) {
      return -1
    }

    return Math.trunc(amount)
  }

  private async ensureLedger(db: DbExecutor, identity: LedgerIdentity) {
    await db
      .insert(ledgers)
      .values({
        id: newId("ledger"),
        projectId: identity.projectId,
        customerId: identity.customerId,
        currency: identity.currency,
        balanceCents: 0,
        unsettledBalanceCents: 0,
      })
      .onConflictDoNothing({
        target: [ledgers.projectId, ledgers.customerId, ledgers.currency],
      })
  }

  private async getLedgerByIdentity(db: DbExecutor, identity: LedgerIdentity) {
    return db.query.ledgers.findFirst({
      where: (table, ops) =>
        ops.and(
          ops.eq(table.projectId, identity.projectId),
          ops.eq(table.customerId, identity.customerId),
          ops.eq(table.currency, identity.currency)
        ),
    })
  }
}
