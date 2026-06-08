import { Err, Ok, type Result } from "@unprice/error"
import { FetchError } from "@unprice/error"

export interface BillingReservationFlushGateway {
  flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, FetchError>>
}

export class SdkBillingReservationFlushGateway implements BillingReservationFlushGateway {
  private readonly baseUrl: string
  private readonly token: string
  private readonly retryAttempts: number

  constructor(opts: { baseUrl: string; token: string; retryAttempts?: number }) {
    this.baseUrl = opts.baseUrl
    this.token = opts.token
    this.retryAttempts = opts.retryAttempts ?? 2
  }

  async flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, FetchError>> {
    const url = `${this.baseUrl}/v1/billing/reservations/flush-for-invoicing`
    let lastError: FetchError | null = null

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        })

        if (response.ok) {
          return Ok(undefined)
        }

        const body = (await response.json().catch(() => null)) as {
          message?: string
        } | null
        const message = body?.message ?? `Reservation flush failed with status ${response.status}`

        lastError = new FetchError({
          message,
          retry: response.status === 409 || response.status >= 500,
          context: { url, method: "POST", status: response.status },
        })

        // Retry on 409 (deferred) and 5xx
        if ((response.status === 409 || response.status >= 500) && attempt < this.retryAttempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.round(Math.exp(attempt) * 10)))
          continue
        }

        return Err(lastError)
      } catch (error) {
        lastError = new FetchError({
          message: error instanceof Error ? error.message : String(error),
          retry: true,
          context: { url, method: "POST" },
        })
        if (attempt < this.retryAttempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.round(Math.exp(attempt) * 10)))
        }
      }
    }

    return Err(
      lastError ??
        new FetchError({
          message: "Reservation flush failed after retries",
          retry: false,
          context: { url, method: "POST" },
        })
    )
  }
}

export function createNoopBillingReservationFlushGateway(): BillingReservationFlushGateway {
  return {
    flushForInvoicing: async () => Ok(undefined),
  }
}
