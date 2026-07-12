import type { Database } from "@unprice/db"
import type { Feature, Plan, PlanVersion, PlanVersionFeature } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceContext } from "../../context"
import { seedOnboardingEvidence } from "./seed-evidence"

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

function makeFeature(slug: string): Feature {
  return {
    id: `feature_${slug}`,
    slug,
    title: slug,
    projectId: "proj_123",
    unitOfMeasure: "unit",
    description: "",
    meterConfig: null,
  } as unknown as Feature
}

function makeUsagePlanFeature({
  slug,
  aggregationField,
}: {
  slug: string
  aggregationField?: string
}): PlanVersionFeature & { feature: Feature } {
  return {
    id: `plan_feature_${slug}`,
    projectId: "proj_123",
    planVersionId: "plan_version_123",
    featureId: `feature_${slug}`,
    featureType: "usage",
    metadata: null,
    meterConfig: {
      eventId: "event_workflow_runs",
      eventSlug: "workflow_runs",
      aggregationMethod: aggregationField ? "sum" : "count",
      ...(aggregationField ? { aggregationField } : {}),
    },
    feature: makeFeature(slug),
  } as unknown as PlanVersionFeature & { feature: Feature }
}

function makeFlatPlanFeature(slug: string): PlanVersionFeature & { feature: Feature } {
  return {
    id: `plan_feature_${slug}`,
    projectId: "proj_123",
    planVersionId: "plan_version_123",
    featureId: `feature_${slug}`,
    featureType: "flat",
    metadata: null,
    meterConfig: null,
    feature: makeFeature(slug),
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
    planFeatures: [
      makeFlatPlanFeature("run-history"),
      makeUsagePlanFeature({ slug: "runs" }),
      makeUsagePlanFeature({ slug: "credits", aggregationField: "credits" }),
    ],
  } as unknown as PlanVersion & {
    plan: Plan
    planFeatures: Array<PlanVersionFeature & { feature: Feature }>
  }
}

type ApiMock = ReturnType<typeof vi.fn>

