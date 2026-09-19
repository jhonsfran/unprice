import { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import type { Env } from "~/env"
import { getEntitlementWindowStub } from "../do-placement"
import type { RunBudgetPricingDelegate } from "./ports"

/** Cloudflare entitlement-window implementation of the injected pricing port. */
export function createRunBudgetPricingDelegate(
  env: Pick<Env, "APP_ENV" | "entitlementwindow">
): RunBudgetPricingDelegate {
  return {
    apply: async (input) => {
      // Same address the ingestion client uses. Do not inline the name or the
      // namespace here: a second derivation is how this entitlement ends up
      // with two Durable Objects (see do-placement.ts).
      const stub = getEntitlementWindowStub(env, {
        customerEntitlementId: input.customerEntitlementId,
        customerId: input.customerId,
        projectId: input.projectId,
      })
      const result = await stub.apply({
        event: input.event,
        idempotencyKey: input.idempotencyKey,
        projectId: input.projectId,
        customerId: input.customerId,
        entitlement: input.entitlement,
        grants: input.grants,
        enforceLimit: input.enforceLimit,
        now: input.now,
        wallet: input.wallet,
      })
      const meterFacts = entitlementMeterFactSchemaV1.array().parse(result.meterFacts ?? [])
      for (const fact of meterFacts) {
        if (fact.customer_entitlement_id.trim().length === 0) {
          throw new Error("Producer meter fact customer_entitlement_id must be non-empty")
        }
        if (fact.customer_entitlement_id !== input.customerEntitlementId) {
          throw new Error(
            `Producer meter fact customer_entitlement_id does not match requested entitlement ${input.customerEntitlementId}; received ${fact.customer_entitlement_id}`
          )
        }
      }
      return { ...result, meterFacts }
    },
  }
}
