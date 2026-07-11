import { entitlementMeterFactSchemaV1 } from "@unprice/analytics"
import type { Env } from "~/env"
import type { RunBudgetPricingDelegate } from "./ports"

/** Cloudflare entitlement-window implementation of the injected pricing port. */
export function createRunBudgetPricingDelegate(
  env: Pick<Env, "APP_ENV" | "entitlementwindow">
): RunBudgetPricingDelegate {
  return {
    apply: async (input) => {
      const id = env.entitlementwindow.idFromName(
        `${env.APP_ENV}:${input.projectId}:${input.customerId}:${input.customerEntitlementId}`
      )
      const result = await env.entitlementwindow.get(id).apply({
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
