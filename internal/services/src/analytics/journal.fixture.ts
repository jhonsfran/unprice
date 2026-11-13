import { Err, Ok } from "@unprice/error"
import { type BasinSql, BasinSqlError } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { vi } from "vitest"
import { z } from "zod"
import { BudgetJournalReader } from "./budget-journal-reader"

/**
 * A `BudgetJournalReader` over a fake Basin SQL port. `answer` gets each query's SQL and returns the
 * literal rows Basin would (parsed by the service's own row schema), or an Error for a failed query.
 */
export function journalAnalytics(answer: (sql: string) => unknown[] | Error) {
  const queries: string[] = []
  const basinSql: BasinSql = {
    async query(sql, row) {
      queries.push(sql)
      const rows = answer(sql)
      if (rows instanceof Error) {
        return Err(new BasinSqlError({ code: "QUERY_ERROR", message: rows.message }))
      }
      const parsed = z.array(row).safeParse(rows)
      return parsed.success
        ? Ok(parsed.data)
        : Err(new BasinSqlError({ code: "INVALID_RESPONSE", message: parsed.error.message }))
    },
  }
  const logger: Logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(async () => {}),
  }
  const budgetJournal = new BudgetJournalReader({ logger, basinSql })
  return { budgetJournal, queries, logger }
}
