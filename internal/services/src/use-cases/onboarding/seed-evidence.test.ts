import type { Database } from "@unprice/db"
import type { Feature, Plan, PlanVersion, PlanVersionFeature } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { seedOnboardingEvidence } from "./seed-evidence"

const paidAction = {
  title: "AI generation",
  featureSlug: "ai-generation",
  eventSlug: "ai_generation",
  unitOfMeasure: "action" as const,
  unitPrice: "4.10",
}

const input = {
  planVersionId: "plan_version_123",
  projectId: "proj_123",
  projectTimezone: "UTC",
  projectDefaultCurrency: "USD" as const,
  workspaceIsMain: false,
  paidAction,
}

function createLogger(): Logger {
  return {
    set: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
  } as unknown as Logger
}

function createDbMock() {
  const tx = {} as Database

  return {
    query: {
      versions: {
        findFirst: vi.fn().mockResolvedValue({
          paymentProvider: "sandbox",
        }),
      },
      paymentProviderConfig: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ppc_123",
          projectId: "proj_123",
          paymentProvider: "sandbox",
          active: true,
          connectionType: "managed_connection",
          mode: "test",
          status: "active",
        }),
      },
    },
    transaction: vi.fn(async (callback: (tx: Database) => Promise<unknown>) => callback(tx)),
  } as unknown as Database
}

function makeFeature(): Feature {
  return {
    id: "feature_ai_generation",
    slug: paidAction.featureSlug,
    title: paidAction.title,
    projectId: "proj_123",
    unitOfMeasure: "action",
    description: "",
    meterConfig: null,
  } as unknown as Feature
}

function makePaidActionPlanFeature(): PlanVersionFeature & { feature: Feature } {
  return {
    id: "plan_feature_ai_generation",
    projectId: "proj_123",
    planVersionId: "plan_version_123",
    featureId: "feature_ai_generation",
    featureType: "usage",
    config: {
      usageMode: "unit",
      price: {
        displayAmount: "4.10",
        dinero: {
          amount: 410,
          currency: { code: "USD", base: 10, exponent: 2 },
          scale: 2,
        },
      },
    },
    metadata: null,
    meterConfig: {
      eventId: "event_ai_generation",
      eventSlug: paidAction.eventSlug,
      aggregationMethod: "count",
    },
    feature: makeFeature(),
  } as unknown as PlanVersionFeature & { feature: Feature }
}

function makePlanVersion(): PlanVersion & {
  plan: Plan
  planFeatures: Array<PlanVersionFeature & { feature: Feature }>
} {
  return {
    id: "plan_version_123",
    projectId: "proj_123",
    planId: "plan_123",
    trialUnits: 0,
    currency: "USD",
    plan: {
      id: "plan_123",
      projectId: "proj_123",
      title: "Starter",
      slug: "starter",
    } as unknown as Plan,
    planFeatures: [makePaidActionPlanFeature()],
  } as unknown as PlanVersion & {
    plan: Plan
    planFeatures: Array<PlanVersionFeature & { feature: Feature }>
  }
}

type ApiMock = ReturnType<typeof vi.fn>

function runSummary({
  consumedAmountMinor,
  remainingAmountMinor,
  status = "running",
}: {
  consumedAmountMinor: number
  remainingAmountMinor: number
  status?: "running" | "completed"
}) {
  return {
    runId: "run_123",
    status,
    customerId: "cus_123",
    budgetAmountMinor: 410,
    consumedAmountMinor,
    remainingAmountMinor,
    currency: "USD",
    workloadType: "workflow" as const,
    workloadId: "onboarding-paid-action",
    traceId: "onboarding_cus_123",
    parentRunId: null,
  }
}

function acceptedDecision() {
  return {
    result: {
      accepted: true,
      reason: "accepted" as const,
      run: runSummary({ consumedAmountMinor: 410, remainingAmountMinor: 0 }),
    },
  }
}

function deniedDecision({
  consumedAmountMinor = 410,
  reason = "insufficient_budget",
}: {
  consumedAmountMinor?: number
  reason?: "insufficient_budget" | "expired" | "not_running" | "entitlement_denied"
} = {}) {
  return {
    result: {
      accepted: false,
      reason,
      run: runSummary({
        consumedAmountMinor,
        remainingAmountMinor: Math.max(0, 410 - consumedAmountMinor),
      }),
    },
  }
}

