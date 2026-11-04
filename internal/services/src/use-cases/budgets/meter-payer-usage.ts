import type { UsageEventProperties } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import {
  BUDGET_JOURNAL_SCHEMA_VERSION,
  type BudgetJournalRow,
  type LakehouseJsonValue,
} from "@unprice/lakehouse"
import { formatAmount } from "@unprice/money"
import type { OutcomeOf, UnPriceBudgetError } from "../../budgets"
import { payerBudgetKey } from "./compile-payer-budget"
import { type ExecuteBudgetCommandDeps, executeBudgetCommand } from "./execute-budget-command"

/** One usage event bound for its customer's payer budget, its customer already resolved. */
export type PayerUsageEvent = Readonly<{
  projectId: string
  customerId: string
  idempotencyKey: string
  eventSlug: string
  properties: UsageEventProperties
  /** Set for `record`: when the usage happened. `charge` prices at the budget's clock. */
  occurredAt?: number
}>

/** `record` counts usage that already happened; `charge` admits it only if it fits. */
export type PayerUsageVerb = "record" | "charge"

export type PayerUsageResult = Readonly<{
  event: PayerUsageEvent
  result: Result<OutcomeOf<PayerUsageVerb>, UnPriceBudgetError>
}>

/** Where refused events go: the budget journal stream (ADR-0008 D7). */
export type RejectedUsageJournal = {
  send(rows: readonly BudgetJournalRow[]): Promise<void>
}

export type MeterPayerUsageDeps = ExecuteBudgetCommandDeps & {
  /** Null when no stream is bound: refusals are then only logged. */
  journal: RejectedUsageJournal | null
}

export type MeterPayerUsageInput = Readonly<{
  verb: PayerUsageVerb
  events: readonly PayerUsageEvent[]
  /** When the API received the call; stamps the journal rows of refused events. */
  receivedAt: number
}>

/**
 * Sends each event to its customer's payer budget at `unprice:customer:<customerId>` (ADR-0008 D1,
 * D6), which meters and prices it, and answers one result per event in input order. Events of one
 * customer run in order, so a batch prices them as consecutive calls would; customers run side by
 * side. The budget is never created here: billing's compile owns it, so a customer without one
 * gets BUDGET_NOT_FOUND. Refused events go to the journal through `waitUntil`, best effort.
 */
export async function meterPayerUsage(
  deps: MeterPayerUsageDeps,
  input: MeterPayerUsageInput
): Promise<PayerUsageResult[]> {
  const { verb, events } = input
  const byBudget = new Map<string, number[]>()
  events.forEach((event, index) => {
    const budget = `${event.projectId}\n${event.customerId}`
    const indexes = byBudget.get(budget) ?? []
    indexes.push(index)
    byBudget.set(budget, indexes)
  })

  const results: PayerUsageResult[] = new Array(events.length)
  await Promise.all(
    [...byBudget.values()].map(async (indexes) => {
      for (const index of indexes) {
        const event = events[index] as PayerUsageEvent
        const result = await executeBudgetCommand(deps, {
          projectId: event.projectId,
          key: payerBudgetKey(event.customerId),
          request: requestOf(verb, event),
        })
        results[index] = { event, result }
      }
    })
  )

  journalRejections(deps, input, results)
  return results
}

function requestOf(verb: PayerUsageVerb, event: PayerUsageEvent) {
  const usage = { slug: event.eventSlug, properties: event.properties }
  if (verb === "charge") {
    return { type: "charge" as const, idempotencyKey: event.idempotencyKey, event: usage }
  }
  if (event.occurredAt === undefined) throw new Error("a recorded event needs occurredAt")
  return {
    type: "record" as const,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    event: usage,
  }
}

function journalRejections(
  deps: MeterPayerUsageDeps,
  input: MeterPayerUsageInput,
  results: readonly PayerUsageResult[]
): void {
  const rows = results.flatMap(({ event, result }) =>
    result.err ? [rejectedUsageRow(input, event, result.err)] : []
  )
  if (rows.length === 0) return
  const { journal, logger } = deps
  if (!journal) {
    logger.warn("refused usage events were not journaled: no budget journal stream is bound", {
      rejected: rows.length,
    })
    return
  }
  deps.waitUntil(
    journal.send(rows).catch((error: unknown) => {
      logger.error(error instanceof Error ? error : new Error(String(error)), {
        context: "refused usage events were not journaled",
        rejected: rows.length,
      })
    })
  )
}

/**
 * A refused event as the journal keeps it: `seq` 0, because the budget never wrote it, and the
 * operation id `r:<idempotency key>`. Amounts in the rejection become decimal strings.
 */
export function rejectedUsageRow(
  input: Pick<MeterPayerUsageInput, "verb" | "receivedAt">,
  event: PayerUsageEvent,
  error: UnPriceBudgetError
): BudgetJournalRow {
  const data = {
    customerId: event.customerId,
    idempotencyKey: event.idempotencyKey,
    event: { slug: event.eventSlug, properties: event.properties },
    ...(event.occurredAt !== undefined && { occurredAt: event.occurredAt }),
    rejection: error.rejection,
  }
  return {
    schema_version: BUDGET_JOURNAL_SCHEMA_VERSION,
    project_id: event.projectId,
    budget_key: payerBudgetKey(event.customerId),
    seq: 0,
    operation_id: `r:${event.idempotencyKey}`,
    kind: input.verb,
    status: "rejected",
    timestamp: new Date(input.receivedAt).toISOString(),
    data: JSON.parse(
      JSON.stringify(data, (_key, value: unknown) =>
        typeof value === "bigint" ? formatAmount(value) : value
      )
    ) as LakehouseJsonValue,
  }
}
