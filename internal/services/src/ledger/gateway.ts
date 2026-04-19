import { type Database, sql } from "@unprice/db"
import { ledgerIdempotency } from "@unprice/db/schema"
import type { Currency } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { type Dinero, toSnapshot } from "dinero.js"

import type { Logger } from "@unprice/logs"
import { fromLedgerAmount, toLedgerAmount } from "@unprice/money"
import type { DbExecutor } from "../deps"
import { toErrorContext } from "../utils/log-context"
import { HOUSE_ACCOUNT_KINDS, customerAccountKey, houseAccountKey } from "./accounts"
import { assertCurrencyMatch, assertPositiveAmount } from "./core"
import { UnPriceLedgerError } from "./errors"

/**
 * Source identity for a ledger transfer. The pair `(sourceType, sourceId)` is
 * the idempotency key — replays converge on the same `transferId`.
 */
export interface LedgerSource {
  type: string
  id: string
}

export interface LedgerTransferRequest {
  projectId: string
  fromAccount: string
  toAccount: string
  amount: Dinero<number>
  source: LedgerSource
  /**
   * Stored on the idempotency row (indexed) so `getEntriesByStatementKey`
   * can JOIN instead of scanning pgledger metadata JSONB.
   */
  statementKey?: string | null
  metadata?: Record<string, unknown>
  eventAt?: Date
}

export interface PostChargeInput {
  projectId: string
  customerId: string
  currency: Currency
  amount: Dinero<number>
  source: LedgerSource
  metadata?: Record<string, unknown>
  statementKey?: string
  eventAt?: Date
}

export interface PostRefundInput {
  projectId: string
  customerId: string
  currency: Currency
  amount: Dinero<number>
  originalTransferId: string
  source: LedgerSource
  metadata?: Record<string, unknown>
  eventAt?: Date
}

export interface LedgerTransfer {
  id: string
  fromAccountId: string
  toAccountId: string
  amount: Dinero<number>
  currency: Currency
  metadata: Record<string, unknown> | null
  createdAt: Date
  eventAt: Date
}

export interface LedgerEntry {
  id: string
  accountId: string
  transferId: string
  amount: Dinero<number>
  currency: Currency
  previousBalance: Dinero<number>
  currentBalance: Dinero<number>
  accountVersion: number
  createdAt: Date
  eventAt: Date
  metadata: Record<string, unknown> | null
}

export interface LedgerAccount {
  id: string
  name: string
  currency: Currency
  balance: Dinero<number>
  version: number
  allowNegativeBalance: boolean
  allowPositiveBalance: boolean
  metadata: Record<string, unknown> | null
}

type PgledgerTransferRow = {
  id: string
  from_account_id: string
  to_account_id: string
  amount: string
  created_at: Date
  event_at: Date
  metadata: Record<string, unknown> | null
  [key: string]: unknown
}

type PgledgerEntryRow = {
  id: string
  account_id: string
  transfer_id: string
  amount: string
  account_previous_balance: string
  account_current_balance: string
  account_version: string
  created_at: Date
  event_at: Date
  metadata: Record<string, unknown> | null
  [key: string]: unknown
}

type PgledgerAccountRow = {
  id: string
  name: string
  currency: string
  balance: string
  version: string
  allow_negative_balance: boolean
  allow_positive_balance: boolean
  metadata: Record<string, unknown> | null
  [key: string]: unknown
}

const SUPPORTED_CURRENCIES = new Set<Currency>(["USD", "EUR"])

function asCurrency(value: string): Currency {
  if (!SUPPORTED_CURRENCIES.has(value as Currency)) {
    throw new UnPriceLedgerError({
      message: "LEDGER_CURRENCY_MISMATCH",
      context: { currency: value },
    })
  }
  return value as Currency
}

/**
 * Typed wrapper over the pgledger SQL surface. Owns:
 *
 * - `Dinero<number>` (de)serialization at scale 6.
 * - Per-source idempotency via the `ledger_idempotency` table.
 * - Currency validation between the Dinero amount and the target accounts.
 *
 * Wallet-agnostic — the gateway knows about account kinds and currencies, not
 * about grants, burn rates, or wallet rows. Wallet semantics compose on top
 * of this surface without changing the gateway's public methods.
 */