function createSeedOnboardingEvidenceDeps({
  planVersion = makePlanVersion(),
  runsConsume,
  runsEnd,
  runsStart,
}: {
  planVersion?: ReturnType<typeof makePlanVersion>
  runsConsume?: ApiMock
  runsEnd?: ApiMock
  runsStart?: ApiMock
} = {}) {
  const start =
    runsStart ??
    vi.fn(async () => ({
      result: runSummary({ consumedAmountMinor: 0, remainingAmountMinor: 410 }),
    }))
  const consume =
    runsConsume ??
    vi.fn().mockResolvedValueOnce(acceptedDecision()).mockResolvedValueOnce(deniedDecision())
  const end =
    runsEnd ??
    vi.fn(async () => ({
      result: runSummary({
        consumedAmountMinor: 410,
        remainingAmountMinor: 0,
        status: "completed",
      }),
    }))
  const createApiClient = vi.fn(() => ({
    runs: {
      start,
      consume,
      end,
    },
  }))
  const customer = {
    id: "cus_123",
    name: "Onboarding Customer",
    email: "onboarding+plan_version_123@example.com",
    active: true,
  }
  const createCustomerRecord = vi.fn(async () => Ok(customer))
  const getCustomerByExternalId: ApiMock = vi.fn(async () => Ok(null))
  const createOrRollApiKey = vi.fn(async () =>
    Ok({
      id: "apikey_123",
      key: "unprice_dev_secret",
      state: "created" as const,
      updatedAtM: Date.now(),
    })
  )
  const createSubscriptionRecord = vi.fn(async () =>
    Ok({
      id: "sub_123",
      customerId: "cus_123",
      status: "active",
    })
  )
  const createPhase = vi.fn(async () => Ok({ id: "phase_123" }))
  const generateBillingPeriods = vi.fn(async () => Ok({ cyclesCreated: 1, phasesProcessed: 1 }))
  const getSubscriptionData = vi.fn(async () => ({ status: "active" }))
  const getActiveSubscription: ApiMock = vi.fn(async () => ({
    err: { code: "SUBSCRIPTION_NOT_FOUND", message: "subscription not found" },
  }))
  const activateWallet = vi.fn(async () => Ok(undefined))

  return {
    deps: {
      services: {
        plans: {
          getPlanVersionByIdDetailed: vi.fn(async () => Ok(planVersion)),
        },
        customers: {
          createCustomerRecord,
          getCustomerByExternalId,
          getActiveSubscription,
        },
        apikeys: {
          createOrRollApiKey,
        },
        subscriptions: {
          createSubscription: createSubscriptionRecord,
          createPhase,
          getSubscriptionData,
          activateWallet,
        },
        billing: {
          generateBillingPeriods,
        },
      } as unknown as Pick<
        ServiceContext,
        "plans" | "apikeys" | "customers" | "subscriptions" | "billing"
      >,
      db: createDbMock(),
      logger: createLogger(),
      createApiClient: createApiClient as never,
    },
    mocks: {
      createApiClient,
      createOrRollApiKey,
      createCustomerRecord,
      createPhase,
      createSubscriptionRecord,
      getCustomerByExternalId,
      getActiveSubscription,
      runsConsume: consume,
      runsEnd: end,
      runsStart: start,
    },
    customer,
  }
}

