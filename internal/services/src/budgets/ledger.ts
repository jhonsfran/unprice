/** Counter arithmetic (ADR-0006 B1, B2): rolling windows forward and adding consumption. No policy. */

import type { Amount } from "@unprice/money"
import { type BudgetLimit, OPERATION_RETENTION_MS, RECORD_DEDUPE_MS } from "./config"
import type { Operation, WindowCounters, WindowPeriod, WindowUsage } from "./model"
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
 * counter no limit references is dropped when its period ends. Unchanged counters keep identity.
 */
export function rollUsage(
  usage: WindowCounters,
  at: number,
  limits: readonly BudgetLimit[]
): { usage: WindowCounters; periods: WindowPeriod[] } {
  const limited = new Set(limits.map(windowIdOf))
  const periods: WindowPeriod[] = []
  const rolled = countersOf(usage).flatMap(([id, counter]): Array<[WindowId, WindowUsage]> => {
    const spec = windowSpecOf(id)
    const start = windowBounds(spec, at).start
    if (start <= counter.start) return [[id, counter]]
    if (counter.consumed > ZERO && limited.has(id)) {
      const { end } = windowBounds(spec, counter.start)
      if (end === null) throw new Error(`window ${id} rolled but never ends`)
      periods.push({ windowId: id, start: counter.start, end, consumed: counter.consumed })
    }
    if (spec.anchor !== undefined && !limited.has(id)) return []
    return [[id, { start, consumed: ZERO }]]
  })
  return { usage: countersFrom(rolled), periods }
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

/**
 * When a row next needs attention: an open hold lapses at `lapsesAt`; a record is kept for
 * RECORD_DEDUPE_MS so a retry never counts twice; every other row is purged
 * OPERATION_RETENTION_MS after it closed. A store mirrors this in an indexed `due_at` column.
 */
export function dueAt(operation: Operation): number {
  if (operation.kind !== "hold") {
    const retention = operation.kind === "record" ? RECORD_DEDUPE_MS : OPERATION_RETENTION_MS
    return operation.createdAt + retention
  }
  switch (operation.state.status) {
    case "open":
      return operation.lapsesAt
    case "lapsed":
      return operation.state.lapsedAt + OPERATION_RETENTION_MS
    case "settled":
    case "released":
      return operation.state.closedAt + OPERATION_RETENTION_MS
  }
}
