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

export class InMemoryLedgerRepository implements LedgerRepository {
  readonly ledgers = new Map<string, Ledger>()
  readonly entries = new Map<string, LedgerEntry>()
  readonly settlements = new Map<string, LedgerSettlement>()
  readonly settlementLines = new Map<string, LedgerSettlementLine>()

  private ledgerKey(projectId: string, customerId: string, currency: string): string {
    return `${projectId}:${customerId}:${currency}`
  }

  async withTransaction<T>(fn: (txRepo: LedgerRepository) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async ensureLedger(input: EnsureLedgerInput): Promise<void> {
    const key = this.ledgerKey(input.projectId, input.customerId, input.currency)
    if (this.ledgers.has(key)) return
    this.ledgers.set(key, {
      id: input.id,
      projectId: input.projectId,
      customerId: input.customerId,
      currency: input.currency,
      balanceMinor: BigInt(0),
      lastEntryAt: null,
      createdAtM: Date.now(),
      updatedAtM: Date.now(),
    } as Ledger)
  }

  async lockLedger(_input: FindLedgerInput): Promise<void> {
    // no-op in memory
  }

  async findLedger(input: FindLedgerInput): Promise<Ledger | null> {
    const key = this.ledgerKey(input.projectId, input.customerId, input.currency)
    return this.ledgers.get(key) ?? null
  }

  async findLedgerById(input: FindLedgerByIdInput): Promise<Ledger | null> {
    for (const ledger of this.ledgers.values()) {
      if (ledger.projectId === input.projectId && ledger.id === input.ledgerId) {
        return ledger
      }
    }
    return null
  }

  async updateLedgerBalance(input: UpdateLedgerBalanceInput): Promise<void> {
    for (const [key, ledger] of this.ledgers.entries()) {
      if (ledger.projectId === input.projectId && ledger.id === input.ledgerId) {
        this.ledgers.set(key, {
          ...ledger,
          balanceMinor: input.balanceMinor,
          lastEntryAt: input.lastEntryAt ?? ledger.lastEntryAt,
          updatedAtM: input.updatedAtM,
        } as Ledger)
        return
      }
    }
  }

  async addToLedgerBalance(input: AddToLedgerBalanceInput): Promise<void> {
    for (const [key, ledger] of this.ledgers.entries()) {
      if (ledger.projectId === input.projectId && ledger.id === input.ledgerId) {
        this.ledgers.set(key, {
          ...ledger,
          balanceMinor: ledger.balanceMinor + input.deltaMinor,
          updatedAtM: input.updatedAtM,
        } as Ledger)
        return
      }
    }
  }

  async findEntryBySource(input: FindEntryBySourceInput): Promise<LedgerEntry | null> {
    for (const entry of this.entries.values()) {
      if (
        entry.projectId === input.projectId &&
        entry.ledgerId === input.ledgerId &&
        entry.sourceType === input.sourceType &&
        entry.sourceId === input.sourceId
      ) {
        return entry
      }
    }
    return null
  }

  async insertEntry(input: InsertEntryInput): Promise<LedgerEntry | null> {
    for (const entry of this.entries.values()) {
      if (entry.idempotencyKey === input.idempotencyKey && entry.projectId === input.projectId) {
        return null
      }
    }
    const entry = { ...input } as unknown as LedgerEntry
    this.entries.set(input.id, entry)
    return entry
  }

  async findUnsettledEntries(input: FindUnsettledEntriesInput): Promise<LedgerEntry[]> {
    const settledEntryIds = new Set<string>()
    for (const line of this.settlementLines.values()) {
      settledEntryIds.add(line.ledgerEntryId)
    }

    const results: LedgerEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.projectId !== input.projectId) continue
      if (entry.customerId !== input.customerId) continue
      if (entry.currency !== input.currency) continue
      if (settledEntryIds.has(entry.id)) continue
      if (input.statementKey && entry.statementKey !== input.statementKey) continue
      if (input.subscriptionId) {
        const meta = entry.metadata as Record<string, unknown> | null
        if (meta?.subscriptionId !== input.subscriptionId) continue
      }
      results.push(entry)
    }

    return results.sort((a, b) => {
      if (a.createdAtM !== b.createdAtM) return a.createdAtM - b.createdAtM
      return a.id.localeCompare(b.id)
    })
  }

  async findEntriesByIds(input: FindEntriesByIdsInput): Promise<LedgerEntry[]> {
    const idSet = new Set(input.entryIds)
    const results: LedgerEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.projectId === input.projectId && idSet.has(entry.id)) {
        results.push(entry)
      }
    }
    return results
  }

  async findEntriesByJournal(input: FindEntriesByJournalInput): Promise<LedgerEntry[]> {
    const results: LedgerEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.projectId === input.projectId && entry.journalId === input.journalId) {
        results.push(entry)
      }
    }
    return results.sort((a, b) => {
      if (a.createdAtM !== b.createdAtM) return a.createdAtM - b.createdAtM
      return a.id.localeCompare(b.id)
    })
  }

  async findAllEntries(
    input: FindAllEntriesInput
  ): Promise<Pick<LedgerEntry, "signedAmountMinor">[]> {
    const results: Pick<LedgerEntry, "signedAmountMinor">[] = []
    for (const entry of this.entries.values()) {
      if (entry.projectId === input.projectId && entry.ledgerId === input.ledgerId) {
        results.push({ signedAmountMinor: entry.signedAmountMinor })
      }
    }
    return results
  }

  async insertSettlement(input: InsertSettlementInput): Promise<void> {
    this.settlements.set(input.id, {
      ...input,
      reversesSettlementId: null,
      confirmedAt: null,
      reversedAt: null,
      reversalReason: null,
      metadata: null,
    } as unknown as LedgerSettlement)
  }

  async findSettlement(input: FindSettlementInput): Promise<LedgerSettlement | null> {
    for (const settlement of this.settlements.values()) {
      if (
        settlement.projectId === input.projectId &&
        settlement.artifactId === input.artifactId &&
        settlement.type === input.type &&
        (!input.ledgerId || settlement.ledgerId === input.ledgerId)
      ) {
        return settlement
      }
    }
    return null
  }

  async updateSettlement(input: UpdateSettlementInput): Promise<void> {
    for (const [key, settlement] of this.settlements.entries()) {
      if (settlement.projectId === input.projectId && settlement.id === input.settlementId) {
        const updated = { ...settlement, status: input.status, updatedAtM: input.updatedAtM }
        if (input.confirmedAt !== undefined)
          (updated as Record<string, unknown>).confirmedAt = input.confirmedAt
        if (input.reversedAt !== undefined)
          (updated as Record<string, unknown>).reversedAt = input.reversedAt
        if (input.reversalReason !== undefined)
          (updated as Record<string, unknown>).reversalReason = input.reversalReason
        this.settlements.set(key, updated as unknown as LedgerSettlement)
        return
      }
    }
  }

  async insertSettlementLines(input: InsertSettlementLinesInput): Promise<void> {
    for (const line of input.lines) {
      this.settlementLines.set(line.id, line as unknown as LedgerSettlementLine)
    }
  }

  async findSettlementLines(input: FindSettlementLinesInput): Promise<LedgerSettlementLine[]> {
    const results: LedgerSettlementLine[] = []
    for (const line of this.settlementLines.values()) {
      if (line.projectId === input.projectId && line.settlementId === input.settlementId) {
        results.push(line)
      }
    }
    return results
  }
}
