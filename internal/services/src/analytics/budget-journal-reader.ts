import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { BasinSql } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { warnBasinSqlNotConfigured } from "./basin-sql-warning"
import type { JournalQuery, StatementScope } from "./budget-journal"
import {
  rejectedEventQuery,
  statementEventCountQuery,
  statementEventsQuery,
} from "./budget-journal"

type ReaderDeps = { basinSql: BasinSql; logger: Logger }

export class BudgetJournalReader {
  constructor(private readonly deps: ReaderDeps) {}

  async read<T>(query: JournalQuery<T>): Promise<Result<T[], FetchError>> {
    const result = await this.deps.basinSql.query(query.sql, query.row)
    if (result.err) {
      if (result.err.code !== "NOT_CONFIGURED")
        this.deps.logger.error(result.err, { context: query.context })
      else warnBasinSqlNotConfigured(this.deps.logger, result.err.message, query.context)
      return Err(
        new FetchError({
          message: `${query.context}: ${result.err.message}`,
          retry: result.err.retry,
        })
      )
    }
    return Ok(result.val)
  }
}

/** A page plus its total, including when the requested page is empty. */
export async function getStatementEvents(
  reader: Pick<BudgetJournalReader, "read">,
  opts: StatementScope & { limit: number; offset: number }
) {
  const [events, count] = await Promise.all([
    reader.read(statementEventsQuery(opts)),
    reader.read(statementEventCountQuery(opts)),
  ])
  if (events.err) return Err(events.err)
  if (count.err) return Err(count.err)
  return Ok({
    events: events.val,
    ...(count.val[0] ?? {
      total: 0,
      firstEventAt: null,
      lastEventAt: null,
      multiComponentEventCount: 0,
    }),
  })
}

export async function getRejectedEvent(
  reader: Pick<BudgetJournalReader, "read">,
  opts: Parameters<typeof rejectedEventQuery>[0]
) {
  const rows = await reader.read(rejectedEventQuery(opts))
  if (rows.err) return Err(rows.err)
  return Ok(rows.val[0] ?? null)
}
