/** Counter arithmetic (ADR-0006 B1, B2): rolling windows forward and adding consumption. No policy. */

import type { Amount } from "@unprice/money"
import {
  type BudgetLimit,
  LEASE_REFUSAL_RETENTION_MS,
  OPERATION_RETENTION_MS,
  RECORD_DEDUPE_MS,
} from "./config"
import type {
  Operation,
  ReservationOperation,
  WindowCounters,
  WindowPeriod,
  WindowUsage,
} from "./model"
import { type WindowId, windowBounds, windowIdOf, windowSpecOf } from "./windows"

const ZERO = BigInt(0)

export function countersOf(usage: WindowCounters): Array<[WindowId, WindowUsage]> {
  return Object.entries(usage) as Array<[WindowId, WindowUsage]>
}

/** The calendar counters are always present, so a map built from a ledger's counters is complete. */
function countersFrom(entries: Iterable<[WindowId, WindowUsage]>): WindowCounters {
  return Object.fromEntries(entries) as WindowCounters
}

/**
 * Moves every counter forward (only) to the period containing `at`, under the limits in force.
 * Returns the ended periods that had usage on a limited window: the window history. An anchored
 * counter no limit references is dropped when its period ends and listed in `retired`, so the store
 * drops its history too. Unchanged counters keep identity.
 */
export function rollUsage(
  usage: WindowCounters,
  at: number,
  limits: readonly BudgetLimit[]
): { usage: WindowCounters; periods: WindowPeriod[]; retired: WindowId[] } {
  const limited = new Set(limits.map(windowIdOf))
  const periods: WindowPeriod[] = []
  const retired: WindowId[] = []
  const rolled = countersOf(usage).flatMap(([id, counter]): Array<[WindowId, WindowUsage]> => {
    const spec = windowSpecOf(id)
    const start = windowBounds(spec, at).start
    if (start <= counter.start) return [[id, counter]]
    if (counter.consumed > ZERO && limited.has(id)) {
      const { end } = windowBounds(spec, counter.start)
      if (end === null) throw new Error(`window ${id} rolled but never ends`)
      periods.push({ windowId: id, start: counter.start, end, consumed: counter.consumed })
    }
    if (spec.anchor !== undefined && !limited.has(id)) {
      retired.push(id)
      return []
    }
    return [[id, { start, consumed: ZERO }]]
  })
  return { usage: countersFrom(rolled), periods, retired }
}

/** After a config change: a counter for every anchored window id that has none, counting from `at`. */
export function trackLimits(
  usage: WindowCounters,
  limits: readonly BudgetLimit[],
  at: number
): WindowCounters {
  const added = limits
    .filter((limit) => limit.anchor !== undefined && usage[windowIdOf(limit)] === undefined)
    .map((limit): [WindowId, WindowUsage] => [
      windowIdOf(limit),
      { start: windowBounds(limit, at).start, consumed: ZERO },
    ])
  return added.length === 0 ? usage : countersFrom([...countersOf(usage), ...added])
}

/** Adds `amount` to every counter. */
export function consume(usage: WindowCounters, amount: Amount): WindowCounters {
  if (amount === ZERO) return usage
  return countersFrom(
    countersOf(usage).map(([id, counter]): [WindowId, WindowUsage] => [
      id,
      { start: counter.start, consumed: counter.consumed + amount },
    ])
  )
}

/** What an open reservation counts against every limit; zero once it closed. */
export function exposureOf(row: ReservationOperation): Amount {
  if (row.state.status !== "open") return ZERO
  return row.kind === "hold" ? row.amount : row.granted - row.captured
}

/**
 * When a row's retention ends and the alarm may purge it; null for an open hold or lease, which
 * stays until it is closed. A record is kept for RECORD_DEDUPE_MS so a retry never counts twice, a
 * refused lease for LEASE_REFUSAL_RETENTION_MS, and every other row is purged
 * OPERATION_RETENTION_MS after it closed.
 */
export function dueAt(operation: Operation): number | null {
  if (operation.kind === "hold" || operation.kind === "lease") {
    const { state } = operation
    if (state.status === "open") return null
    const retention =
      state.status === "refused" ? LEASE_REFUSAL_RETENTION_MS : OPERATION_RETENTION_MS
    return state.closedAt + retention
  }
  const retention = operation.kind === "record" ? RECORD_DEDUPE_MS : OPERATION_RETENTION_MS
  return operation.createdAt + retention
}

/**
 * When the alarm must next visit a row: an open hold or lease at its `expiresAt`, to close it; any
 * other row when its retention ends, to purge it. A store mirrors this in an indexed `due_at`
 * column.
 */
export function alarmAt(operation: Operation): number {
  const reservation = operation.kind === "hold" || operation.kind === "lease"
  if (reservation && operation.state.status === "open") return operation.expiresAt
  const due = dueAt(operation)
  if (due === null) throw new Error(`closed row ${operation.id} has no retention end`)
  return due
}
