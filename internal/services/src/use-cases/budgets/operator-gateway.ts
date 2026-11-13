import {
  type InspectBudgetRequest,
  type InspectBudgetResponse,
  type ReleaseBudgetInternalInput,
  type ReleaseBudgetResponse,
  budgetReleaseRejectedDetailsSchema,
  inspectBudgetResponseSchema,
  releaseBudgetResponseSchema,
} from "@unprice/db/validators"
import type { FetchError, Result } from "@unprice/error"
import { UnPriceBudgetError } from "../../budgets"
import { InternalApiClient, type InternalApiOptions, errorOf } from "./internal-api-client"

const INSPECT_PATH = "/v1/internal/budgets/inspect"
const RELEASE_PATH = "/v1/internal/budgets/release"

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
  private readonly api: InternalApiClient
  constructor(options: InternalApiClient | InternalApiOptions) {
    this.api = options instanceof InternalApiClient ? options : new InternalApiClient(options)
  }
  inspect(input: InspectBudgetRequest) {
    return this.api.post(INSPECT_PATH, input, inspectBudgetResponseSchema, {
      rejectionOf: inspectRejection,
    })
  }
  release(input: ReleaseBudgetInternalInput) {
    return this.api.post(RELEASE_PATH, input, releaseBudgetResponseSchema, {
      rejectionOf: releaseRejection,
    })
  }
}
