import type { Unprice } from "@unprice/api"
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
  constructor(private readonly client: Unprice) {}

  async flushForInvoicing(input: {
    customerId: string
    subscriptionId: string
    subscriptionPhaseId: string
    statementKey: string
  }): Promise<Result<void, FetchError>> {
    const { error } = await this.client.billing.reservations.flushForInvoicing(input)

    if (error) {
      return Err(
        new FetchError({
          message: error.message,
          retry: error.code === "FETCH_ERROR" || error.code === "INTERNAL_SERVER_ERROR",
          context: {
            url: "/v1/billing/reservations/flush-for-invoicing",
            method: "POST",
            code: error.code,
          },
        })
      )
    }

    return Ok(undefined)
  }
}

export function createNoopBillingReservationFlushGateway(): BillingReservationFlushGateway {
  return {
    flushForInvoicing: async () => Ok(undefined),
  }
}
