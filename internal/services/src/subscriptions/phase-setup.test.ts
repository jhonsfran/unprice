import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import type { CustomerService } from "../customers/service"
import { UnPriceSubscriptionError } from "./errors"
import { resolvePhaseSetup } from "./phase-setup"

function createLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createDeps(planVersion: Record<string, unknown>) {
  return {
    db: {
      query: {
        versions: {
          findFirst: vi.fn().mockResolvedValue(planVersion),
        },
      },
    } as unknown as Database,
    customerService: {
      validatePaymentMethod: vi.fn(),
    } as unknown as Pick<CustomerService, "validatePaymentMethod">,
    logger: createLogger(),
  }
}

function createPlanVersion(overrides: { metadata?: Record<string, unknown> | null } = {}) {
  return {
    id: "version_123",
    projectId: "proj_123",
    planId: "plan_123",
    status: "published",
    active: true,
    currency: "USD",
    paymentProvider: "sandbox",
    paymentMethodRequired: false,
    trialUnits: 0,
    metadata: overrides.metadata ?? null,
    billingConfig: {
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: 1,
      planType: "recurring",
      name: "monthly",
    },
    planFeatures: [{ id: "fpv_1", feature: { id: "feat_1", slug: "api-calls" } }],
    project: {
      id: "proj_123",
      defaultCurrency: "USD",
      timezone: "UTC",
    },
    plan: {
      id: "plan_123",
      slug: "pro",
    },
  }
}

const baseInput = {
  planVersionId: "version_123",
  projectId: "proj_123",
  customerId: "cus_123",
  startAt: Date.parse("2026-01-01T00:00:00.000Z"),
  config: [],
}

describe("resolvePhaseSetup credit line policy", () => {
  it("defaults to uncapped when the plan has no included credits", async () => {
    const result = await resolvePhaseSetup(createDeps(createPlanVersion()), baseInput)

    expect(result.err).toBeUndefined()
    expect(result.val?.creditLinePolicyToUse).toBe("uncapped")
  })

  it("defaults to capped when the plan includes credits", async () => {
    const result = await resolvePhaseSetup(
      createDeps(createPlanVersion({ metadata: { includedCreditAmount: 2_000_000_000 } })),
      baseInput
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.creditLinePolicyToUse).toBe("capped")
  })

  it("keeps an explicit capped policy on a plan with included credits", async () => {
    const result = await resolvePhaseSetup(
      createDeps(createPlanVersion({ metadata: { includedCreditAmount: 2_000_000_000 } })),
      { ...baseInput, creditLinePolicy: "capped" as const, creditLineAmount: 5_000_000_000 }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.creditLinePolicyToUse).toBe("capped")
    expect(result.val?.creditLineAmountToUse).toBe(5_000_000_000)
  })

  it("rejects an explicit uncapped policy on a plan with included credits", async () => {
    const result = await resolvePhaseSetup(
      createDeps(createPlanVersion({ metadata: { includedCreditAmount: 2_000_000_000 } })),
      { ...baseInput, creditLinePolicy: "uncapped" as const }
    )

    expect(result.err).toBeInstanceOf(UnPriceSubscriptionError)
    expect((result.err as UnPriceSubscriptionError).code).toBe("CREDIT_POLICY_CONFLICT")
  })
})
