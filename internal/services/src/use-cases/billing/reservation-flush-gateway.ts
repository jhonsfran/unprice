import { Err, Ok, type Result } from "@unprice/error"
import { FetchError } from "@unprice/error"
import type { z } from "zod"
import type { BillingUsageRegistration } from "../../billing/usage-snapshot"
import { billingUsageOperationOutputSchema, billingUsageOperationSchema } from "./usage-snapshots"

const INTERNAL_USAGE_PATH = "/v1/internal/billing-usage/snapshots"
const INTERNAL_FLUSH_PATH = "/v1/internal/billing-reservations/flush-for-invoicing"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

export interface BillingReservationFlushGateway {
  registerPeriods(input: {
    projectId: string
    customerId: string
    subscriptionId: string
    registrations: BillingUsageRegistration[]
  }): Promise<Result<void, FetchError>>
  completeForInvoicing(input: {
    projectId: string
    customerId: string
    subscriptionId: string
  }): Promise<Result<void, FetchError>>
  flushForInvoicing(input: {
    projectId: string
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<z.infer<typeof billingUsageOperationOutputSchema>, FetchError>>
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

  async flushForInvoicing(input: {
    projectId: string
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<z.infer<typeof billingUsageOperationOutputSchema>, FetchError>> {
    const sealed = await this.requestUsageOperation({ operation: "seal", ...input })
    if (sealed.err) return Err(sealed.err)
    const request = new Request(buildInternalFlushUrl(this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    })

    let response: Response
    try {
      response = await this.fetch(request)
    } catch (error) {
      return Err(
        new FetchError({
          message: error instanceof Error ? error.message : "Failed to flush billing reservations",
          retry: true,
          context: {
            url: INTERNAL_FLUSH_PATH,
            method: "POST",
          },
        })
      )
    }

    if (!response.ok) {
      return Err(
        new FetchError({
          message: await readErrorMessage(response),
          retry: shouldRetryFlushResponse(response.status),
          context: {
            url: INTERNAL_FLUSH_PATH,
            method: "POST",
            status: response.status,
          },
        })
      )
    }

    return Ok(sealed.val)
  }

  async registerPeriods(input: {
    projectId: string
    customerId: string
    subscriptionId: string
    registrations: BillingUsageRegistration[]
  }): Promise<Result<void, FetchError>> {
    const result = await this.requestUsageOperation({ operation: "register", ...input })
    return result.err ? Err(result.err) : Ok(undefined)
  }

  async completeForInvoicing(input: {
    projectId: string
    customerId: string
    subscriptionId: string
  }): Promise<Result<void, FetchError>> {
    const result = await this.requestUsageOperation({ operation: "complete", ...input })
    return result.err ? Err(result.err) : Ok(undefined)
  }

  private async requestUsageOperation(
    input: z.infer<typeof billingUsageOperationSchema>
  ): Promise<Result<z.infer<typeof billingUsageOperationOutputSchema>, FetchError>> {
    try {
      const response = await this.fetch(
        new Request(`${this.baseUrl.replace(/\/+$/, "")}${INTERNAL_USAGE_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(billingUsageOperationSchema.parse(input)),
        })
      )
      if (!response.ok)
        return Err(
          new FetchError({
            message: await readErrorMessage(response),
            retry: shouldRetryFlushResponse(response.status),
            context: { url: INTERNAL_USAGE_PATH, method: "POST", status: response.status },
          })
        )
      const parsed = billingUsageOperationOutputSchema.safeParse(await response.json())
      if (!parsed.success)
        return Err(
          new FetchError({ message: "Invalid authoritative billing usage response", retry: true })
        )
      return Ok(parsed.data)
    } catch (error) {
      return Err(
        new FetchError({
          message: error instanceof Error ? error.message : String(error),
          retry: true,
          context: { url: INTERNAL_USAGE_PATH, method: "POST" },
        })
      )
    }
  }
}

function buildInternalFlushUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${INTERNAL_FLUSH_PATH}`
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

export function createNoopBillingReservationFlushGateway(): BillingReservationFlushGateway {
  return {
    flushForInvoicing: async () => Ok({ snapshots: [] }),
    registerPeriods: async () => Ok(undefined),
    completeForInvoicing: async () => Ok(undefined),
  }
}
