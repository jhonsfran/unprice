import { type Database, sql } from "@unprice/db"
import { type Currency, currencySchema } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { fromLedgerAmount } from "@unprice/money"
import type { Dinero } from "dinero.js"
import { CUSTOMER_ACCOUNT_KINDS, type CustomerAccountKind, customerAccountKeys } from "./accounts"
import { UnPriceLedgerError } from "./errors"

/** One transfer in the customer ledger statement, with both posting legs resolved. */
export interface CustomerLedgerMovement {
  id: string
  fromAccount: string
  toAccount: string
  amount: Dinero<number>
  currency: Currency
  fromBalanceAfter: Dinero<number>
  toBalanceAfter: Dinero<number>
  metadata: Record<string, unknown> | null
  sourceType: string | null
  sourceId: string | null
  statementKey: string | null
  reservationOwnerType: string | null
  reservationOwnerId: string | null
  createdAt: Date
  eventAt: Date
}

export interface ListCustomerTransfersInput {
  projectId: string
  customerId: string
  kinds?: readonly CustomerAccountKind[]
  flows?: readonly string[]
  search?: string | null
  from?: Date | null
  to?: Date | null
  page?: number
  pageSize?: number
}

type PgledgerMovementRow = {
  id: string
  amount: string
  created_at: Date | string
  event_at: Date | string
  metadata: Record<string, unknown> | null
  from_account: string
  to_account: string
  currency: string
  from_balance_after: string
  to_balance_after: string
  source_type: string | null
  source_id: string | null
  statement_key: string | null
  reservation_owner_type: string | null
  reservation_owner_id: string | null
  [key: string]: unknown
}

/** Read-side projection for the customer ledger statement. */
export class CustomerLedgerService {
  private readonly db: Database
  private readonly logger: Logger

  constructor(opts: { db: Database; logger: Logger }) {
    this.db = opts.db
    this.logger = opts.logger
  }

  /**
   * Returns transfers that touch the selected customer accounts. The query
   * returns one movement per transfer, including both post-transfer balances.
   * The caller must first prove that the customer belongs to the project.
   */
  public async listCustomerTransfers(
    opts: ListCustomerTransfersInput
  ): Promise<Result<{ movements: CustomerLedgerMovement[]; total: number }, UnPriceLedgerError>> {
    const accountKeys = customerAccountKeys(opts.customerId)
    const kinds = opts.kinds?.length ? opts.kinds : CUSTOMER_ACCOUNT_KINDS
    const names = kinds.map((kind) => accountKeys[kind])

    if (names.length === 0) {
      return Ok({ movements: [], total: 0 })
    }

    const page = Math.max(1, opts.page ?? 1)
    const pageSize = Math.min(Math.max(1, opts.pageSize ?? 10), 100)
    const search = opts.search?.trim()
    const nameList = sql.join(
      names.map((name) => sql`${name}`),
      sql`, `
    )
    const searchFilter = search
      ? sql` AND (t.id ILIKE ${`%${search}%`} OR src.source_id ILIKE ${`%${search}%`}
             OR src.source_type ILIKE ${`%${search}%`}
             OR t.metadata->>'reservation_id' ILIKE ${`%${search}%`}
             OR r.owner_id ILIKE ${`%${search}%`})`
      : sql``
    const flowFilter = opts.flows?.length
      ? sql` AND t.metadata->>'flow' IN (${sql.join(
          opts.flows.map((flow) => sql`${flow}`),
          sql`, `
        )})`
      : sql``
    const fromFilter = opts.from
      ? sql` AND COALESCE(t.event_at, t.created_at) >= ${opts.from}`
      : sql``
    const toFilter = opts.to ? sql` AND COALESCE(t.event_at, t.created_at) <= ${opts.to}` : sql``

    const scope = sql`
      FROM pgledger_transfers_view t
      INNER JOIN pgledger_accounts_view fa ON fa.id = t.from_account_id
      INNER JOIN pgledger_accounts_view ta ON ta.id = t.to_account_id
      INNER JOIN pgledger_entries_view fe ON fe.transfer_id = t.id AND fe.account_id = t.from_account_id
      INNER JOIN pgledger_entries_view te ON te.transfer_id = t.id AND te.account_id = t.to_account_id
      LEFT JOIN LATERAL (
        SELECT i.source_type, i.source_id, i.statement_key
        FROM unprice_ledger_idempotency i
        WHERE i.transfer_id = t.id
          AND i.project_id = ${opts.projectId}
        LIMIT 1
      ) src ON TRUE
      LEFT JOIN unprice_entitlement_reservations r
        ON r.id = t.metadata->>'reservation_id'
       AND r.project_id = ${opts.projectId}
      WHERE (fa.name IN (${nameList}) OR ta.name IN (${nameList}))
        ${flowFilter}${searchFilter}${fromFilter}${toFilter}
    `

    try {
      const [rows, totals] = await Promise.all([
        this.db.execute<PgledgerMovementRow>(
          sql`
            SELECT t.id, t.amount, t.created_at, t.event_at, t.metadata,
                   fa.name AS from_account, ta.name AS to_account, fa.currency,
                   fe.account_current_balance AS from_balance_after,
                   te.account_current_balance AS to_balance_after,
                   src.source_type, src.source_id, src.statement_key,
                   r.owner_type AS reservation_owner_type,
                   r.owner_id AS reservation_owner_id
            ${scope}
            ORDER BY COALESCE(t.event_at, t.created_at) DESC, t.id DESC
            LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
          `
        ),
        this.db.execute<{ total: string }>(sql`SELECT COUNT(*)::text AS total ${scope}`),
      ])

      return Ok({
        movements: rows.rows.map(toMovement),
        total: Number(totals.rows[0]?.total ?? "0"),
      })
    } catch (error) {
      this.logger.error(error, {
        context: "ledger.list_customer_transfers_failed",
        projectId: opts.projectId,
        customerId: opts.customerId,
      })
      return Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    }
  }
}

function toMovement(row: PgledgerMovementRow): CustomerLedgerMovement {
  const currency = currencySchema.parse(row.currency)

  return {
    id: row.id,
    fromAccount: row.from_account,
    toAccount: row.to_account,
    amount: fromLedgerAmount(row.amount, currency),
    currency,
    fromBalanceAfter: fromLedgerAmount(row.from_balance_after, currency),
    toBalanceAfter: fromLedgerAmount(row.to_balance_after, currency),
    metadata: row.metadata,
    sourceType: row.source_type,
    sourceId: row.source_id,
    statementKey: row.statement_key,
    reservationOwnerType: row.reservation_owner_type,
    reservationOwnerId: row.reservation_owner_id,
    createdAt: asDate(row.created_at),
    eventAt: asDate(row.event_at),
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
