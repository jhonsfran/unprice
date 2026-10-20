import {
  type InspectBudgetRequest,
  type InspectBudgetResponse,
  inspectBudgetResponseSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import { UnPriceBudgetError } from "../../budgets"

const INSPECT_PATH = "/v1/internal/budgets/inspect"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

/** The dashboard's operator calls on budgets, through the API's internal routes. */
export interface BudgetOperatorGateway {
  /** A BUDGET_NOT_FOUND `UnPriceBudgetError` when the key has no budget. */
  inspect(
    input: InspectBudgetRequest
  ): Promise<Result<InspectBudgetResponse, FetchError | UnPriceBudgetError>>
}

type GatewayFetch = (request: Request) => Promise<Response>

export class HttpBudgetOperatorGateway implements BudgetOperatorGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetch: GatewayFetch

  constructor(options: { baseUrl?: string; token: string; fetch?: GatewayFetch }) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  async inspect(
    input: InspectBudgetRequest
  ): Promise<Result<InspectBudgetResponse, FetchError | UnPriceBudgetError>> {
    const context = { url: INSPECT_PATH, method: "POST" }
    let response: Response
    let body: unknown
    try {
      response = await this.fetch(
        new Request(`${this.baseUrl}${INSPECT_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      )
      body = await response.json().catch(() => null)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Budget inspect failed"
      return Err(new FetchError({ message, retry: true, context }))
    }

    // Only the API's own error body means the budget is missing. A bare 404 from a host without
    // the route must not read as "no budget", or read-repair would forget catalog rows.
    const code = errorOf(body)?.code
    if (response.status === 404 && code === "NOT_FOUND") {
      return Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" }))
    }
    if (!response.ok) {
      return Err(
        new FetchError({
          message: errorOf(body)?.message ?? `Budget inspect failed with status ${response.status}`,
          retry: response.status >= 500,
          context: { ...context, status: response.status },
        })
      )
    }
    const parsed = inspectBudgetResponseSchema.safeParse(body)
    if (!parsed.success) {
      return Err(
        new FetchError({
          message: `Budget inspect answered an unexpected body: ${parsed.error.message}`,
          retry: false,
          context: { ...context, status: response.status },
        })
      )
    }
    return Ok(parsed.data)
  }
}

/** The `error` of the API's error body, `{ error: { code, message } }`. */
function errorOf(body: unknown): { code?: unknown; message?: string } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null
  const { error } = body
  if (typeof error !== "object" || error === null) return null
  const message =
    "message" in error && typeof error.message === "string" ? error.message : undefined
  return { code: "code" in error ? error.code : undefined, message }
}