export class LedgerGateway {
  private readonly db: Database
  private readonly logger: Logger
  private readonly seededProjects = new Set<string>()

  constructor(opts: { db: Database; logger: Logger }) {
    this.db = opts.db
    this.logger = opts.logger
  }

  /**
   * Idempotently ensures the four canonical house accounts exist for a
   * `(project, currency)` tuple. Caches in-process per worker so repeat calls
   * for the same tuple skip the round-trip.
   */
  public async seedHouseAccounts(
    projectId: string,
    currency: Currency
  ): Promise<Result<void, UnPriceLedgerError>> {
    const cacheKey = `${projectId}:${currency}`
    if (this.seededProjects.has(cacheKey)) return Ok(undefined)

    try {
      await this.db.transaction(async (tx) => {
        for (const kind of HOUSE_ACCOUNT_KINDS) {
          const name = houseAccountKey(kind, projectId, currency)
          await this.ensureAccount(
            { name, currency, allowNegativeBalance: true, allowPositiveBalance: true },
            tx
          )
        }
      })
      this.seededProjects.add(cacheKey)
      return Ok(undefined)
    } catch (error) {
      this.logger.error("ledger.seed_house_accounts_failed", {
        error: toErrorContext(error),
        projectId,
        currency,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_SEED_HOUSE_ACCOUNTS_FAILED" }))
    }
  }

  /**
   * Ensures a customer account exists for the customer/currency. Customer
   * accounts allow negative balance — a customer with outstanding receivables
   * sits at a negative balance until the matching payment posts.
   */
  public async ensureCustomerAccount(
    customerId: string,
    currency: Currency
  ): Promise<Result<LedgerAccount, UnPriceLedgerError>> {
    return this.createAccount({
      name: customerAccountKey(customerId, currency),
      currency,
      allowNegativeBalance: true,
      allowPositiveBalance: true,
    })
  }

  /**
   * Customer-facing charge: customer receivable → `house:revenue`. Validates
   * amount + currency, ensures the backing accounts exist, and delegates to
   * `createTransfer`, which claims the idempotency row and posts the pair of
   * ledger entries inside a single transaction.
   *
   * Payment-side entries (cash clearing the receivable) are owned by the
   * payout-reconciliation path, not this method — the ledger reflects
   * accruals here; actual cash lands when the webhook adapter posts against
   * the same customer account.
   */
  public async postCharge(
    input: PostChargeInput
  ): Promise<Result<LedgerTransfer, UnPriceLedgerError>> {
    const validAmount = assertPositiveAmount(input.amount)
    if (validAmount.err) return Err(validAmount.err)
    const validCurrency = assertCurrencyMatch(input.amount, input.currency)
    if (validCurrency.err) return Err(validCurrency.err)

    const ensured = await this.ensureCustomerAndHouseAccounts(
      input.projectId,
      input.customerId,
      input.currency
    )
    if (ensured.err) return Err(ensured.err)

    return this.createTransfer({
      projectId: input.projectId,
      fromAccount: customerAccountKey(input.customerId, input.currency),
      toAccount: houseAccountKey("revenue", input.projectId, input.currency),
      amount: input.amount,
      source: input.source,
      statementKey: input.statementKey,
      eventAt: input.eventAt,
      metadata: {
        ...(input.metadata ?? {}),
        customer_id: input.customerId,
      },
    })
  }

  /**
   * Customer-facing refund: `house:refunds` → customer receivable. Requires
   * the original charge's transfer id so the refund chain is queryable from
   * metadata. Partial refunds are allowed; the ledger does not track total
   * refunded against a charge.
   */
  public async postRefund(
    input: PostRefundInput
  ): Promise<Result<LedgerTransfer, UnPriceLedgerError>> {
    const validAmount = assertPositiveAmount(input.amount)
    if (validAmount.err) return Err(validAmount.err)
    const validCurrency = assertCurrencyMatch(input.amount, input.currency)
    if (validCurrency.err) return Err(validCurrency.err)

    const ensured = await this.ensureCustomerAndHouseAccounts(
      input.projectId,
      input.customerId,
      input.currency
    )
    if (ensured.err) return Err(ensured.err)

    return this.createTransfer({
      projectId: input.projectId,
      fromAccount: houseAccountKey("refunds", input.projectId, input.currency),
      toAccount: customerAccountKey(input.customerId, input.currency),
      amount: input.amount,
      source: input.source,
      eventAt: input.eventAt,
      metadata: {
        ...(input.metadata ?? {}),
        customer_id: input.customerId,
        original_transfer_id: input.originalTransferId,
      },
    })
  }

  public async getCustomerBalance(input: {
    customerId: string
    currency: Currency
  }): Promise<Result<Dinero<number>, UnPriceLedgerError>> {
    return this.getAccountBalance(customerAccountKey(input.customerId, input.currency))
  }

  public async createAccount(opts: {
    name: string
    currency: Currency
    allowNegativeBalance: boolean
    allowPositiveBalance: boolean
    metadata?: Record<string, unknown>
  }): Promise<Result<LedgerAccount, UnPriceLedgerError>> {
    try {
      const account = await this.ensureAccount(opts, this.db)
      return Ok(account)
    } catch (error) {
      this.logger.error("ledger.create_account_failed", {
        error: toErrorContext(error),
        name: opts.name,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_TRANSFER_FAILED" }))
    }
  }

  public async getAccount(name: string): Promise<Result<LedgerAccount, UnPriceLedgerError>> {
    try {
      const result = await this.db.execute<PgledgerAccountRow>(
        sql`SELECT id, name, currency, balance, version, allow_negative_balance, allow_positive_balance, metadata FROM pgledger_accounts_view WHERE name = ${name} LIMIT 1`
      )
      const row = result.rows[0]
      if (!row) return Err(new UnPriceLedgerError({ message: "LEDGER_ACCOUNT_NOT_FOUND" }))
      return Ok(this.toAccount(row))
    } catch (error) {
      this.logger.error("ledger.get_account_failed", { error: toErrorContext(error), name })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_BALANCE_FAILED" }))
    }
  }

  public async getAccountBalance(
    name: string
  ): Promise<Result<Dinero<number>, UnPriceLedgerError>> {
    const accountResult = await this.getAccount(name)
    if (accountResult.err) return Err(accountResult.err)
    return Ok(accountResult.val.balance)
  }

  public async createTransfer(
    request: LedgerTransferRequest
  ): Promise<Result<LedgerTransfer, UnPriceLedgerError>> {
    try {
      const transfer = await this.db.transaction(async (tx) => {
        const claim = await this.claimIdempotency(
          {
            projectId: request.projectId,
            sourceType: request.source.type,
            sourceId: request.source.id,
            statementKey: request.statementKey ?? null,
          },
          tx
        )

        if (claim.existingTransferId) {
          const existing = await this.fetchTransfer(claim.existingTransferId, tx)
          if (existing) return existing
          throw new UnPriceLedgerError({
            message: "LEDGER_TRANSFER_FAILED",
            context: { reason: "idempotency_row_without_transfer", ...claim },
          })
        }

        const created = await this.runTransfer(request, tx)
        await tx
          .update(ledgerIdempotency)
          .set({ transferId: created.id })
          .where(
            sql`project_id = ${request.projectId} AND source_type = ${request.source.type} AND source_id = ${request.source.id}`
          )

        return created
      })

      return Ok(transfer)
    } catch (error) {
      if (error instanceof UnPriceLedgerError) return Err(error)
      this.logger.error("ledger.create_transfer_failed", {
        error: toErrorContext(error),
        projectId: request.projectId,
        sourceType: request.source.type,
        sourceId: request.source.id,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_TRANSFER_FAILED" }))
    }
  }

  /**
   * Atomic batched transfers — pgledger commits all lines or rolls back the
   * batch. Idempotency is per-line: each line's `(source.type, source.id)`
   * row is claimed before the batch runs; if any claim is a replay, the prior
   * transfer id is reused without inserting a new pgledger row for that line.
   */
  public async createTransfers(
    requests: LedgerTransferRequest[]
  ): Promise<Result<LedgerTransfer[], UnPriceLedgerError>> {
    if (requests.length === 0) return Ok([])

    try {
      const transfers = await this.db.transaction(async (tx) => {
        const results: LedgerTransfer[] = new Array(requests.length)
        const toCreate: { index: number; request: LedgerTransferRequest }[] = []

        for (let i = 0; i < requests.length; i++) {
          const request = requests[i]!
          const claim = await this.claimIdempotency(
            {
              projectId: request.projectId,
              sourceType: request.source.type,
              sourceId: request.source.id,
              statementKey: request.statementKey ?? null,
            },
            tx
          )
          if (claim.existingTransferId) {
            const existing = await this.fetchTransfer(claim.existingTransferId, tx)
            if (!existing) {
              throw new UnPriceLedgerError({
                message: "LEDGER_BATCH_FAILED",
                context: { reason: "idempotency_row_without_transfer", ...claim },
              })
            }
            results[i] = existing
          } else {
            toCreate.push({ index: i, request })
          }
        }

        for (const { index, request } of toCreate) {
          const created = await this.runTransfer(request, tx)
          await tx
            .update(ledgerIdempotency)
            .set({ transferId: created.id })
            .where(
              sql`project_id = ${request.projectId} AND source_type = ${request.source.type} AND source_id = ${request.source.id}`
            )
          results[index] = created
        }

        return results
      })

      return Ok(transfers)
    } catch (error) {
      if (error instanceof UnPriceLedgerError) return Err(error)
      this.logger.error("ledger.create_transfers_failed", {
        error: toErrorContext(error),
        count: requests.length,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_BATCH_FAILED" }))
    }
  }

  public async getEntries(opts: {
    accountName: string
    limit?: number
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const limit = opts.limit ?? 100
      const result = await this.db.execute<PgledgerEntryRow & { currency: string }>(
        sql`
          SELECT e.id, e.account_id, e.transfer_id, e.amount,
                 e.account_previous_balance, e.account_current_balance,
                 e.account_version, e.created_at, e.event_at, e.metadata,
                 a.currency
          FROM pgledger_entries_view e
          INNER JOIN pgledger_accounts_view a ON a.id = e.account_id
          WHERE a.name = ${opts.accountName}
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT ${limit}
        `
      )
      return Ok(result.rows.map((row) => this.toEntry(row, asCurrency(row.currency))))
    } catch (error) {
      this.logger.error("ledger.get_entries_failed", {
        error: toErrorContext(error),
        accountName: opts.accountName,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    }
  }

  /**
   * Entries authored by a given source — joined through the indexed
   * `unprice_ledger_idempotency` row rather than scanned from pgledger JSONB.
   */
  public async getEntriesBySource(opts: {
    projectId: string
    sourceType: string
    sourceId: string
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const result = await this.db.execute<PgledgerEntryRow & { currency: string }>(
        sql`
          SELECT e.id, e.account_id, e.transfer_id, e.amount,
                 e.account_previous_balance, e.account_current_balance,
                 e.account_version, e.created_at, e.event_at, e.metadata,
                 a.currency
          FROM unprice_ledger_idempotency i
          INNER JOIN pgledger_entries_view e  ON e.transfer_id = i.transfer_id
          INNER JOIN pgledger_accounts_view a ON a.id = e.account_id
          WHERE i.project_id  = ${opts.projectId}
            AND i.source_type = ${opts.sourceType}
            AND i.source_id   = ${opts.sourceId}
          ORDER BY e.created_at ASC, e.id ASC
        `
      )
      return Ok(result.rows.map((row) => this.toEntry(row, asCurrency(row.currency))))
    } catch (error) {
      this.logger.error("ledger.get_entries_by_source_failed", {
        error: toErrorContext(error),
        ...opts,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    }
  }

  public async getEntriesByStatementKey(opts: {
    projectId: string
    statementKey: string
  }): Promise<Result<LedgerEntry[], UnPriceLedgerError>> {
    try {
      const result = await this.db.execute<PgledgerEntryRow & { currency: string }>(
        sql`
          SELECT e.id, e.account_id, e.transfer_id, e.amount,
                 e.account_previous_balance, e.account_current_balance,
                 e.account_version, e.created_at, e.event_at, e.metadata,
                 a.currency
          FROM unprice_ledger_idempotency i
          INNER JOIN pgledger_entries_view e  ON e.transfer_id = i.transfer_id
          INNER JOIN pgledger_accounts_view a ON a.id = e.account_id
          WHERE i.project_id    = ${opts.projectId}
            AND i.statement_key = ${opts.statementKey}
          ORDER BY e.created_at ASC, e.id ASC
        `
      )
      return Ok(result.rows.map((row) => this.toEntry(row, asCurrency(row.currency))))
    } catch (error) {
      this.logger.error("ledger.get_entries_by_statement_key_failed", {
        error: toErrorContext(error),
        ...opts,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async ensureCustomerAndHouseAccounts(
    projectId: string,
    customerId: string,
    currency: Currency
  ): Promise<Result<void, UnPriceLedgerError>> {
    const seedResult = await this.seedHouseAccounts(projectId, currency)
    if (seedResult.err) return Err(seedResult.err)
    const ensure = await this.ensureCustomerAccount(customerId, currency)
    if (ensure.err) return Err(ensure.err)
    return Ok(undefined)
  }

  private async claimIdempotency(
    opts: {
      projectId: string
      sourceType: string
      sourceId: string
      statementKey: string | null
    },
    tx: DbExecutor
  ): Promise<{ existingTransferId: string | null }> {
    if (!opts.sourceType || !opts.sourceId) {
      throw new UnPriceLedgerError({ message: "LEDGER_SOURCE_IDENTITY_REQUIRED" })
    }

    const inserted = await tx.execute<{ transfer_id: string | null }>(
      sql`
        INSERT INTO unprice_ledger_idempotency (project_id, source_type, source_id, statement_key)
        VALUES (${opts.projectId}, ${opts.sourceType}, ${opts.sourceId}, ${opts.statementKey})
        ON CONFLICT (project_id, source_type, source_id) DO NOTHING
        RETURNING transfer_id
      `
    )

    if (inserted.rows.length > 0) {
      return { existingTransferId: null }
    }

    const existing = await tx.execute<{ transfer_id: string | null }>(
      sql`
        SELECT transfer_id FROM unprice_ledger_idempotency
        WHERE project_id = ${opts.projectId}
          AND source_type = ${opts.sourceType}
          AND source_id = ${opts.sourceId}
      `
    )

    const existingId = existing.rows[0]?.transfer_id ?? null
    return { existingTransferId: existingId }
  }

  private async runTransfer(
    request: LedgerTransferRequest,
    tx: DbExecutor
  ): Promise<LedgerTransfer> {
    const fromAccount = await this.fetchAccountByName(request.fromAccount, tx)
    if (!fromAccount) {
      throw new UnPriceLedgerError({
        message: "LEDGER_ACCOUNT_NOT_FOUND",
        context: { accountName: request.fromAccount },
      })
    }
    const toAccount = await this.fetchAccountByName(request.toAccount, tx)
    if (!toAccount) {
      throw new UnPriceLedgerError({
        message: "LEDGER_ACCOUNT_NOT_FOUND",
        context: { accountName: request.toAccount },
      })
    }

    const amountCurrency = toSnapshot(request.amount).currency.code

    if (
      amountCurrency.toUpperCase() !== fromAccount.currency.toUpperCase() ||
      amountCurrency.toUpperCase() !== toAccount.currency.toUpperCase()
    ) {
      throw new UnPriceLedgerError({
        message: "LEDGER_CURRENCY_MISMATCH",
        context: {
          amountCurrency,
          fromCurrency: fromAccount.currency,
          toCurrency: toAccount.currency,
        },
      })
    }

    const decimal = toLedgerAmount(request.amount)
    const metadata = request.metadata ?? {}
    const eventAt = request.eventAt ?? null

    const result = await tx.execute<PgledgerTransferRow>(
      sql`
        SELECT id, from_account_id, to_account_id, amount, created_at, event_at, metadata
        FROM pgledger_create_transfer(
          ${fromAccount.id}::text,
          ${toAccount.id}::text,
          ${decimal}::numeric,
          ${eventAt}::timestamptz,
          ${JSON.stringify(metadata)}::jsonb
        )
      `
    )

    const row = result.rows[0]
    if (!row) {
      throw new UnPriceLedgerError({
        message: "LEDGER_TRANSFER_FAILED",
        context: { reason: "pgledger_create_transfer_returned_no_rows" },
      })
    }

    return {
      id: row.id,
      fromAccountId: row.from_account_id,
      toAccountId: row.to_account_id,
      amount: fromLedgerAmount(row.amount, asCurrency(fromAccount.currency)),
      currency: asCurrency(fromAccount.currency),
      metadata: row.metadata,
      createdAt: row.created_at,
      eventAt: row.event_at,
    }
  }

  private async fetchTransfer(transferId: string, tx: DbExecutor): Promise<LedgerTransfer | null> {
    const result = await tx.execute<PgledgerTransferRow & { currency: string }>(
      sql`
        SELECT t.id, t.from_account_id, t.to_account_id, t.amount, t.created_at, t.event_at, t.metadata,
               a.currency
        FROM pgledger_transfers_view t
        INNER JOIN pgledger_accounts_view a ON a.id = t.from_account_id
        WHERE t.id = ${transferId}
      `
    )
    const row = result.rows[0]
    if (!row) return null
    const currency = asCurrency(row.currency)
    return {
      id: row.id,
      fromAccountId: row.from_account_id,
      toAccountId: row.to_account_id,
      amount: fromLedgerAmount(row.amount, currency),
      currency,
      metadata: row.metadata,
      createdAt: row.created_at,
      eventAt: row.event_at,
    }
  }

  private async fetchAccountByName(name: string, tx: DbExecutor): Promise<LedgerAccount | null> {
    const result = await tx.execute<PgledgerAccountRow>(
      sql`SELECT id, name, currency, balance, version, allow_negative_balance, allow_positive_balance, metadata FROM pgledger_accounts_view WHERE name = ${name} LIMIT 1`
    )
    const row = result.rows[0]
    if (!row) return null
    return this.toAccount(row)
  }

  private async ensureAccount(
    opts: {
      name: string
      currency: Currency
      allowNegativeBalance: boolean
      allowPositiveBalance: boolean
      metadata?: Record<string, unknown>
    },
    executor: DbExecutor
  ): Promise<LedgerAccount> {
    const existing = await this.fetchAccountByName(opts.name, executor)
    if (existing) return existing

    const metadataJson = opts.metadata ? JSON.stringify(opts.metadata) : null

    const result = await executor.execute<PgledgerAccountRow>(
      sql`
        SELECT id, name, currency, balance, version, allow_negative_balance, allow_positive_balance, metadata
        FROM pgledger_create_account(
          ${opts.name}::text,
          ${opts.currency}::text,
          ${opts.allowNegativeBalance}::boolean,
          ${opts.allowPositiveBalance}::boolean,
          ${metadataJson}::jsonb
        )
      `
    )
    const row = result.rows[0]
    if (!row) {
      // Concurrent race — another tx created it between SELECT and INSERT.
      const raced = await this.fetchAccountByName(opts.name, executor)
      if (raced) return raced
      throw new UnPriceLedgerError({
        message: "LEDGER_TRANSFER_FAILED",
        context: { reason: "create_account_returned_no_rows", name: opts.name },
      })
    }
    return this.toAccount(row)
  }

  private toAccount(row: PgledgerAccountRow): LedgerAccount {
    const currency = asCurrency(row.currency)
    return {
      id: row.id,
      name: row.name,
      currency,
      balance: fromLedgerAmount(row.balance, currency),
      version: Number(row.version),
      allowNegativeBalance: row.allow_negative_balance,
      allowPositiveBalance: row.allow_positive_balance,
      metadata: row.metadata,
    }
  }

  private toEntry(row: PgledgerEntryRow & { currency: string }, currency: Currency): LedgerEntry {
    return {
      id: row.id,
      accountId: row.account_id,
      transferId: row.transfer_id,
      amount: fromLedgerAmount(row.amount, currency),
      currency,
      previousBalance: fromLedgerAmount(row.account_previous_balance, currency),
      currentBalance: fromLedgerAmount(row.account_current_balance, currency),
      accountVersion: Number(row.account_version),
      createdAt: row.created_at,
      eventAt: row.event_at,
      metadata: row.metadata,
    }
  }
}
