import { Err, Ok, type Result } from "@unprice/error"
import { FetchError } from "@unprice/error"

const INTERNAL_FLUSH_PATH = "/v1/internal/billing-reservations/flush-for-invoicing"
const DEFAULT_API_BASE_URL = "https://api.unprice.dev"

export interface BillingReservationFlushGateway {
  flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, FetchError>>
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
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, FetchError>> {
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
          retry: response.status >= 500,
          context: {
            url: INTERNAL_FLUSH_PATH,
            method: "POST",
            status: response.status,
          },
        })
      )
    }

    return Ok(undefined)
  }
}

function buildInternalFlushUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${INTERNAL_FLUSH_PATH}`
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
    flushForInvoicing: async () => Ok(undefined),
  }
}
