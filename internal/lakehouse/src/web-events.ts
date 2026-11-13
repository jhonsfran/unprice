import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import { type LakehouseEventForSource, getLakehouseSourceSchema } from "./registry"
import { type RetryPolicy, isAbortError, withRetries } from "./retry"
import { buildLakehouseEventZodSchema } from "./zod"

export const WEB_EVENT_KINDS = ["page_hit", "plan_view", "plan_click", "signup"] as const
export type WebEventKind = (typeof WEB_EVENT_KINDS)[number]

const WEB_EVENTS_SCHEMA_VERSION = getLakehouseSourceSchema("web_events").currentVersion

/** Fully qualified Basin Catalog table: `<namespace>.<sink table>`, as provisioned by configure-lakehouse-pipelines.sh. */
export const WEB_EVENTS_TABLE = `lakehouse.${getLakehouseSourceSchema("web_events").sinkTable}`

export type WebEventRow = Omit<LakehouseEventForSource<"web_events">, "kind" | "timestamp"> & {
  kind: WebEventKind
  timestamp: string
}

const fieldsRequiredByKind: Record<WebEventKind, readonly (keyof WebEventRow)[]> = {
  page_hit: ["page_id"],
  plan_view: ["page_id", "plan_version_id"],
  plan_click: ["page_id", "plan_version_id"],
  signup: ["customer_id", "plan_version_id", "signup_status"],
}

/**
 * The stream accepts a structurally invalid row and drops it later without an error, so every row
 * is parsed with this schema before it is sent.
 */
export const webEventRowSchema = buildLakehouseEventZodSchema("web_events")
  .extend({
    event_id: z.string().min(1),
    kind: z.enum(WEB_EVENT_KINDS),
    timestamp: z.iso.datetime(),
    project_id: z.string().min(1),
  })
  .superRefine((row, ctx) => {
    const kind = row.kind as WebEventKind
    for (const field of fieldsRequiredByKind[kind]) {
      const value = row[field]
      if (typeof value !== "string" || value.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for ${kind} rows`,
        })
      }
    }
  }) as unknown as z.ZodType<WebEventRow>

export type WebEventRowInput = Omit<WebEventRow, "event_id" | "schema_version" | "timestamp"> & {
  timestamp?: Date
}

export function createWebEventRow(input: WebEventRowInput): WebEventRow {
  const { timestamp, ...rest } = input
  return {
    ...rest,
    schema_version: WEB_EVENTS_SCHEMA_VERSION,
    event_id: crypto.randomUUID(),
    timestamp: (timestamp ?? new Date()).toISOString(),
  }
}

export type WebEventsWriteErrorCode = "NOT_CONFIGURED" | "INVALID_ROW" | "HTTP_ERROR" | "NETWORK"

export class WebEventsWriteError extends BaseError<{ code: WebEventsWriteErrorCode }> {
  public readonly name = WebEventsWriteError.name
  public readonly retry: boolean
  public readonly code: WebEventsWriteErrorCode

  constructor(opts: { code: WebEventsWriteErrorCode; message: string; retry?: boolean }) {
    super({ message: opts.message, context: { code: opts.code } })
    this.code = opts.code
    this.retry = opts.retry ?? false
  }
}

export interface WebEventsWriter {
  send(rows: readonly WebEventRow[]): Promise<Result<{ sent: number }, WebEventsWriteError>>
}

/**
 * Writes web analytics rows to the `web_events` Basin Pipelines stream over its HTTP ingest
 * endpoint (`https://<stream-id>.ingest.cloudflare.com`, bearer token with Pipelines Send). Next.js
 * on Vercel has no Worker binding, so the API worker uses the same path. A retryable failure (429,
 * 5xx, network, timeout) is retried `retries` times with exponential backoff. Never throws.
 */
export function createWebEventsWriter(
  config: {
    url?: string
    token?: string
    fetch?: typeof fetch
    timeoutMs?: number
  } & Partial<RetryPolicy>
): WebEventsWriter {
  const fetchImpl = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 5_000
  const policy: RetryPolicy = { retries: config.retries ?? 2, backoffMs: config.backoffMs ?? 200 }

  async function attempt(
    url: string,
    token: string,
    body: string,
    sent: number
  ): Promise<Result<{ sent: number }, WebEventsWriteError>> {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        return Err(
          new WebEventsWriteError({
            code: "HTTP_ERROR",
            message: `web events stream returned ${response.status}: ${await response.text()}`,
            retry: response.status === 429 || response.status >= 500,
          })
        )
      }

      return Ok({ sent })
    } catch (error) {
      return Err(
        new WebEventsWriteError({
          code: "NETWORK",
          message: isAbortError(error)
            ? `web events stream request timed out after ${timeoutMs}ms`
            : `web events stream request failed: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  return {
    async send(rows) {
      const { url, token } = config
      if (!url || !token) {
        return Err(
          new WebEventsWriteError({
            code: "NOT_CONFIGURED",
            message: "LAKEHOUSE_WEB_EVENTS_URL and LAKEHOUSE_WEB_EVENTS_TOKEN are required",
          })
        )
      }

      if (rows.length === 0) {
        return Ok({ sent: 0 })
      }

      const parsed: WebEventRow[] = []
      for (const row of rows) {
        const result = webEventRowSchema.safeParse(row)
        if (!result.success) {
          return Err(
            new WebEventsWriteError({
              code: "INVALID_ROW",
              message: `invalid ${row.kind} web event: ${result.error.message}`,
            })
          )
        }
        parsed.push(result.data)
      }

      // Rows carry their event_id, so a retry after an ambiguous failure duplicates at most by
      // event_id, which the readers count distinct.
      const body = JSON.stringify(parsed)
      return withRetries(() => attempt(url, token, body, parsed.length), policy)
    },
  }
}

/** The two logger methods `recordWebEvents` uses; `@unprice/logs` loggers satisfy it. */
type WebEventsLogger = {
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: unknown, fields?: Record<string, unknown>): void
}

/**
 * Sends rows to the web events stream and logs a failure; never rejects. A missing configuration
 * is a warning, every other failure an error.
 */
export async function recordWebEvents(
  deps: { webEvents: WebEventsWriter; logger: WebEventsLogger },
  rows: WebEventRow[]
): Promise<Result<{ sent: number }, WebEventsWriteError>> {
  const result = await deps.webEvents.send(rows)
  if (!result.err) {
    return result
  }
  const fields = { code: result.err.code, kinds: rows.map((row) => row.kind) }
  if (result.err.code === "NOT_CONFIGURED") {
    deps.logger.warn(`web analytics events were not recorded: ${result.err.message}`, fields)
  } else {
    deps.logger.error(result.err, { context: "web analytics events were not recorded", ...fields })
  }
  return result
}
