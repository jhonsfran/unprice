import { describe, expect, it } from "vitest"
import {
  applyRunSyncEventInputSchema,
  runBudgetDecisionSchema,
  startRunInputSchema,
} from "./contracts"

describe("run budget contracts", () => {
  it("parses startRun input", () => {
    expect(
      startRunInputSchema.parse({
        projectId: "proj_123",
        customerId: "cus_123",
        runId: "run_123",
        budgetAmount: 100_000_000,
        currency: "USD",
        idempotencyKey: "start-1",
        now: 1_781_503_200_000,
        metadata: {},
      })
    ).toMatchObject({ runId: "run_123", budgetAmount: 100_000_000 })
  })

  it("requires an idempotency key for run sync events", () => {
    const result = applyRunSyncEventInputSchema.safeParse({
      runId: "run_123",
      customerId: "cus_123",
      projectId: "proj_123",
      featureSlug: "tokens",
      event: { id: "evt_123", slug: "tokens_used", timestamp: 1, properties: {} },
      source: {
        workspaceId: "ws_123",
        environment: "development",
        apiKeyId: "api_123",
        sourceType: "api_key",
        sourceId: "api_123",
        sourceName: null,
      },
      now: 1,
    })

    expect(result.success).toBe(false)
  })

  it("allows run budget exceeded as a sync denial reason", () => {
    expect(
      runBudgetDecisionSchema.parse({
        allowed: false,
        state: "rejected",
        rejectionReason: "RUN_BUDGET_EXCEEDED",
        message: "Run budget exceeded",
        budget: {
          runId: "run_123",
          status: "budget_exceeded",
          budgetAmount: 100,
          consumedAmount: 100,
          remainingAmount: 0,
        },
      })
    ).toMatchObject({ rejectionReason: "RUN_BUDGET_EXCEEDED" })
  })

  it("retains enriched grants in run sync input", () => {
    const parsed = applyRunSyncEventInputSchema.parse({
      runId: "run_123",
      customerId: "cus_123",
      projectId: "proj_123",
      featureSlug: "tokens",
      idempotencyKey: "idem_123",
      event: {
        id: "evt_123",
        slug: "tokens_used",
        timestamp: 1_781_503_200_000,
        properties: { amount: 3 },
      },
      source: {
        workspaceId: "ws_123",
        environment: "development",
        apiKeyId: "api_123",
        sourceType: "api_key",
        sourceId: "api_123",
        sourceName: null,
      },
      now: 1_781_503_200_001,
      customerEntitlementId: "ce_123",
      entitlement: {
        billingPeriods: [],
        creditLinePolicy: "capped",
        customerEntitlementId: "ce_123",
        customerId: "cus_123",
        effectiveAt: 1_781_503_200_000,
        expiresAt: null,
        featureConfig: {
          usageMode: "unit",
          price: {
            dinero: {
              amount: 0,
              currency: { code: "USD", base: 10, exponent: 2 },
              scale: 2,
            },
            displayAmount: "0.00",
          },
        },
        featurePlanVersionId: "fpv_123",
        featureSlug: "tokens",
        featureType: "usage",
        meterConfig: {
          eventId: "evt_usage",
          eventSlug: "tokens_used",
          aggregationMethod: "sum",
          aggregationField: "amount",
        },
        overageStrategy: "none",
        projectId: "proj_123",
        resetConfig: null,
        subscriptionItemId: null,
      },
      grants: [
        {
          allowanceUnits: 100,
          cadenceEffectiveAt: 1_781_503_200_000,
          cadenceExpiresAt: null,
          currencyCode: "USD",
          effectiveAt: 1_781_503_200_000,
          expiresAt: null,
          grantId: "grant_123",
          priority: 10,
          resetConfig: null,
        },
      ],
    })

    expect(parsed.grants[0]).toMatchObject({
      cadenceEffectiveAt: 1_781_503_200_000,
      currencyCode: "USD",
      resetConfig: null,
    })
  })
})
