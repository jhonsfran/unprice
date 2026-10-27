import { Ok } from "@unprice/error"
import { vi } from "vitest"
import type { BillingReservationFlushGateway } from "../use-cases/billing/reservation-flush-gateway"

export function createBillingGatewayStub() {
  return {
    registerPeriods: vi.fn(async () => Ok(undefined)),
    flushForInvoicing: vi.fn(async () => Ok({ snapshots: [], flushed: 0, skipped: 0 })),
    completeForInvoicing: vi.fn(async () => Ok(undefined)),
  } satisfies BillingReservationFlushGateway
}
