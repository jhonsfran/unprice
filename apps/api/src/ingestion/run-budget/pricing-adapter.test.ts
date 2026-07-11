import { describe, expect, it, vi } from "vitest"
import type { Env } from "~/env"
import { createRunBudgetPricingDelegate } from "./pricing-adapter"
import { createRunBudgetMeterFact } from "./testing/harness"
import { createRunBudgetApplyInput } from "./testing/processor-contract"

function createPricingHarness(meterFacts: unknown[]) {
  const apply = vi.fn(async () => ({ allowed: true, meterFacts }))
  const idFromName = vi.fn(() => "entitlement-id")
  const env = {
    APP_ENV: "test",
    entitlementwindow: {
      idFromName,
      get: vi.fn(() => ({ apply })),
    },
  } as unknown as Pick<Env, "APP_ENV" | "entitlementwindow">
  return { apply, delegate: createRunBudgetPricingDelegate(env), idFromName }
}

function pricingInput() {
  const input = createRunBudgetApplyInput()
  return {
    event: { ...input.event, source: input.source },
    idempotencyKey: `${input.idempotencyKey}:ew`,
    projectId: input.projectId,
    customerId: input.customerId,
    customerEntitlementId: input.customerEntitlementId,
    entitlement: input.entitlement,
    grants: input.grants,
    enforceLimit: true as const,
    now: input.now,
    wallet: { mode: "external_reservation" as const, remainingAmount: 10_000 },
  }
}

describe("RunBudget pricing adapter", () => {
  it("addresses the entitlement window and forwards external-reservation pricing", async () => {
    const harness = createPricingHarness([createRunBudgetMeterFact()])
    await expect(harness.delegate.apply(pricingInput())).resolves.toMatchObject({ allowed: true })
    expect(harness.idFromName).toHaveBeenCalledWith("test:proj_1:cus_1:ce_test_1")
    expect(harness.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "idem_consume_1:ew",
        wallet: { mode: "external_reservation", remainingAmount: 10_000 },
      })
    )
  })

  it.each([
    ["empty", createRunBudgetMeterFact({ customer_entitlement_id: "" }), "must be non-empty"],
    [
      "mismatched",
      createRunBudgetMeterFact({ customer_entitlement_id: "ce_other" }),
      "does not match requested entitlement ce_test_1",
    ],
  ])("rejects %s producer entitlement identity", async (_label, fact, message) => {
    const harness = createPricingHarness([fact])
    await expect(harness.delegate.apply(pricingInput())).rejects.toThrow(message)
  })
})