function createSeedOnboardingEvidenceDeps({
  accessCheck,
  logger = createLogger(),
  planVersion = makePlanVersion(),
  runsConsume,
  runsEnd,
  runsStart,
}: {
  accessCheck?: ApiMock
  logger?: Logger
  planVersion?: ReturnType<typeof makePlanVersion>
  runsConsume?: ApiMock
  runsEnd?: ApiMock
  runsStart?: ApiMock
} = {}) {
  const start =
    runsStart ??
    vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "running" as const,
        customerId: "cus_123",
        budgetAmountMinor: 5000,
        consumedAmountMinor: 0,
        remainingAmountMinor: 5000,
        currency: "USD",
        workloadType: "workflow" as const,
        workloadId: "onboarding-workflow",
        traceId: "onboarding_cus_123",
        parentRunId: null,
      },
    }))
  const consume =
    runsConsume ??
    vi.fn(async () => ({
      result: {
        accepted: true,
        reason: "accepted" as const,
        run: {
          runId: "run_123",
          status: "running" as const,
          customerId: "cus_123",
          budgetAmountMinor: 5000,
          consumedAmountMinor: 10,
          remainingAmountMinor: 4990,
          currency: "USD",
          workloadType: "workflow" as const,
          workloadId: "onboarding-workflow",
          traceId: "onboarding_cus_123",
          parentRunId: null,
        },
      },
    }))
  const end =
    runsEnd ??
    vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "completed" as const,
        customerId: "cus_123",
        budgetAmountMinor: 5000,
        consumedAmountMinor: 10,
        remainingAmountMinor: 4990,
        currency: "USD",
        workloadType: "workflow" as const,
        workloadId: "onboarding-workflow",
        traceId: "onboarding_cus_123",
        parentRunId: null,
      },
    }))
  const check =
    accessCheck ??
    vi.fn(async () => ({
      result: { allowed: true, featureSlug: "run-history" },
    }))
  const createApiClient = vi.fn(() => ({
    runs: {
      start,
      consume,
      end,
    },
    access: {
      check,
    },
  }))
  const createCustomerRecord = vi.fn(async () =>
    Ok({
      id: "cus_123",
      name: "Onboarding Customer",
      email: "onboarding+1783166400000@example.com",
    })
  )
  const createApiKey = vi.fn(async () =>
    Ok({
      id: "apikey_123",
      key: "unprice_dev_123",
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
  const activateWallet = vi.fn(async () => Ok(undefined))

  return {
    deps: {
      services: {
        plans: {
          getPlanVersionByIdDetailed: vi.fn(async () => Ok(planVersion)),
        },
        customers: {
          createCustomerRecord,
        },
        apikeys: {
          createApiKey,
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
      logger,
      createApiClient,
    },
    mocks: {
      accessCheck: check,
      createApiClient,
      createApiKey,
      createCustomerRecord,
      createPhase,
      createSubscriptionRecord,
      generateBillingPeriods,
      activateWallet,
      runsConsume: consume,
      runsEnd: end,
      runsStart: start,
    },
  }
}

describe("seedOnboardingEvidence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("creates onboarding evidence through services and the generated SDK resources", async () => {
    const planVersion = makePlanVersion()
    const runsStart = vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "running" as const,
        customerId: "cus_123",
        budgetAmountMinor: 5000,
        consumedAmountMinor: 0,
        remainingAmountMinor: 5000,
        currency: "USD",
        workloadType: "workflow" as const,
        workloadId: "onboarding-workflow",
        traceId: "onboarding_cus_123",
        parentRunId: null,
      },
    }))
    const runsConsume = vi.fn(async () => ({
      result: {
        accepted: true,
        reason: "accepted" as const,
        run: {
          runId: "run_123",
          status: "running" as const,
          customerId: "cus_123",
          budgetAmountMinor: 5000,
          consumedAmountMinor: 10,
          remainingAmountMinor: 4990,
          currency: "USD",
          workloadType: "workflow" as const,
          workloadId: "onboarding-workflow",
          traceId: "onboarding_cus_123",
          parentRunId: null,
        },
      },
    }))
    const runsEnd = vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "completed" as const,
        customerId: "cus_123",
        budgetAmountMinor: 5000,
        consumedAmountMinor: 10,
        remainingAmountMinor: 4990,
        currency: "USD",
        workloadType: "workflow" as const,
        workloadId: "onboarding-workflow",
        traceId: "onboarding_cus_123",
        parentRunId: null,
      },
    }))
    const accessCheck = vi.fn(async () => ({
      result: { allowed: true, featureSlug: "run-history" },
    }))
    const createApiClient = vi.fn(() => ({
      runs: {
        start: runsStart,
        consume: runsConsume,
        end: runsEnd,
      },
      access: {
        check: accessCheck,
      },
    }))
    const createCustomerRecord = vi.fn(async () =>
      Ok({
        id: "cus_123",
        name: "Onboarding Customer",
        email: "onboarding+1783166400000@example.com",
      })
    )
    const createApiKey = vi.fn(async () =>
      Ok({
        id: "apikey_123",
        key: "unprice_dev_123",
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
    const activateWallet = vi.fn(async () => Ok(undefined))

    const result = await seedOnboardingEvidence(
      {
        services: {
          plans: {
            getPlanVersionByIdDetailed: vi.fn(async () => Ok(planVersion)),
          },
          customers: {
            createCustomerRecord,
          },
          apikeys: {
            createApiKey,
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
        createApiClient,
      },
      {
        projectId: "proj_123",
        planVersionId: "plan_version_123",
        projectTimezone: "UTC",
        projectDefaultCurrency: "USD",
        workspaceIsMain: false,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      customer: {
        id: "cus_123",
      },
      subscription: {
        id: "sub_123",
      },
      usage: {
        state: "done",
        eventsRecorded: 6,
        targetCount: 2,
      },
      verification: {
        state: "done",
        allowed: true,
        featureSlug: "run-history",
      },
    })
    expect(createApiClient).toHaveBeenCalledWith("unprice_dev_123")
    expect(createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultCustomerId: "cus_123",
        isRoot: false,
        expiresAt: Date.UTC(2026, 6, 4, 23, 59, 59, 999),
      })
    )
    expect(createSubscriptionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_123",
      })
    )
    expect(runsStart).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        budgetAmountMinor: 5000,
        workloadType: "workflow",
        workloadId: "onboarding-workflow",
      })
    )
    expect(runsConsume).toHaveBeenCalledTimes(6)
    expect(runsConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_123",
        featureSlug: "runs",
        eventSlug: "workflow_runs",
        properties: {},
      })
    )
    expect(runsConsume).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run_123",
        featureSlug: "credits",
        properties: {
          credits: 2,
        },
      })
    )
    expect(runsEnd).toHaveBeenCalledWith({
      runId: "run_123",
      status: "completed",
    })
    expect(accessCheck).toHaveBeenCalledWith({
      customerId: "cus_123",
      featureSlug: "run-history",
    })
    expect(generateBillingPeriods).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub_123",
      })
    )
    expect(activateWallet).toHaveBeenCalled()
  })

  it("closes a started budgeted run when usage consumption errors", async () => {
    const runsConsume = vi.fn(async () => ({
      error: {
        message: "usage service unavailable",
        code: "usage_unavailable",
      },
    }))
    const runsEnd = vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "failed" as const,
      },
    }))
    const {
      deps,
      mocks: { accessCheck },
    } = createSeedOnboardingEvidenceDeps({
      runsConsume,
      runsEnd,
    })

    const result = await seedOnboardingEvidence(deps, {
      projectId: "proj_123",
      planVersionId: "plan_version_123",
      projectTimezone: "UTC",
      projectDefaultCurrency: "USD",
      workspaceIsMain: false,
    })

    expect(result.err).toBeDefined()
    expect(runsEnd).toHaveBeenCalledWith({
      runId: "run_123",
      status: "failed",
    })
    expect(accessCheck).not.toHaveBeenCalled()
  })

  it("closes a started budgeted run when usage consumption is denied", async () => {
    const runsConsume = vi.fn(async () => ({
      result: {
        accepted: false,
        reason: "insufficient_funds" as const,
        run: {
          runId: "run_123",
          status: "running" as const,
        },
      },
    }))
    const runsEnd = vi.fn(async () => ({
      result: {
        runId: "run_123",
        status: "failed" as const,
      },
    }))
    const {
      deps,
      mocks: { accessCheck },
    } = createSeedOnboardingEvidenceDeps({
      runsConsume,
      runsEnd,
    })

    const result = await seedOnboardingEvidence(deps, {
      projectId: "proj_123",
      planVersionId: "plan_version_123",
      projectTimezone: "UTC",
      projectDefaultCurrency: "USD",
      workspaceIsMain: false,
    })

    expect(result.err).toBeDefined()
    expect(runsEnd).toHaveBeenCalledWith({
      runId: "run_123",
      status: "failed",
    })
    expect(accessCheck).not.toHaveBeenCalled()
  })
})
