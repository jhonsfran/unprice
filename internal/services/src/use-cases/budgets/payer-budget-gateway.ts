import { Err, FetchError, Ok, type Result } from "@unprice/error"
import {
  type SyncPayerBudgetInput,
  type SyncPayerBudgetOutput,
  syncPayerBudgetOutputSchema,
} from "./sync-payer-budget"

const SYNC_PATH = "/v1/internal/payer-budgets/sync"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

/**
 * How billing outside the API worker (tRPC, Trigger jobs) reaches a payer budget: the API's
 * internal route runs `syncPayerBudget` next to the budget's Durable Object.
 */
export interface PayerBudgetGateway {
  sync(input: SyncPayerBudgetInput): Promise<Result<SyncPayerBudgetOutput, FetchError>>
}

type GatewayFetch = (request: Request) => Promise<Response>

export class HttpPayerBudgetGateway implements PayerBudgetGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetch: GatewayFetch

  constructor(options: { baseUrl?: string; token: string; fetch?: GatewayFetch }) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  async sync(input: SyncPayerBudgetInput): Promise<Result<SyncPayerBudgetOutput, FetchError>> {
    const context = { url: SYNC_PATH, method: "POST" }
    let response: Response
    let body: unknown
    try {
      response = await this.fetch(
        new Request(`${this.baseUrl}${SYNC_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      )
      body = await response.json().catch(() => null)
    } catch (error) {
      const message = error instanceof Error ? error.message : `${SYNC_PATH} failed`
      return Err(new FetchError({ message, retry: true, context }))
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
