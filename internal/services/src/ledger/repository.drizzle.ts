import { type Database, and, eq, inArray, sql } from "@unprice/db"
import {
  ledgerEntries,
  ledgerSettlementLines,
  ledgerSettlements,
  ledgers,
} from "@unprice/db/schema"
import type {
  Ledger,
  LedgerEntry,
  LedgerSettlement,
  LedgerSettlementLine,
} from "@unprice/db/validators"
import type {
  AddToLedgerBalanceInput,
  EnsureLedgerInput,
  FindAllEntriesInput,
  FindEntriesByIdsInput,
  FindEntriesByJournalInput,
  FindEntryBySourceInput,
  FindLedgerByIdInput,
  FindLedgerInput,
  FindSettlementInput,
  FindSettlementLinesInput,
  FindUnsettledEntriesInput,
  InsertEntryInput,
  InsertSettlementInput,
  InsertSettlementLinesInput,
  LedgerRepository,
  UpdateLedgerBalanceInput,
  UpdateSettlementInput,
} from "./repository"

type DbExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0]

export class DrizzleLedgerRepository implements LedgerRepository {
  constructor(private readonly db: DbExecutor) {}

  async withTransaction<T>(fn: (txRepo: LedgerRepository) => Promise<T>): Promise<T> {
    return (this.db as Database).transaction(async (tx) => {
      return fn(new DrizzleLedgerRepository(tx))
    })
  }

  async ensureLedger(input: EnsureLedgerInput): Promise<void> {
    await this.db
      .insert(ledgers)
      .values({
        id: input.id,
        projectId: input.projectId,
        customerId: input.customerId,
        currency: input.currency,
        balanceMinor: BigInt(0),
      })
      .onConflictDoNothing({
        target: [ledgers.projectId, ledgers.customerId, ledgers.currency],
      })
  }

  async lockLedger(input: FindLedgerInput): Promise<void> {
    await this.db.execute(
      sql`
        SELECT ${ledgers.id}
        FROM ${ledgers}
        WHERE ${ledgers.projectId} = ${input.projectId}
          AND ${ledgers.customerId} = ${input.customerId}
          AND ${ledgers.currency} = ${input.currency}
        FOR UPDATE
      `
    )
  }

  async findLedger(input: FindLedgerInput): Promise<Ledger | null> {
    const result = await this.db.query.ledgers.findFirst({
      where: (table, ops) =>
        ops.and(
          ops.eq(table.projectId, input.projectId),
          ops.eq(table.customerId, input.customerId),
          ops.eq(table.currency, input.currency)
        ),
    })
    return (result as Ledger) ?? null
  }

  async findLedgerById(input: FindLedgerByIdInput): Promise<Ledger | null> {
    const result = await this.db.query.ledgers.findFirst({
      where: (l, ops) =>
        ops.and(ops.eq(l.projectId, input.projectId), ops.eq(l.id, input.ledgerId)),
    })
    return (result as Ledger) ?? null
  }

  async updateLedgerBalance(input: UpdateLedgerBalanceInput): Promise<void> {
    await this.db
      .update(ledgers)
      .set({
        balanceMinor: input.balanceMinor,
        lastEntryAt: input.lastEntryAt,
        updatedAtM: input.updatedAtM,
      })
      .where(and(eq(ledgers.projectId, input.projectId), eq(ledgers.id, input.ledgerId)))
  }

  async addToLedgerBalance(input: AddToLedgerBalanceInput): Promise<void> {
    await this.db
      .update(ledgers)
      .set({
        balanceMinor: sql`${ledgers.balanceMinor} + ${input.deltaMinor}`,
        updatedAtM: input.updatedAtM,
      })
      .where(and(eq(ledgers.projectId, input.projectId), eq(ledgers.id, input.ledgerId)))
  }

  async findEntryBySource(input: FindEntryBySourceInput): Promise<LedgerEntry | null> {
    const result = await this.db.query.ledgerEntries.findFirst({
      where: (entry, ops) =>
        ops.and(
          ops.eq(entry.projectId, input.projectId),
          ops.eq(entry.ledgerId, input.ledgerId),
          ops.eq(entry.sourceType, input.sourceType),
          ops.eq(entry.sourceId, input.sourceId)
        ),
    })
    return (result as LedgerEntry) ?? null
  }

  async insertEntry(input: InsertEntryInput): Promise<LedgerEntry | null> {
    const rows = await this.db.insert(ledgerEntries).values(input).onConflictDoNothing().returning()
    return (rows[0] as LedgerEntry) ?? null
  }

