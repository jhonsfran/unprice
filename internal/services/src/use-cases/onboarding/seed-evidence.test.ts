import type { Database } from "@unprice/db"
import {
  type Feature,
  type Plan,
  type PlanVersion,
  type PlanVersionFeature,
  rateRowSchema,
} from "@unprice/db/validators"
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
    config: { usageMode: "unit" },
    metadata: null,
    meterConfig: {
      eventId: "event_ai_generation",
      eventSlug: paidAction.eventSlug,
      aggregationMethod: "count",
    },
    feature: makeFeature(),
  } as unknown as PlanVersionFeature & { feature: Feature }
}

/** The plan version's USD card: the paid action at $4.10 per event. */
function paidActionCard() {
  const row = rateRowSchema.parse({
    id: "rr_ai_generation",
    rateCardId: "rc_1",
    featureSlug: paidAction.featureSlug,
    match: {},
    price: { type: "unit", components: [{ property: null, rate: "4.10", per: 1 }] },
    cost: null,
    effectiveFrom: 0,
    effectiveTo: null,
    source: "manual",
    sourceRef: null,
  })
  return new Map([["plan_version_123", [{ currency: "USD", card: {}, rows: [row] }]]])
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

function balance({ consumed, remaining }: { consumed: string; remaining: string }) {
  return {
    remaining,
    held: "0",
    limits: [
      {
        id: "never",
        window: "never" as const,
        enforce: "hard" as const,
        amount: "4.1",
        consumed,
        held: "0",
        remaining,
      },
    ],
  }
}

function allowedCharge({ replayed = false }: { replayed?: boolean } = {}) {
  return {
    result: {
      allowed: true as const,
      degraded: false as const,
      amount: "4.1",
      crossed: [],
      replayed,
      created: false,
      balance: balance({ consumed: "4.1", remaining: "0" }),
    },
  }
}

function deniedCharge({ consumed = "4.1" }: { consumed?: string } = {}) {
  return {
    result: {
      allowed: false as const,
      degraded: false as const,
      blocked: { reason: "limit" as const },
      balance: balance({ consumed, remaining: "0" }),
    },
  }
}

function unavailableCharge() {
  return {
    result: {
      allowed: false as const,
      degraded: true as const,
      blocked: {
        reason: "unavailable" as const,
        remedy: "retry" as const,
        error: { code: "FETCH_ERROR", message: "network down" },
      },
      balance: null,
    },
  }
}

function createSeedOnboardingEvidenceDeps({
  planVersion = makePlanVersion(),
  budgetCharge,
  budgetsUpsert,
}: {
  planVersion?: ReturnType<typeof makePlanVersion>
  budgetCharge?: ApiMock
  budgetsUpsert?: ApiMock
} = {}) {
  const upsert = budgetsUpsert ?? vi.fn(async () => ({ result: { created: true } }))
  const charge =
    budgetCharge ??
    vi.fn().mockResolvedValueOnce(allowedCharge()).mockResolvedValueOnce(deniedCharge())
  const budget = vi.fn((_key: string) => ({ charge }))
  const createApiClient = vi.fn(() => ({ budgets: { upsert }, budget }))
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
        rateCards: {
          pricingForPlanVersions: vi.fn(async () => paidActionCard()),
        },
      } as unknown as Pick<
        ServiceContext,
        "plans" | "apikeys" | "customers" | "subscriptions" | "billing" | "rateCards"
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
      budget,
      budgetCharge: charge,
      budgetsUpsert: upsert,
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
    const proofKey = `onboarding:cus_123:ai-generation:${Date.parse("2026-07-23T12:00:00.000Z")}`
    expect(mocks.budgetsUpsert).toHaveBeenCalledWith({
      key: proofKey,
      unit: "USD",
      limits: [{ amount: "4.10", window: "never" }],
      closesAt: Date.parse("2026-07-23T13:00:00.000Z"),
    })
    expect(mocks.budget).toHaveBeenCalledWith(proofKey)
    expect(mocks.budgetCharge).toHaveBeenNthCalledWith(1, {
      amount: "4.10",
      idempotencyKey: `${proofKey}:decision_1`,
    })
    expect(mocks.budgetCharge).toHaveBeenNthCalledWith(2, {
      amount: "4.10",
      idempotencyKey: `${proofKey}:decision_2`,
    })
    expect(JSON.stringify(result.val)).not.toContain("unprice_dev_secret")
  })

  it("reuses the customer and subscription on a retry, and proves on a fresh budget", async () => {
    const budgetCharge = vi
      .fn()
      .mockResolvedValueOnce(allowedCharge())
      .mockResolvedValueOnce(deniedCharge())
      .mockResolvedValueOnce(allowedCharge())
      .mockResolvedValueOnce(deniedCharge())
    const { customer, deps, mocks } = createSeedOnboardingEvidenceDeps({ budgetCharge })
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
    vi.advanceTimersByTime(1_000)
    const second = await seedOnboardingEvidence(deps, input)

    expect(first.err).toBeUndefined()
    expect(second.err).toBeUndefined()
    expect(mocks.createCustomerRecord).toHaveBeenCalledTimes(1)
    expect(mocks.createSubscriptionRecord).toHaveBeenCalledTimes(1)
    // Each attempt charges its own budget, so a retry never finds an earlier attempt's spend.
    expect(mocks.budget.mock.calls[0]?.[0]).not.toBe(mocks.budget.mock.calls[1]?.[0])
  })

  it("reports a replayed first charge as a duplicate", async () => {
    const budgetCharge = vi
      .fn()
      .mockResolvedValueOnce(allowedCharge({ replayed: true }))
      .mockResolvedValueOnce(deniedCharge())
    const { deps } = createSeedOnboardingEvidenceDeps({ budgetCharge })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val?.decisions[0].reason).toBe("duplicate")
  })

  it("fails the proof when the proof budget cannot be created", async () => {
    const budgetsUpsert = vi.fn(async () => ({
      error: { code: "FORBIDDEN", message: "no budgets" },
    }))
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ budgetsUpsert })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("Paid-action proof failed to start (FORBIDDEN)")
    expect(mocks.budgetCharge).not.toHaveBeenCalled()
  })

  it("fails the proof when the first paid action is denied", async () => {
    const budgetCharge = vi.fn().mockResolvedValueOnce(deniedCharge({ consumed: "0" }))
    const { deps, mocks } = createSeedOnboardingEvidenceDeps({ budgetCharge })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("first paid action was denied: limit")
    expect(mocks.budgetCharge).toHaveBeenCalledTimes(1)
  })

  it("fails the proof when the over-budget action is unexpectedly accepted", async () => {
    const budgetCharge = vi
      .fn()
      .mockResolvedValueOnce(allowedCharge())
      .mockResolvedValueOnce(allowedCharge())
    const { deps } = createSeedOnboardingEvidenceDeps({ budgetCharge })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("over-budget paid action was accepted")
  })

  it("fails the proof when a denial changes the consumed amount", async () => {
    const budgetCharge = vi
      .fn()
      .mockResolvedValueOnce(allowedCharge())
      .mockResolvedValueOnce(deniedCharge({ consumed: "4.11" }))
    const { deps } = createSeedOnboardingEvidenceDeps({ budgetCharge })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("denied request changed the budget's spend")
  })

  it("fails honestly when the second request is refused because Unprice is unavailable", async () => {
    const budgetCharge = vi
      .fn()
      .mockResolvedValueOnce(allowedCharge())
      .mockResolvedValueOnce(unavailableCharge())
    const { deps } = createSeedOnboardingEvidenceDeps({ budgetCharge })

    const result = await seedOnboardingEvidence(deps, input)

    expect(result.val).toBeUndefined()
    expect(result.err?.message).toContain("unexpected reason: unavailable (network down)")
  })
})
