import {
  type InspectBudgetRequest,
  type InspectBudgetResponse,
  type ReleaseBudgetInternalInput,
  type ReleaseBudgetResponse,
  budgetReleaseRejectedDetailsSchema,
  inspectBudgetResponseSchema,
  releaseBudgetResponseSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { z } from "zod"
import { UnPriceBudgetError } from "../../budgets"

const INSPECT_PATH = "/v1/internal/budgets/inspect"
const RELEASE_PATH = "/v1/internal/budgets/release"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

/** The dashboard's operator calls on budgets, through the API's internal routes. */
export interface BudgetOperatorGateway {
  /** A BUDGET_NOT_FOUND `UnPriceBudgetError` when the key has no budget. */
  inspect(
    input: InspectBudgetRequest
  ): Promise<Result<InspectBudgetResponse, FetchError | UnPriceBudgetError>>
  /** The budget's rejection (HOLD_CLOSED, HOLD_RETIRED, HOLD_NOT_FOUND, BUDGET_NOT_FOUND) as an `UnPriceBudgetError`. */
  release(
    input: ReleaseBudgetInternalInput
  ): Promise<Result<ReleaseBudgetResponse, FetchError | UnPriceBudgetError>>
}

type GatewayFetch = (request: Request) => Promise<Response>

/** Reads the budget's rejection from an answer, or null when the answer is not one. */
type RejectionOf = (status: number, body: unknown) => UnPriceBudgetError | null

// Only the API's own error body names a rejection. A bare 404 from a host without the route must
// not read as "no budget", or read-repair would forget catalog rows.
const inspectRejection: RejectionOf = (status, body) =>
  status === 404 && errorOf(body)?.code === "NOT_FOUND"
    ? new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" })
    : null

const releaseRejection: RejectionOf = (status, body) => {
  if (status !== 404 && status !== 409) return null
  const details = budgetReleaseRejectedDetailsSchema.safeParse(errorOf(body)?.details)
  return details.success ? new UnPriceBudgetError(details.data.rejection) : null
}

export class HttpBudgetOperatorGateway implements BudgetOperatorGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetch: GatewayFetch

  constructor(options: { baseUrl?: string; token: string; fetch?: GatewayFetch }) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "")
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  inspect(input: InspectBudgetRequest) {
    return this.post(INSPECT_PATH, input, inspectBudgetResponseSchema, inspectRejection)
  }

  release(input: ReleaseBudgetInternalInput) {
    return this.post(RELEASE_PATH, input, releaseBudgetResponseSchema, releaseRejection)
  }

  private async post<S extends z.ZodTypeAny>(
    path: string,
    input: unknown,
    schema: S,
    rejectionOf: RejectionOf
  ): Promise<Result<z.infer<S>, FetchError | UnPriceBudgetError>> {
    const context = { url: path, method: "POST" }
    let response: Response
    let body: unknown
    try {
      response = await this.fetch(
        new Request(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      )
      body = await response.json().catch(() => null)
    } catch (error) {
      const message = error instanceof Error ? error.message : `${path} failed`
      return Err(new FetchError({ message, retry: true, context }))
    }

    const rejection = rejectionOf(response.status, body)
    if (rejection) return Err(rejection)
    if (!response.ok) {
      return Err(
        new FetchError({
          message: errorOf(body)?.message ?? `${path} failed with status ${response.status}`,
          retry: response.status >= 500,
          context: { ...context, status: response.status },
        })
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return Err(
        new FetchError({
          message: `${path} answered an unexpected body: ${parsed.error.message}`,
          retry: false,
          context: { ...context, status: response.status },
        })
      )
    }
    return Ok(parsed.data)
  }
}

/** The `error` of the API's error body, `{ error: { code, message, details } }`. */
function errorOf(body: unknown): { code?: unknown; message?: string; details?: unknown } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null
  const { error } = body
  if (typeof error !== "object" || error === null) return null
  const message =
    "message" in error && typeof error.message === "string" ? error.message : undefined
  return {
    code: "code" in error ? error.code : undefined,
    message,
    details: "details" in error ? error.details : undefined,
  }
}