  async findUnsettledEntries(input: FindUnsettledEntriesInput): Promise<LedgerEntry[]> {
    const conditions = [
      sql`${ledgerEntries.projectId} = ${input.projectId}`,
      sql`${ledgerEntries.customerId} = ${input.customerId}`,
      sql`${ledgerEntries.currency} = ${input.currency}`,
    ]

    if (input.statementKey) {
      conditions.push(sql`${ledgerEntries.statementKey} = ${input.statementKey}`)
    }

    if (input.subscriptionId) {
      conditions.push(sql`${ledgerEntries.metadata}->>'subscriptionId' = ${input.subscriptionId}`)
    }

    const entries = await this.db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          ...conditions,
          sql`NOT EXISTS (
            SELECT 1 FROM ${ledgerSettlementLines}
            WHERE ${ledgerSettlementLines.ledgerEntryId} = ${ledgerEntries.id}
              AND ${ledgerSettlementLines.projectId} = ${ledgerEntries.projectId}
          )`
        )
      )
      .orderBy(ledgerEntries.createdAtM, ledgerEntries.id)

    return entries as LedgerEntry[]
  }

  async findEntriesByIds(input: FindEntriesByIdsInput): Promise<LedgerEntry[]> {
    const entries = await this.db.query.ledgerEntries.findMany({
      where: (entry, ops) =>
        ops.and(ops.eq(entry.projectId, input.projectId), inArray(entry.id, input.entryIds)),
    })
    return entries as LedgerEntry[]
  }

  async findEntriesByJournal(input: FindEntriesByJournalInput): Promise<LedgerEntry[]> {
    const entries = await this.db.query.ledgerEntries.findMany({
      where: (entry, ops) =>
        ops.and(ops.eq(entry.projectId, input.projectId), ops.eq(entry.journalId, input.journalId)),
      orderBy: (entry, { asc }) => [asc(entry.createdAtM), asc(entry.id)],
    })
    return entries as LedgerEntry[]
  }

  async findAllEntries(
    input: FindAllEntriesInput
  ): Promise<Pick<LedgerEntry, "signedAmountMinor">[]> {
    return this.db.query.ledgerEntries.findMany({
      where: (entry, ops) =>
        ops.and(ops.eq(entry.projectId, input.projectId), ops.eq(entry.ledgerId, input.ledgerId)),
      columns: { signedAmountMinor: true },
    })
  }

  async insertSettlement(input: InsertSettlementInput): Promise<void> {
    await this.db.insert(ledgerSettlements).values(input).onConflictDoNothing()
  }

  async findSettlement(input: FindSettlementInput): Promise<LedgerSettlement | null> {
    const conditions = [
      eq(ledgerSettlements.projectId, input.projectId),
      eq(ledgerSettlements.artifactId, input.artifactId),
      eq(ledgerSettlements.type, input.type),
    ]

    if (input.ledgerId) {
      conditions.push(eq(ledgerSettlements.ledgerId, input.ledgerId))
    }

    const result = await this.db.query.ledgerSettlements.findFirst({
      where: (_s, ops) => ops.and(...conditions),
    })
    return (result as LedgerSettlement) ?? null
  }

  async updateSettlement(input: UpdateSettlementInput): Promise<void> {
    const setData: Record<string, unknown> = {
      status: input.status,
      updatedAtM: input.updatedAtM,
    }
    if (input.confirmedAt !== undefined) setData.confirmedAt = input.confirmedAt
    if (input.reversedAt !== undefined) setData.reversedAt = input.reversedAt
    if (input.reversalReason !== undefined) setData.reversalReason = input.reversalReason

    await this.db
      .update(ledgerSettlements)
      .set(setData)
      .where(
        and(
          eq(ledgerSettlements.projectId, input.projectId),
          eq(ledgerSettlements.id, input.settlementId)
        )
      )
  }

  async insertSettlementLines(input: InsertSettlementLinesInput): Promise<void> {
    await this.db.insert(ledgerSettlementLines).values(input.lines).onConflictDoNothing()
  }

  async findSettlementLines(input: FindSettlementLinesInput): Promise<LedgerSettlementLine[]> {
    return this.db.query.ledgerSettlementLines.findMany({
      where: (l, ops) =>
        ops.and(ops.eq(l.projectId, input.projectId), ops.eq(l.settlementId, input.settlementId)),
    })
  }
}
