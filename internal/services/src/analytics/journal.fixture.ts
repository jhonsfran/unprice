import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import { type BasinSql, BasinSqlError } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { vi } from "vitest"
import { z } from "zod"
import { AnalyticsService } from "./service"

/**
 * An `AnalyticsService` over a fake Basin SQL port. `answer` gets each query's SQL and returns the
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
      return Ok(z.array(row).parse(rows))
    },
  }
  const logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
  const analytics = new AnalyticsService({
    db: {} as Database,
    logger,
    basinSql,
    ledgerGateway: {} as never,
  })
  return { analytics, queries }
}
