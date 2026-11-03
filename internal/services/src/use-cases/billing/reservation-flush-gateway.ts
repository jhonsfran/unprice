import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { z } from "zod"
import {
  type FlushReservationsForInvoicingInput,
  type FlushReservationsForInvoicingOutput,
  flushReservationsForInvoicingInputSchema,
  flushReservationsForInvoicingOutputSchema,
} from "./flush-reservations-for-invoicing"
import {
  type BillingUsageOperation,
  billingUsageOperationOutputSchema,
  billingUsageOperationSchema,
} from "./usage-snapshots"

const INTERNAL_USAGE_PATH = "/v1/internal/billing-usage/snapshots"
const INTERNAL_FLUSH_PATH = "/v1/internal/billing-reservations/flush-for-invoicing"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

type RegisterPeriodsInput = Omit<
  Extract<BillingUsageOperation, { operation: "register" }>,
  "operation"
>
type CompleteForInvoicingInput = Omit<
  Extract<BillingUsageOperation, { operation: "complete" }>,
  "operation"
>

export interface BillingReservationFlushGateway {
  registerPeriods(input: RegisterPeriodsInput): Promise<Result<void, FetchError>>
  completeForInvoicing(input: CompleteForInvoicingInput): Promise<Result<void, FetchError>>
  flushForInvoicing(
    input: FlushReservationsForInvoicingInput
  ): Promise<Result<FlushReservationsForInvoicingOutput, FetchError>>
}

type BillingReservationFlushGatewayFetch = (request: Request) => Promise<Response>

type HttpBillingReservationFlushGatewayOptions = {
  baseUrl?: string
  token: string
  fetch?: BillingReservationFlushGatewayFetch
}

export class HttpBillingReservationFlushGateway implements BillingReservationFlushGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetch: BillingReservationFlushGatewayFetch

  constructor(options: HttpBillingReservationFlushGatewayOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL
    this.token = options.token
    this.fetch = options.fetch ?? fetch
  }

  async flushForInvoicing(
    input: FlushReservationsForInvoicingInput
  ): Promise<Result<FlushReservationsForInvoicingOutput, FetchError>> {
    return this.request(
      INTERNAL_FLUSH_PATH,
      input,
      flushReservationsForInvoicingInputSchema,
      flushReservationsForInvoicingOutputSchema
    )
  }

  async registerPeriods(input: RegisterPeriodsInput): Promise<Result<void, FetchError>> {
    const result = await this.request(
      INTERNAL_USAGE_PATH,
      { operation: "register", ...input },
      billingUsageOperationSchema,
      billingUsageOperationOutputSchema
    )
    return result.err ? Err(result.err) : Ok(undefined)
  }

  async completeForInvoicing(input: CompleteForInvoicingInput): Promise<Result<void, FetchError>> {
    const result = await this.request(
      INTERNAL_USAGE_PATH,
      { operation: "complete", ...input },
      billingUsageOperationSchema,
      billingUsageOperationOutputSchema
    )
    return result.err ? Err(result.err) : Ok(undefined)
  }

  private async request<T>(
    path: string,
    input: unknown,
    inputSchema: z.ZodType<unknown>,
    outputSchema: z.ZodType<T>
  ): Promise<Result<T, FetchError>> {
    try {
      const response = await this.fetch(
        new Request(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(inputSchema.parse(input)),
        })
      )
      if (!response.ok)
        return Err(
          new FetchError({
            message: await readErrorMessage(response),
            retry: shouldRetryFlushResponse(response.status),
            context: { url: path, method: "POST", status: response.status },
          })
        )
      const parsed = outputSchema.safeParse(await response.json())
      if (!parsed.success)
        return Err(new FetchError({ message: "Invalid internal billing response", retry: true }))
      return Ok(parsed.data)
    } catch (error) {
      return Err(
        new FetchError({
          message: error instanceof Error ? error.message : String(error),
          retry: true,
          context: { url: path, method: "POST" },
        })
      )
    }
  }
}

function shouldRetryFlushResponse(status: number): boolean {
  return status === 409 || status >= 500
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Billing reservation flush failed with status ${response.status}`

  try {
    const payload: unknown = await response.clone().json()

    if (isObject(payload) && typeof payload.message === "string") {
      return payload.message
    }

    if (isObject(payload) && isObject(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message
    }
  } catch {
    // Fall back to response text below.
  }

  try {
    const text = await response.text()
    return text || fallback
  } catch {
    return fallback
  }
}
