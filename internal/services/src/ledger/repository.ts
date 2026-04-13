import type { LedgerEntryMetadata } from "@unprice/db/schema"
import type {
  Currency,
  Ledger,
  LedgerEntry,
  LedgerSettlement,
  LedgerSettlementLine,
  LedgerSettlementType,
} from "@unprice/db/validators"

export interface FindLedgerInput {
  projectId: string
  customerId: string
  currency: Currency
}

export interface EnsureLedgerInput extends FindLedgerInput {
  id: string
}

export interface FindEntryBySourceInput {
  projectId: string
  ledgerId: string
  sourceType: string
  sourceId: string
}

export interface InsertEntryInput {
  id: string
  projectId: string
  ledgerId: string
  customerId: string
  currency: Currency
  entryType: "debit" | "credit"
  amountMinor: bigint
  signedAmountMinor: bigint
  sourceType: string
  sourceId: string
  idempotencyKey: string
  description: string | null
  statementKey: string | null
  balanceAfterMinor: bigint
  journalId: string | null
  metadata: LedgerEntryMetadata | null
  createdAtM: number
  updatedAtM: number
}

export interface UpdateLedgerBalanceInput {
  projectId: string
  ledgerId: string
  balanceMinor: bigint
  lastEntryAt?: number
  updatedAtM: number
}

export interface FindUnsettledEntriesInput {
  projectId: string
  customerId: string
  currency: Currency
  statementKey?: string
  subscriptionId?: string
}

export interface FindEntriesByIdsInput {
  projectId: string
  entryIds: string[]
}

export interface InsertSettlementInput {
  id: string
  projectId: string
  ledgerId: string
  type: LedgerSettlementType
  artifactId: string
  status: "pending"
  createdAtM: number
  updatedAtM: number
}

export interface FindSettlementInput {
  projectId: string
  artifactId: string
  type: LedgerSettlementType
  ledgerId?: string
}

export interface InsertSettlementLinesInput {
  lines: Array<{
    id: string
    projectId: string
    settlementId: string
    ledgerEntryId: string
    amountMinor: bigint
    createdAtM: number
  }>
}

export interface FindSettlementLinesInput {
  projectId: string
  settlementId: string
}

export interface UpdateSettlementInput {
  projectId: string
  settlementId: string
  status: string
  confirmedAt?: number
  reversedAt?: number
  reversalReason?: string
  updatedAtM: number
}

export interface FindLedgerByIdInput {
  projectId: string
  ledgerId: string
}

export interface FindAllEntriesInput {
  projectId: string
  ledgerId: string
}

export interface FindEntriesByJournalInput {
  projectId: string
  journalId: string
}

export interface AddToLedgerBalanceInput {
  projectId: string
  ledgerId: string
  deltaMinor: bigint
  updatedAtM: number
}

export interface LedgerRepository {
  withTransaction<T>(fn: (txRepo: LedgerRepository) => Promise<T>): Promise<T>

  ensureLedger(input: EnsureLedgerInput): Promise<void>
  lockLedger(input: FindLedgerInput): Promise<void>
  findLedger(input: FindLedgerInput): Promise<Ledger | null>
  findLedgerById(input: FindLedgerByIdInput): Promise<Ledger | null>
  updateLedgerBalance(input: UpdateLedgerBalanceInput): Promise<void>
  addToLedgerBalance(input: AddToLedgerBalanceInput): Promise<void>

  findEntryBySource(input: FindEntryBySourceInput): Promise<LedgerEntry | null>
  insertEntry(input: InsertEntryInput): Promise<LedgerEntry | null>
  findUnsettledEntries(input: FindUnsettledEntriesInput): Promise<LedgerEntry[]>
  findEntriesByIds(input: FindEntriesByIdsInput): Promise<LedgerEntry[]>
  findEntriesByJournal(input: FindEntriesByJournalInput): Promise<LedgerEntry[]>
  findAllEntries(input: FindAllEntriesInput): Promise<Pick<LedgerEntry, "signedAmountMinor">[]>

  insertSettlement(input: InsertSettlementInput): Promise<void>
  findSettlement(input: FindSettlementInput): Promise<LedgerSettlement | null>
  updateSettlement(input: UpdateSettlementInput): Promise<void>

  insertSettlementLines(input: InsertSettlementLinesInput): Promise<void>
  findSettlementLines(input: FindSettlementLinesInput): Promise<LedgerSettlementLine[]>
}
