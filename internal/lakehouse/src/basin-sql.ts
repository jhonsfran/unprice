import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import { type RetryPolicy, isAbortError, withRetries } from "./retry"

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
 * `timeoutMs` bounds each attempt; an attempt that fails with a retryable error is retried
 * `retries` times with exponential backoff.
 */
export function createBasinSql(
  config: {
    accountId?: string
    bucket?: string
    token?: string
    fetch?: typeof fetch
    timeoutMs?: number
  } & Partial<RetryPolicy>
): BasinSql {
  const fetchImpl = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 10_000
  const policy: RetryPolicy = { retries: config.retries ?? 2, backoffMs: config.backoffMs ?? 200 }

  async function attempt<T>(
    url: string,
    token: string,
    sql: string,
    row: z.ZodType<T>
  ): Promise<Result<T[], BasinSqlError>> {
    let response: Response
    let text: string
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Read the body inside the same try: a timeout or reset mid-body is a transport failure.
      text = await response.text()
    } catch (error) {
      const timedOut = isAbortError(error)
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

    // A 5xx or 429 that is not a Basin envelope (a gateway page, an empty body) is retryable.
    const transient = response.status === 429 || response.status >= 500

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return Err(
        new BasinSqlError({
          code: "INVALID_RESPONSE",
          message: `Basin SQL returned a non-JSON body with status ${response.status}`,
          status: response.status,
          retry: transient,
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
          retry: transient,
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
          retry: transient,
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
  }

  return {
    async query(sql, row) {
      const { accountId, bucket, token } = config
      if (!accountId || !bucket || !token) {
        return Err(
          new BasinSqlError({
            code: "NOT_CONFIGURED",
            message: "BASIN_SQL_ACCOUNT_ID, BASIN_SQL_BUCKET and BASIN_SQL_TOKEN are required",
          })
        )
      }

      const url = `${BASIN_SQL_HOST}/api/v1/accounts/${encodeURIComponent(accountId)}/basin-sql/query/${encodeURIComponent(bucket)}`
      return withRetries(() => attempt(url, token, sql, row), policy)
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
