import { consumeUsageInputSchema, recordUsageEventSchema } from "@unprice/db/validators"
import type { Result } from "@unprice/error"
import { rejectedJournalDataSchema } from "@unprice/lakehouse"
import type { BudgetJournalRow } from "@unprice/lakehouse"
import { z } from "zod"
import { type OutcomeOf, type UnPriceBudgetError, buildBudgetJournalRow } from "../../budgets"
import { payerBudgetKey } from "../../budgets/payer-key"
import { type ExecuteBudgetCommandDeps, executeBudgetCommand } from "./execute-budget-command"

/** The ids an adapter resolves for each event: the key's project and the event's customer. */
const resolvedIds = { projectId: z.string().min(1), customerId: z.string().min(1) }

export const meterPayerUsageInputSchema = z.discriminatedUnion("verb", [
  // `record` counts usage that already happened, at its `occurredAt`.
  z.object({
    verb: z.literal("record"),
    events: z.array(recordUsageEventSchema.extend(resolvedIds)),
    /** When the API received the call; stamps the journal rows of refused events. */
    receivedAt: z.number().int(),
  }),
  // `charge` admits usage only if it fits, priced at the budget's clock.
  z.object({
    verb: z.literal("charge"),
    events: z.array(consumeUsageInputSchema.extend(resolvedIds)),
    receivedAt: z.number().int(),
  }),
])

export type MeterPayerUsageInput = z.infer<typeof meterPayerUsageInputSchema>
export type PayerUsageVerb = MeterPayerUsageInput["verb"]
/** One usage event bound for its customer's payer budget, its customer already resolved. */
export type PayerUsageEvent = MeterPayerUsageInput["events"][number]

/**
 * One event's answer: the budget's `result`, or `unavailable` when its budget could not be reached
 * (the transport failed), so the event was never decided and a retry with its key is safe.
 */
export type PayerUsageResult =
  | Readonly<{
      event: PayerUsageEvent
      result: Result<OutcomeOf<PayerUsageVerb>, UnPriceBudgetError>
    }>
  | Readonly<{ event: PayerUsageEvent; unavailable: Error }>

/** Where refused events go: the budget journal stream (ADR-0008 D7). */
export type RejectedUsageJournal = {
  send(rows: readonly BudgetJournalRow[]): Promise<void>
}

export type MeterPayerUsageDeps = ExecuteBudgetCommandDeps & {
  /** Null when no stream is bound: refusals are then only logged. */
  journal: RejectedUsageJournal | null
}

/**
 * Sends each event to its customer's payer budget at `unprice:customer:<customerId>` (ADR-0008 D1,
 * D6), which meters and prices it, and answers one result per event in input order. Events of one
 * customer run in order, so a batch prices them as consecutive calls would; customers run side by
 * side. When a customer's budget cannot be reached, that event and the customer's later ones answer
 * `unavailable` (logged, never journaled) and the other customers' events answer normally. The
 * budget is never created here: billing's compile owns it, so a customer without one gets
 * BUDGET_NOT_FOUND. Refused events go to the journal through `waitUntil`, best effort.
 */
export async function meterPayerUsage(
  deps: MeterPayerUsageDeps,
  input: MeterPayerUsageInput
): Promise<PayerUsageResult[]> {
  const commands = commandsOf(input)
  const byBudget = new Map<string, number[]>()
  commands.forEach(({ event }, index) => {
    const budget = `${event.projectId}\n${event.customerId}`
    const indexes = byBudget.get(budget) ?? []
    indexes.push(index)
    byBudget.set(budget, indexes)
  })

  const results: PayerUsageResult[] = new Array(commands.length)
  await Promise.all(
    [...byBudget.values()].map(async (indexes) => {
      for (const [position, index] of indexes.entries()) {
        const { event, request } = commands[index] as Command
        try {
          const result = await executeBudgetCommand(deps, {
            projectId: event.projectId,
            key: payerBudgetKey(event.customerId),
            request,
          })
          // A wallet that refused the funding left the event undecided, not refused by the budget.
          if (result.err?.rejection.code === "FUNDING_FAILED") throw result.err
          results[index] = { event, result }
        } catch (caught) {
          // The budget was never reached: this event and the customer's later ones stay undecided,
          // so a retry prices them in the order this call would have.
          const unavailable = caught instanceof Error ? caught : new Error(String(caught))
          const undecided = indexes.slice(position)
          deps.logger.error(unavailable, {
            context: "payer budget unreachable: usage events left undecided",
            project_id: event.projectId,
            customer_id: event.customerId,
            undecided: undecided.length,
          })
          for (const skipped of undecided) {
            results[skipped] = { event: (commands[skipped] as Command).event, unavailable }
          }
          return
        }
      }
    })
  )

  journalRejections(deps, input, results)
  return results
}

type Command = ReturnType<typeof commandsOf>[number]

/** Each event with the budget request its verb sends. */
function commandsOf(input: MeterPayerUsageInput) {
  const usage = ({ eventSlug, properties }: PayerUsageEvent) => ({ slug: eventSlug, properties })
  if (input.verb === "charge") {
    return input.events.map((event) => ({
      event,
      request: {
        type: "charge" as const,
        idempotencyKey: event.idempotencyKey,
        event: usage(event),
      },
    }))
  }
  return input.events.map((event) => ({
    event,
    request: {
      type: "record" as const,
      idempotencyKey: event.idempotencyKey,
      occurredAt: event.occurredAt,
      event: usage(event),
    },
  }))
}

function journalRejections(
  deps: MeterPayerUsageDeps,
  input: MeterPayerUsageInput,
  results: readonly PayerUsageResult[]
): void {
  // Only the budget's refusals: an event whose budget was unreachable was never decided.
  const rows = results.flatMap((answer) =>
    "result" in answer && answer.result.err
      ? [rejectedUsageRow(input, answer.event, answer.result.err)]
      : []
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
  const data = rejectedJournalDataSchema.parse({
    customerId: event.customerId,
    idempotencyKey: event.idempotencyKey,
    event: { slug: event.eventSlug, properties: event.properties },
    ...("occurredAt" in event && { occurredAt: event.occurredAt }),
    rejection: error.rejection,
  })
  return buildBudgetJournalRow({
    project_id: event.projectId,
    budget_key: payerBudgetKey(event.customerId),
    seq: 0,
    operation_id: `r:${event.idempotencyKey}`,
    kind: input.verb,
    status: "rejected",
    writtenAt: input.receivedAt,
    data,
  })
}
