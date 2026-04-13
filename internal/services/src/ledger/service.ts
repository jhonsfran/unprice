import type { LedgerEntryMetadata } from "@unprice/db/schema"
import { hashStringSHA256, newId } from "@unprice/db/utils"
import type {
  Currency,
  LedgerEntry,
  LedgerSettlement,
  LedgerSettlementType,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { Metrics } from "../metrics"
import { toErrorContext } from "../utils/log-context"
import {
  decideConfirm,
  decideCredit,
  decideDebit,
  decideReverse,
  foldSettlementState,
} from "./core"
import { UnPriceLedgerError } from "./errors"
import type { LedgerRepository } from "./repository"

interface LedgerIdentity {
  projectId: string
  customerId: string
  currency: Currency
}

interface PostLedgerEntryInput extends LedgerIdentity {
  amountMinor: bigint
  sourceType: string
  sourceId: string
  now?: number
  repo?: LedgerRepository
  description?: string | null
  statementKey?: string | null
  journalId?: string | null
  metadata?: LedgerEntryMetadata
}

type LedgerEntryType = "debit" | "credit"

export class LedgerService {
  private readonly repo: LedgerRepository
  private readonly logger: Logger
  private readonly metrics: Metrics

  constructor({
    repo,
    logger,
    metrics,
  }: {
    repo: LedgerRepository
    logger: Logger
    metrics: Metrics
  }) {
    this.repo = repo
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
    repo?: LedgerRepository
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const repo = input.repo ?? this.repo
      const entries = await repo.findUnsettledEntries({
        projectId: input.projectId,
        customerId: input.customerId,
        currency: input.currency,
        statementKey: input.statementKey,
        subscriptionId: input.subscriptionId,
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
    repo?: LedgerRepository
  }): Promise<Result<bigint, UnPriceLedgerError>> {
    const entriesResult = await this.getUnsettledEntries(input)
    if (entriesResult.err) return Err(entriesResult.err)

    const balance = entriesResult.val.reduce(
      (sum, entry) => sum + entry.signedAmountMinor,
      BigInt(0)
    )
    return Ok(balance)
  }

  public async getEntriesByJournal(input: {
    projectId: string
    journalId: string
    repo?: LedgerRepository
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const repo = input.repo ?? this.repo
      const entries = await repo.findEntriesByJournal({
        projectId: input.projectId,
        journalId: input.journalId,
      })
      return Ok(entries)
    } catch (error) {
      this.logger.error("ledger.get_entries_by_journal_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        journalId: input.journalId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_BY_JOURNAL_FAILED" }))
    }
  }

  public async settleJournal(input: {
    projectId: string
    journalId: string
    type: LedgerSettlementType
    artifactId: string
    now?: number
    repo?: LedgerRepository
  }): Promise<Result<LedgerSettlement, UnPriceLedgerError>> {
    const entriesResult = await this.getEntriesByJournal({
      projectId: input.projectId,
      journalId: input.journalId,
      repo: input.repo,
    })

    if (entriesResult.err) return Err(entriesResult.err)

    const entryIds = entriesResult.val.map((e) => e.id)
    return this.settleEntries({
      projectId: input.projectId,
      entryIds,
      type: input.type,
      artifactId: input.artifactId,
      now: input.now,
      repo: input.repo,
    })
  }

  public async settleEntries(input: {
    projectId: string
    entryIds: string[]
    type: LedgerSettlementType
    artifactId: string
    now?: number
    repo?: LedgerRepository
  }): Promise<Result<LedgerSettlement, UnPriceLedgerError>> {
    if (input.entryIds.length === 0) {
      return Err(new UnPriceLedgerError({ message: "SETTLEMENT_CREATE_FAILED" }))
    }

    const now = input.now ?? Date.now()
    const baseRepo = input.repo ?? this.repo

    const settle = async (
      txRepo: LedgerRepository
    ): Promise<Result<LedgerSettlement, UnPriceLedgerError>> => {
      const entries = await txRepo.findEntriesByIds({
        projectId: input.projectId,
        entryIds: input.entryIds,
      })

      if (entries.length === 0) {
        return Err(new UnPriceLedgerError({ message: "SETTLEMENT_CREATE_FAILED" }))
      }

      const ledgerIds = [...new Set(entries.map((e) => e.ledgerId))]
      if (ledgerIds.length > 1) {
        return Err(new UnPriceLedgerError({ message: "ENTRIES_MIXED_LEDGERS" }))
      }
      const ledgerId = ledgerIds[0]!

      const settlementId = newId("ledger_settlement")
      await txRepo.insertSettlement({
        id: settlementId,
        projectId: input.projectId,
        ledgerId,
        type: input.type,
        artifactId: input.artifactId,
        status: "pending",
        createdAtM: now,
        updatedAtM: now,
      })

      const settlement = await txRepo.findSettlement({
        projectId: input.projectId,
        ledgerId,
        artifactId: input.artifactId,
        type: input.type,
      })

      if (!settlement) {
        return Err(new UnPriceLedgerError({ message: "SETTLEMENT_CREATE_FAILED" }))
      }

      const lineValues = entries.map((entry) => ({
        id: newId("ledger_settlement_line"),
        projectId: input.projectId,
        settlementId: settlement.id,
        ledgerEntryId: entry.id,
        amountMinor: entry.amountMinor,
        createdAtM: now,
      }))

      await txRepo.insertSettlementLines({ lines: lineValues })

      return Ok(settlement)
    }

    try {
      return input.repo ? await settle(baseRepo) : await baseRepo.withTransaction(settle)
    } catch (error) {
      this.logger.error("ledger.settle_entries_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        artifactId: input.artifactId,
      })
      if (error instanceof UnPriceLedgerError) return Err(error)
      return Err(new UnPriceLedgerError({ message: "SETTLEMENT_CREATE_FAILED" }))
    }
  }

  public async confirmSettlement(input: {
    projectId: string
    artifactId: string
    type: LedgerSettlementType
    now?: number
    repo?: LedgerRepository
  }): Promise<Result<LedgerSettlement, UnPriceLedgerError>> {
    const now = input.now ?? Date.now()
    const repo = input.repo ?? this.repo

    try {
      const settlement = await repo.findSettlement({
        projectId: input.projectId,
        artifactId: input.artifactId,
        type: input.type,
      })

      if (!settlement) {
        return Err(new UnPriceLedgerError({ message: "SETTLEMENT_NOT_FOUND" }))
      }

      const lines = await repo.findSettlementLines({
        projectId: input.projectId,
        settlementId: settlement.id,
      })

      const state = foldSettlementState(settlement, lines)
      const decision = decideConfirm(state)
      if (decision.err) return decision

      await repo.updateSettlement({
        projectId: input.projectId,
        settlementId: settlement.id,
        status: "confirmed",
        confirmedAt: now,
        updatedAtM: now,
      })

      return Ok({
        ...settlement,
        status: "confirmed" as const,
        confirmedAt: now,
      } as LedgerSettlement)
    } catch (error) {
      this.logger.error("ledger.confirm_settlement_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        artifactId: input.artifactId,
      })
      if (error instanceof UnPriceLedgerError) return Err(error)
      return Err(new UnPriceLedgerError({ message: "SETTLEMENT_CONFIRM_FAILED" }))
    }
  }

  public async reverseSettlement(input: {
    projectId: string
    artifactId: string
    type: LedgerSettlementType
    reason: string
    now?: number
    repo?: LedgerRepository
  }): Promise<
    Result<{ settlement: LedgerSettlement; reversalEntries: LedgerEntry[] }, UnPriceLedgerError>
  > {
    const now = input.now ?? Date.now()
    const baseRepo = input.repo ?? this.repo

    const reverse = async (
      txRepo: LedgerRepository
    ): Promise<
      Result<{ settlement: LedgerSettlement; reversalEntries: LedgerEntry[] }, UnPriceLedgerError>
    > => {
      const settlement = await txRepo.findSettlement({
        projectId: input.projectId,
        artifactId: input.artifactId,
        type: input.type,
      })

      if (!settlement) {
        return Err(new UnPriceLedgerError({ message: "SETTLEMENT_NOT_FOUND" }))
      }

      const lines = await txRepo.findSettlementLines({
        projectId: input.projectId,
        settlementId: settlement.id,
      })

      const state = foldSettlementState(settlement, lines)
      const decision = decideReverse(state, input.reason)
      if (decision.err) return Err(decision.err)

      const originalEntryIds = lines.map((l) => l.ledgerEntryId)
      const originalEntries = await txRepo.findEntriesByIds({
        projectId: input.projectId,
        entryIds: originalEntryIds,
      })

      if (originalEntries.length === 0) {
        return Err(new UnPriceLedgerError({ message: "SETTLEMENT_REVERSE_FAILED" }))
      }

      const ledgerId = originalEntries[0]!.ledgerId
      await txRepo.lockLedger({
        projectId: input.projectId,
        customerId: originalEntries[0]!.customerId,
        currency: originalEntries[0]!.currency,
      })

      const ledger = await txRepo.findLedgerById({
        projectId: input.projectId,
        ledgerId,
      })

      if (!ledger) {
        return Err(new UnPriceLedgerError({ message: "LEDGER_NOT_FOUND" }))
      }

      const reversalEntries: LedgerEntry[] = []
      let runningBalance = ledger.balanceMinor

      for (const originalEntry of originalEntries) {
        const reversalSign = -originalEntry.signedAmountMinor
        runningBalance = runningBalance + reversalSign

        const reversalIdempotencyKey = await hashStringSHA256(
          `reversal_v1:${settlement.id}:${originalEntry.id}`
        )

        const originalMeta = originalEntry.metadata as LedgerEntryMetadata | null

        const inserted = await txRepo.insertEntry({
          id: newId("ledger_entry"),
          projectId: input.projectId,
          ledgerId,
          customerId: originalEntry.customerId,
          currency: originalEntry.currency,
          entryType: originalEntry.entryType === "debit" ? "credit" : "debit",
          amountMinor: originalEntry.amountMinor,
          signedAmountMinor: reversalSign,
          sourceType: "reversal_v1",
          sourceId: `${settlement.id}:${originalEntry.id}`,
          idempotencyKey: reversalIdempotencyKey,
          description: `Reversal: ${input.reason}`,
          statementKey: originalEntry.statementKey,
          balanceAfterMinor: runningBalance,
          journalId: null,
          metadata: {
            ...originalMeta,
            invoiceItemKind: "refund",
            reversalOf: originalEntry.id,
            reason: input.reason,
          },
          createdAtM: now,
          updatedAtM: now,
        })

        if (inserted) {
          reversalEntries.push(inserted)
        }
      }

      const totalReversalSigned = reversalEntries.reduce(
        (sum, e) => sum + e.signedAmountMinor,
        BigInt(0)
      )

      await txRepo.addToLedgerBalance({
        projectId: input.projectId,
        ledgerId,
        deltaMinor: totalReversalSigned,
        updatedAtM: now,
      })

      await txRepo.updateSettlement({
        projectId: input.projectId,
        settlementId: settlement.id,
        status: "reversed",
        reversedAt: now,
        reversalReason: input.reason,
        updatedAtM: now,
      })

      const updatedSettlement = {
        ...settlement,
        status: "reversed" as const,
        reversedAt: now,
        reversalReason: input.reason,
      } as LedgerSettlement

      return Ok({ settlement: updatedSettlement, reversalEntries })
    }

    try {
      return input.repo ? await reverse(baseRepo) : await baseRepo.withTransaction(reverse)
    } catch (error) {
      this.logger.error("ledger.reverse_settlement_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        artifactId: input.artifactId,
      })
      if (error instanceof UnPriceLedgerError) return Err(error)
      return Err(new UnPriceLedgerError({ message: "SETTLEMENT_REVERSE_FAILED" }))
    }
  }

  public async reconcileBalance(input: {
    projectId: string
    ledgerId: string
    repo?: LedgerRepository
  }): Promise<Result<{ cached: bigint; computed: bigint }, UnPriceLedgerError>> {
    const repo = input.repo ?? this.repo

    try {
      const ledger = await repo.findLedgerById({
        projectId: input.projectId,
        ledgerId: input.ledgerId,
      })

      if (!ledger) {
        return Err(new UnPriceLedgerError({ message: "LEDGER_NOT_FOUND" }))
      }

      const cached = ledger.balanceMinor

      const allEntries = await repo.findAllEntries({
        projectId: input.projectId,
        ledgerId: input.ledgerId,
      })

      const computed = allEntries.reduce((sum, e) => sum + e.signedAmountMinor, BigInt(0))

      if (computed !== cached) {
        await repo.updateLedgerBalance({
          projectId: input.projectId,
          ledgerId: input.ledgerId,
          balanceMinor: computed,
          updatedAtM: Date.now(),
        })
      }

      return Ok({ cached, computed })
    } catch (error) {
      this.logger.error("ledger.reconcile_balance_failed", {
        error: toErrorContext(error),
        projectId: input.projectId,
        ledgerId: input.ledgerId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_RECONCILE_FAILED" }))
    }
  }

  private async postEntry(
    input: PostLedgerEntryInput & { entryType: LedgerEntryType }
  ): Promise<Result<LedgerEntry, UnPriceLedgerError>> {
    const now = input.now ?? Date.now()
    const baseRepo = input.repo ?? this.repo

    if (!input.sourceType || !input.sourceId) {
      return Err(new UnPriceLedgerError({ message: "LEDGER_SOURCE_IDENTITY_REQUIRED" }))
    }

    if (input.amountMinor <= BigInt(0)) {
      return Err(new UnPriceLedgerError({ message: "LEDGER_INVALID_AMOUNT" }))
    }

    const idempotencyKey = await hashStringSHA256(`${input.sourceType}:${input.sourceId}`)

    const post = async (txRepo: LedgerRepository) => {
      await txRepo.ensureLedger({
        id: newId("ledger"),
        projectId: input.projectId,
        customerId: input.customerId,
        currency: input.currency,
      })

      await txRepo.lockLedger({
        projectId: input.projectId,
        customerId: input.customerId,
        currency: input.currency,
      })

      const ledger = await txRepo.findLedger({
        projectId: input.projectId,
        customerId: input.customerId,
        currency: input.currency,
      })

      if (!ledger) {
        throw new UnPriceLedgerError({ message: "LEDGER_NOT_FOUND" })
      }

      const existingEntry = await txRepo.findEntryBySource({
        projectId: input.projectId,
        ledgerId: ledger.id,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      })

      if (existingEntry) {
        return existingEntry
      }

      const state = {
        balanceMinor: ledger.balanceMinor,
        entryCount: 0,
      }

      const decision =
        input.entryType === "debit"
          ? decideDebit({ amountMinor: input.amountMinor }, state)
          : decideCredit({ amountMinor: input.amountMinor }, state)

      if (decision.err) {
        throw decision.err
      }

      const { amountMinor, signedAmountMinor, balanceAfterMinor } = decision.val

      const insertedEntry = await txRepo.insertEntry({
        id: newId("ledger_entry"),
        projectId: input.projectId,
        ledgerId: ledger.id,
        customerId: input.customerId,
        currency: input.currency,
        entryType: input.entryType,
        amountMinor,
        signedAmountMinor,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey,
        description: input.description ?? null,
        statementKey: input.statementKey ?? null,
        balanceAfterMinor,
        journalId: input.journalId ?? null,
        metadata: input.metadata ?? null,
        createdAtM: now,
        updatedAtM: now,
      })

      if (!insertedEntry) {
        const idempotentEntry = await txRepo.findEntryBySource({
          projectId: input.projectId,
          ledgerId: ledger.id,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        })

        if (!idempotentEntry) {
          throw new UnPriceLedgerError({ message: "LEDGER_ENTRY_UPSERT_FAILED" })
        }

        return idempotentEntry
      }

      await txRepo.updateLedgerBalance({
        projectId: input.projectId,
        ledgerId: ledger.id,
        balanceMinor: balanceAfterMinor,
        lastEntryAt: now,
        updatedAtM: now,
      })

      return insertedEntry
    }

    try {
      const entry = input.repo ? await post(baseRepo) : await baseRepo.withTransaction(post)
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
}
