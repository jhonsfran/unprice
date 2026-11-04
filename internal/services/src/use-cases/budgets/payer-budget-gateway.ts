import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { UnPriceBudgetError } from "../../budgets"
import { PAYER_HOLDS, type UnPricePayerBudgetError } from "./compile-payer-budget"
import {
  type SyncPayerBudgetDeps,
  type SyncPayerBudgetInput,
  type SyncPayerBudgetOutput,
  syncPayerBudget,
  syncPayerBudgetOutputSchema,
} from "./sync-payer-budget"

const SYNC_PATH = "/v1/internal/payer-budgets/sync"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"
/** One sync is a compile, an upsert, and a registration: well under this unless the API stalls. */
const SYNC_TIMEOUT_MS = 20_000

export type PayerBudgetSyncError = FetchError | UnPriceBudgetError | UnPricePayerBudgetError

/**
 * How billing reaches a payer budget: one `syncPayerBudget` attempt next to the budget's Durable
 * Object. The API runs it in process; tRPC and Trigger jobs call the API's internal route.
 */
export interface PayerBudgetGateway {
  sync(input: SyncPayerBudgetInput): Promise<Result<SyncPayerBudgetOutput, PayerBudgetSyncError>>
}

/** The API worker's gateway: runs the sync in the same request, with the request's deps. */
export class InProcessPayerBudgetGateway implements PayerBudgetGateway {
  /** `deps` is read on each call, so a composition root can wire it after the services exist. */
  constructor(private readonly deps: () => SyncPayerBudgetDeps) {}

  sync(input: SyncPayerBudgetInput) {
    return syncPayerBudget(this.deps(), input)
  }
}

type GatewayFetch = (request: Request) => Promise<Response>

export class HttpPayerBudgetGateway implements PayerBudgetGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetch: GatewayFetch
  private readonly timeoutMs: number

  constructor(options: {
    baseUrl?: string
    token: string
    fetch?: GatewayFetch
    timeoutMs?: number
  }) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
    this.token = options.token
    this.fetch = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS
  }

  async sync(input: SyncPayerBudgetInput): Promise<Result<SyncPayerBudgetOutput, FetchError>> {
    const context = { url: SYNC_PATH, method: "POST" }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    let body: unknown
    try {
      response = await this.fetch(
        new Request(`${this.baseUrl}${SYNC_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        })
      )
      body = await response.json().catch(() => null)
    } catch (error) {
      const message = controller.signal.aborted
        ? `${SYNC_PATH} timed out after ${this.timeoutMs} ms`
        : error instanceof Error
          ? error.message
          : `${SYNC_PATH} failed`
      return Err(new FetchError({ message, retry: true, context }))
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      return Err(
        new FetchError({
          message: `${SYNC_PATH} failed with status ${response.status}: ${JSON.stringify(body)}`,
          retry: response.status >= 500,
          context: { ...context, status: response.status },
        })
      )
    }
    const parsed = syncPayerBudgetOutputSchema.safeParse(body)
    if (!parsed.success) {
      return Err(
        new FetchError({
          message: `${SYNC_PATH} answered an unexpected body: ${parsed.error.message}`,
          retry: false,
          context: { ...context, status: response.status },
        })
      )
    }
    return Ok(parsed.data)
  }
}

/**
 * Who waits for open holds before a pricing change lands (ADR-0008 D1). A request never waits: it
 * syncs once and the next billing job catches up. A job retries until the longest hold has expired.
 */
export type PayerBudgetSyncCaller = "request" | "job"

const FIRST_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

/**
 * Syncs through `gateway`, retrying a `reservations_open` answer with backoff for a job, up to the
 * payer budget's max hold TTL. Returns the last answer: still `reservations_open` when the holds
 * outlasted the retry.
 */
export async function syncPayerBudgetWithRetry(
  gateway: PayerBudgetGateway,
  input: SyncPayerBudgetInput,
  options: {
    caller: PayerBudgetSyncCaller
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<Result<SyncPayerBudgetOutput, PayerBudgetSyncError>> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (options.caller === "job" ? PAYER_HOLDS.maxTtlMs : 0)
  let wait = FIRST_RETRY_MS
  let synced = await gateway.sync(input)
  while (synced.val?.status === "reservations_open" && now() + wait <= deadline) {
    await sleep(wait)
    wait = Math.min(wait * 2, MAX_RETRY_MS)
    synced = await gateway.sync(input)
  }
  return synced
}