describe("seedOnboardingEvidence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns a real allowed decision followed by an unchanged insufficient-budget denial", async () => {
    const { deps, mocks } = createSeedOnboardingEvidenceDeps()

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      state: "ok",
      apiKey: { id: "apikey_123" },
      customer: {
        id: "cus_123",
        name: "Onboarding Customer",
        email: "onboarding+plan_version_123@example.com",
      },
      subscription: { id: "sub_123" },
      action: {
        title: "AI generation",
        featureSlug: "ai-generation",
        eventSlug: "ai_generation",
        unitPriceMinor: 410,
        currency: "USD",
      },
      decisions: [
        {
          sequence: 1,
          accepted: true,
          reason: "accepted",
          consumedAmountMinor: 410,
          remainingAmountMinor: 0,
        },
        {
          sequence: 2,
          accepted: false,
          reason: "insufficient_budget",
          consumedAmountMinor: 410,
          remainingAmountMinor: 0,
        },
      ],
    })
    expect(mocks.runsStart).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetAmountMinor: 410,
        idempotencyKey: "onboarding_cus_123_ai-generation_proof",
      })
    )
    expect(mocks.runsConsume).toHaveBeenNthCalledWith(1, {
      runId: "run_123",
      featureSlug: "ai-generation",
      eventSlug: "ai_generation",
      idempotencyKey: "onboarding_run_123_ai-generation_decision_1",
      properties: {},
    })
    expect(mocks.runsConsume).toHaveBeenNthCalledWith(2, {
      runId: "run_123",
      featureSlug: "ai-generation",
      eventSlug: "ai_generation",
      idempotencyKey: "onboarding_run_123_ai-generation_decision_2",
      properties: {},
    })
    expect(JSON.stringify(result.val)).not.toContain("unprice_dev_secret")
  })

  it("reuses resources and cached decision identities after a completed-run retry", async () => {
    const runsStart = vi
      .fn()
      .mockResolvedValueOnce({
        result: runSummary({ consumedAmountMinor: 0, remainingAmountMinor: 410 }),
      })
      .mockResolvedValueOnce({
        result: runSummary({
          consumedAmountMinor: 410,
          remainingAmountMinor: 0,
          status: "completed",
        }),
      })
    const runsConsume = vi
      .fn()
      .mockResolvedValueOnce(acceptedDecision())
      .mockResolvedValueOnce(deniedDecision())
      .mockResolvedValueOnce(acceptedDecision())
      .mockResolvedValueOnce(deniedDecision())
    const { customer, deps, mocks } = createSeedOnboardingEvidenceDeps({
      runsConsume,
      runsStart,
    })
    mocks.getCustomerByExternalId.mockResolvedValueOnce(Ok(null)).mockResolvedValue(Ok(customer))
    mocks.getActiveSubscription
      .mockResolvedValueOnce({
        err: { code: "SUBSCRIPTION_NOT_FOUND", message: "subscription not found" },
      })
      .mockResolvedValue({
        val: {
          id: "sub_123",
          activePhase: {
            planVersion: { id: "plan_version_123" },
          },
        },
      })

    const first = await seedOnboardingEvidence(deps, input)
    const second = await seedOnboardingEvidence(deps, input)

    expect(first.err).toBeUndefined()
    expect(second.err).toBeUndefined()
    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1)
    expect(mocks.createSubscriptionRecord).toHaveBeenCalledTimes(1)
    expect(mocks.runsEnd).toHaveBeenCalledTimes(1)
    expect(mocks.runsConsume.mock.calls[0]?.[0].idempotencyKey).toBe(
      mocks.runsConsume.mock.calls[2]?.[0].idempotencyKey
    )
    expect(mocks.runsConsume.mock.calls[1]?.[0].idempotencyKey).toBe(
      mocks.runsConsume.mock.calls[3]?.[0].idempotencyKey
    )
  })

  it("fails the proof and closes the run when the first paid action is denied", async () => {
    const runsConsume = vi.fn().mockResolvedValueOnce(deniedDecision())
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ runsConsume })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("first paid action was denied")
    expect(mocks.runsEnd).toHaveBeenCalledWith({ runId: "run_123", status: "failed" })
  })

  it("fails the proof when the over-budget action is unexpectedly accepted", async () => {
    const runsConsume = vi
      .fn()
      .mockResolvedValueOnce(acceptedDecision())
      .mockResolvedValueOnce(acceptedDecision())
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ runsConsume })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("over-budget paid action was accepted")
    expect(mocks.runsEnd).toHaveBeenCalledWith({ runId: "run_123", status: "failed" })
  })

  it("fails the proof when a denial changes the consumed amount", async () => {
    const runsConsume = vi
      .fn()
      .mockResolvedValueOnce(acceptedDecision())
      .mockResolvedValueOnce(deniedDecision({ consumedAmountMinor: 411 }))
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ runsConsume })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("denied request changed the run spend")
    expect(mocks.runsEnd).toHaveBeenCalledWith({ runId: "run_123", status: "failed" })
  })

  it("fails honestly when the second request is rejected for another reason", async () => {
    const runsConsume = vi
      .fn()
      .mockResolvedValueOnce(acceptedDecision())
      .mockResolvedValueOnce(deniedDecision({ reason: "entitlement_denied" }))
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ runsConsume })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("unexpected reason: entitlement_denied")
    expect(mocks.runsEnd).toHaveBeenCalledWith({ runId: "run_123", status: "failed" })
  })
})
