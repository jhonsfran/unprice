import type { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import type { WalletService } from "@unprice/services/wallet"
import type { z } from "zod"
import type { ApplyInput, ApplyResult } from "../entitlements/contracts"

/**
 * The Cloudflare factory for these operations is request/operation-scoped and
 * MUST NOT retain the WebSocket-backed WalletService across Worker or Durable
 * Object requests. A future backend may choose its own safe factory lifetime.
 */
export type RunBudgetWalletOps = Pick<
  WalletService,
  "captureReservationUsage" | "createReservation" | "releaseReservation"
>

export type RunBudgetPricingInput = Pick<
  ApplyInput,
  "customerId" | "entitlement" | "event" | "grants" | "idempotencyKey" | "now" | "projectId"
> & {
  customerEntitlementId: string
  enforceLimit: true
  wallet: Extract<NonNullable<ApplyInput["wallet"]>, { mode: "external_reservation" }>
}

export type RunBudgetMeterFact = z.infer<typeof entitlementMeterFactSchemaV1>

export type RunBudgetPricingResult = Omit<ApplyResult, "meterFacts"> & {
  meterFacts: RunBudgetMeterFact[]
}

/**
 * Prices through external-reservation mode: the delegate preserves the
 * idempotency key and never creates an entitlement wallet reservation.
 */
export type RunBudgetPricingDelegate = {
  apply(input: RunBudgetPricingInput): Promise<RunBudgetPricingResult>
}
