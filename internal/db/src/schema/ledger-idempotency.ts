import { sql } from "drizzle-orm"
import { index, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

import { pgTableProject } from "../utils/_table"
import { cuid } from "../utils/fields"

/**
 * Gateway-owned idempotency table for ledger transfers.
 *
 * Every write through `LedgerGateway` first inserts here with `(project_id,
 * source_type, source_id)`. On INSERT success the gateway proceeds to call
 * `pgledger_create_transfer(s)` and links the returned transfer id back via
 * UPDATE. On conflict the gateway returns the previously stored transfer id
 * without touching pgledger.
 *
 * The unique constraint on `(project_id, source_type, source_id)` guarantees
 * one logical transfer per source — concurrent or replayed writes converge.
 *
 * `statement_key` is stored here (not in pgledger JSONB metadata) so
 * `getEntriesByStatementKey` can join through an indexed column instead of
 * scanning metadata. Same rationale applies to `(source_type, source_id)` —
 * the table doubles as the index for source-keyed entry lookups.
 */
export const ledgerIdempotency = pgTableProject(
  "ledger_idempotency",
  {
    projectId: cuid("project_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    transferId: text("transfer_id"),
    statementKey: text("statement_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.projectId, table.sourceType, table.sourceId],
      name: "ledger_idempotency_pkey",
    }),
    statementKeyIdx: index("ledger_idempotency_statement_key_idx").on(
      table.projectId,
      table.statementKey
    ),
    transferIdIdx: index("ledger_idempotency_transfer_id_idx").on(table.transferId),
  })
)
