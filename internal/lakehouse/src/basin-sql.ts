import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"

export type BasinSqlErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "NETWORK"
  | "QUERY_ERROR"
  | "INVALID_RESPONSE"

export class BasinSqlError extends BaseError<{ code: BasinSqlErrorCode; status?: number }> {
  public readonly name = BasinSqlError.name
  public readonly retry: boolean
  public readonly code: BasinSqlErrorCode

  constructor(opts: {
    code: BasinSqlErrorCode
    message: string
    status?: number
    retry?: boolean
  }) {
    super({ message: opts.message, context: { code: opts.code, status: opts.status } })
    this.code = opts.code
    this.retry = opts.retry ?? false
  }
}

export interface BasinSql {
  query<T>(sql: string, row: z.ZodType<T>): Promise<Result<T[], BasinSqlError>>
}

const responseSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).default([]),
  result: z
    .object({ rows: z.array(z.unknown()) })
    .nullable()
    .optional(),
})

const BASIN_SQL_HOST = "https://api.sql.cloudflarestorage.com"

/**
 * Basin SQL has no Workers binding: queries go to the REST endpoint
 * `/api/v1/accounts/{account}/basin-sql/query/{bucket}`. A client built without credentials
 * answers every query with `NOT_CONFIGURED`, so composition roots never branch on env.
 */
export function createBasinSql(config: {
  accountId?: string
  bucket?: string
  token?: string
  fetch?: typeof fetch
  timeoutMs?: number
}): BasinSql {
  const fetchImpl = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 10_000

  return {
    async query(sql, row) {
      if (!config.accountId || !config.bucket || !config.token) {
        return Err(
          new BasinSqlError({
            code: "NOT_CONFIGURED",
            message: "BASIN_SQL_ACCOUNT_ID, BASIN_SQL_BUCKET and BASIN_SQL_TOKEN are required",
          })
        )
      }

      const url = `${BASIN_SQL_HOST}/api/v1/accounts/${encodeURIComponent(config.accountId)}/basin-sql/query/${encodeURIComponent(config.bucket)}`

      let response: Response
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: sql }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        return Err(
          new BasinSqlError({
            code: timedOut ? "TIMEOUT" : "NETWORK",
            message: timedOut
              ? `Basin SQL query timed out after ${timeoutMs}ms`
              : `Basin SQL request failed: ${error instanceof Error ? error.message : String(error)}`,
            retry: true,
          })
        )
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        return Err(
          new BasinSqlError({
            code: "INVALID_RESPONSE",
            message: `Basin SQL returned a non-JSON body with status ${response.status}`,
            status: response.status,
            retry: response.status >= 500,
          })
        )
      }

      const parsed = responseSchema.safeParse(body)
      if (!parsed.success) {
        return Err(
          new BasinSqlError({
            code: "INVALID_RESPONSE",
            message: `Basin SQL returned an unexpected body with status ${response.status}`,
            status: response.status,
          })
        )
      }

      const { success, errors, result } = parsed.data
      if (!response.ok || !success || errors.length > 0 || !result) {
        const detail = errors.map((error) => `${error.code ?? "?"}: ${error.message}`).join("; ")
        return Err(
          new BasinSqlError({
            code: "QUERY_ERROR",
            message: `Basin SQL query failed (${response.status}): ${detail || "no error detail"}`,
            status: response.status,
            retry: response.status === 429 || response.status >= 500,
          })
        )
      }

      const rows = z.array(row).safeParse(result.rows)
      if (!rows.success) {
        return Err(
          new BasinSqlError({
            code: "INVALID_RESPONSE",
            message: `Basin SQL rows did not match the expected shape: ${rows.error.message}`,
            status: response.status,
          })
        )
      }

      return Ok(rows.data)
    },
  }
}

/** A SQL string literal. Single quotes are doubled; Basin SQL strings have no backslash escapes. */
export function sqlString(value: string): string {
  if (value.includes("\u0000")) {
    throw new RangeError("SQL string literal cannot contain a NUL character")
  }
  return `'${value.replaceAll("'", "''")}'`
}

/** A timestamp literal in RFC 3339 with `Z`, the only form Basin SQL compares without a cast. */
export function sqlTimestamp(value: Date): string {
  return `'${value.toISOString()}'`
}

export function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`SQL integer literal must be a safe integer, got ${value}`)
  }
  return String(value)
}
