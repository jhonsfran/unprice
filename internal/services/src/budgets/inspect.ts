/**
 * What an operator sees of one budget beyond `get`: the reservations that expire next, the rows
 * closed in the last hour, a point lookup, and a probe of the authorize rule. Every read is bounded,
 * so inspecting a budget with a million rows costs about what inspecting an empty one does.
 */

import type { Amount } from "@unprice/money"
import { LEASE_REFUSAL_RETENTION_MS, OPERATION_RETENTION_MS, RECORD_DEDUPE_MS } from "./config"
import { blockingLimit } from "./decide"
import { exposureOf } from "./ledger"
import type {
  Blocked,
  BudgetRejection,
  BudgetSnapshot,
  Operation,
  ReservationOperation,
  WindowPeriod,
} from "./model"
import type { BudgetReader } from "./transition"

/** Rows one `expiringNext` page examines, of any status. */
export const INSPECT_SCAN_LIMIT = 1_000
/** The most rows `closedRecently` returns, and the most each of its range scans reads. */
export const INSPECT_CLOSED_LIMIT = 50
export const INSPECT_CLOSED_WINDOW_MS = 60 * 60 * 1000

/** A stored row's place in `due_at` order; `id` is the stored id, which ties break on. */
export type InspectCursor = Readonly<{ dueAt: number; id: string }>

export type InspectFind =
  | Readonly<{ by: "hold"; holdId: string }>
  | Readonly<{ by: "idempotencyKey"; idempotencyKey: string }>
  | Readonly<{ by: "lease"; leaseKey: string }>

export type BudgetInspectQuery = Readonly<{
  /** Resume the expiring-next walk after this row ("Scan further"). */
  after?: InspectCursor
  find?: InspectFind
  /** An amount checked against the live balance with the same rule authorize uses. */
  probe?: Amount
}>

export type BudgetInspection = Readonly<{
  budget: BudgetSnapshot
  history: readonly WindowPeriod[]
  expiringNext: Readonly<{
    /** Open holds and leases, ascending `due_at`. */
    rows: readonly ReservationOperation[]
    /** Rows the walk read, at most INSPECT_SCAN_LIMIT. */
    examined: number
    /** Null when the walk reached the end. */
    next: InspectCursor | null
  }>
  /** Sum of `exposureOf` over `expiringNext.rows`. Compare with `budget.balance.held`. */
  listed: Amount
  /** Closed in the last hour, newest first, at most INSPECT_CLOSED_LIMIT. */
  closedRecently: readonly Operation[]
  /** Present only when the query had `find`; null = not found (denied, never sent, or purged). */
  found?: Operation | null
  /** Present only when the query had `probe`; blocked null = it would pass now. */
  probe?: Readonly<{ amount: Amount; blocked: Blocked | null }>
}>

export type BudgetInspectReply =
  | Readonly<{ ok: true; inspection: BudgetInspection }>
  | Readonly<{ ok: false; rejection: BudgetRejection }>

/** The reads only inspect makes. Both walk the `due_at` index and read at most `limit` rows. */
export type InspectReader = {
  /**
   * Rows after `after` (exclusive, from the start when null) in `(due_at, length(id), id)` order, at
   * most `limit` of any status. Returns the open holds and leases among them, how many rows it
   * read, and the cursor of the last one.
   */
  walkReservations(
    after: InspectCursor | null,
    limit: number
  ): { rows: ReservationOperation[]; examined: number; last: InspectCursor | null }
  /** Up to `limit` rows with `from < due_at <= to`, latest `due_at` first. */
  readDueBetween(from: number, to: number, limit: number): Operation[]
}

/** How long each kind of closed row stays after it closed, as `dueAt` keeps it. */
const RETENTIONS = [OPERATION_RETENTION_MS, RECORD_DEDUPE_MS, LEASE_REFUSAL_RETENTION_MS]

/**
 * Reads the inspection of a budget `get` just answered at `now`, in the same transaction.
 * `budget` and `history` are what that `get` returned.
 */
export function inspect(
  reader: Pick<BudgetReader, "readOperation" | "readOperationByKey" | "readLease"> & InspectReader,
  read: Readonly<{ budget: BudgetSnapshot; history: readonly WindowPeriod[] }>,
  query: BudgetInspectQuery,
  now: number
): BudgetInspection {
  const walk = reader.walkReservations(query.after ?? null, INSPECT_SCAN_LIMIT)
  const inspection: BudgetInspection = {
    ...read,
    expiringNext: {
      rows: walk.rows,
      examined: walk.examined,
      next: walk.examined < INSPECT_SCAN_LIMIT ? null : walk.last,
    },
    listed: walk.rows.reduce((sum, row) => sum + exposureOf(row), BigInt(0)),
    closedRecently: closedRecently(reader, now),
  }
  const { find, probe } = query
  return {
    ...inspection,
    ...(find && { found: findOperation(reader, find) }),
    ...(probe !== undefined && {
      probe: { amount: probe, blocked: blockingLimit(read.budget.balance, probe) },
    }),
  }
}

/**
 * A closed row sits in `due_at` at its close plus its retention, so the rows closed in the last
 * hour lie in one hour-long range per retention. Each range scan reads at most
 * INSPECT_CLOSED_LIMIT rows, newest first; open reservations and older closes that share a range
 * are dropped.
 */
function closedRecently(reader: InspectReader, now: number): Operation[] {
  const since = now - INSPECT_CLOSED_WINDOW_MS
  return RETENTIONS.flatMap((retention) =>
    reader.readDueBetween(since + retention, now + retention, INSPECT_CLOSED_LIMIT)
  )
    .flatMap((row) => {
      const closedAt = closedAtOf(row)
      return closedAt !== null && closedAt > since && closedAt <= now ? [{ row, closedAt }] : []
    })
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, INSPECT_CLOSED_LIMIT)
    .map(({ row }) => row)
}

/** When a row closed: a charge or record when it was made; null for an open hold or lease. */
export function closedAtOf(row: Operation): number | null {
  if (row.kind !== "hold" && row.kind !== "lease") return row.createdAt
  return row.state.status === "open" ? null : row.state.closedAt
}

function findOperation(
  reader: Pick<BudgetReader, "readOperation" | "readOperationByKey" | "readLease">,
  find: InspectFind
): Operation | null {
  switch (find.by) {
    case "hold": {
      const row = reader.readOperation(find.holdId)
      return row?.kind === "hold" ? row : null
    }
    case "idempotencyKey":
      return reader.readOperationByKey(find.idempotencyKey)
    case "lease":
      return reader.readLease(find.leaseKey)
  }
}
