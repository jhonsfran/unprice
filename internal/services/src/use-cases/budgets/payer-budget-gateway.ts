import type { FetchError, Result } from "@unprice/error"
import type { UnPriceBudgetError } from "../../budgets"
import { PAYER_HOLDS, type UnPricePayerBudgetError } from "./compile-payer-budget"
import { InternalApiClient, type InternalApiOptions } from "./internal-api-client"
import {
  type CompletePayerStatementsInput,
  type CompletePayerStatementsOutput,
  type InvoicePayerStatementsDeps,
  type SealPayerStatementsInput,
  type SealPayerStatementsOutput,
  completeInvoicedPayerStatements,
  completePayerStatementsOutputSchema,
  sealPayerStatements,
  sealPayerStatementsOutputSchema,
} from "./invoice-payer-statements"
import {
  type SyncPayerBudgetDeps,
  type SyncPayerBudgetInput,
  type SyncPayerBudgetOutput,
  syncPayerBudget,
  syncPayerBudgetOutputSchema,
} from "./sync-payer-budget"

const SYNC_PATH = "/v1/internal/payer-budgets/sync"
const SEAL_PATH = "/v1/internal/payer-budgets/seal"
const COMPLETE_PATH = "/v1/internal/payer-budgets/complete"

export type PayerBudgetGatewayError = FetchError | UnPriceBudgetError | UnPricePayerBudgetError

/**
 * How billing reaches a payer budget next to its Durable Object: the compile (`sync`), and the
 * invoice's seal and completion of its statements. The API runs them in process; tRPC and Trigger
 * jobs call the API's internal routes.
 */
export interface PayerBudgetGateway {
  sync(input: SyncPayerBudgetInput): Promise<Result<SyncPayerBudgetOutput, PayerBudgetGatewayError>>
  seal(
    input: SealPayerStatementsInput
  ): Promise<Result<SealPayerStatementsOutput, PayerBudgetGatewayError>>
  completeInvoiced(
    input: CompletePayerStatementsInput
  ): Promise<Result<CompletePayerStatementsOutput, PayerBudgetGatewayError>>
}

/** The API worker's gateway: runs each use case in the same request, with the request's deps. */
export class InProcessPayerBudgetGateway implements PayerBudgetGateway {
  /** `deps` is read on each call, so a composition root can wire it after the services exist. */
  constructor(private readonly deps: () => SyncPayerBudgetDeps & InvoicePayerStatementsDeps) {}

  sync(input: SyncPayerBudgetInput) {
    return syncPayerBudget(this.deps(), input)
  }

  seal(input: SealPayerStatementsInput) {
    return sealPayerStatements(this.deps(), input)
  }

  completeInvoiced(input: CompletePayerStatementsInput) {
    return completeInvoicedPayerStatements(this.deps(), input)
  }
}

export class HttpPayerBudgetGateway implements PayerBudgetGateway {
  private readonly api: InternalApiClient
  private readonly timeoutMs: number
  constructor(options: InternalApiClient | InternalApiOptions) {
    this.timeoutMs = options instanceof InternalApiClient ? 20_000 : (options.timeoutMs ?? 20_000)
    this.api = options instanceof InternalApiClient ? options : new InternalApiClient(options)
  }
  sync(input: SyncPayerBudgetInput) {
    return this.api.post(SYNC_PATH, input, syncPayerBudgetOutputSchema, {
      timeoutMs: this.timeoutMs,
    })
  }
  seal(input: SealPayerStatementsInput) {
    return this.api.post(SEAL_PATH, input, sealPayerStatementsOutputSchema, {
      timeoutMs: this.timeoutMs,
    })
  }
  completeInvoiced(input: CompletePayerStatementsInput) {
    return this.api.post(COMPLETE_PATH, input, completePayerStatementsOutputSchema, {
      timeoutMs: this.timeoutMs,
    })
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
): Promise<Result<SyncPayerBudgetOutput, PayerBudgetGatewayError>> {
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
