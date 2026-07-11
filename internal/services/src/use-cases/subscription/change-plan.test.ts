import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { SubscriptionFullData } from "../../subscriptions/repository"
import { SubscriptionChangePhasePlanError, changeSubscriptionPhasePlan } from "./change-plan"

const projectId = "proj_123"
const subscriptionId = "sub_123"
const customerId = "cus_123"
const now = 1_000
const currentCycleEndAt = 2_000

function createSubscription(overrides?: {
  phases?: SubscriptionFullData["phases"]
}): SubscriptionFullData {
  return {
    id: subscriptionId,
    projectId,
    customerId,
    active: true,
    status: "active",
    planSlug: "pro",
    timezone: "UTC",
    metadata: null,
    currentCycleStartAt: 500,
    currentCycleEndAt,
    renewAt: 500,
    endAt: null,
    createdAtM: 0,
    updatedAtM: 0,
    phases: overrides?.phases ?? [createPhaseFixture()],
  }
}

function createPhaseFixture(
  overrides?: Partial<SubscriptionFullData["phases"][number]>
): SubscriptionFullData["phases"][number] {
  return {
    id: "phase_current",
    projectId,
    subscriptionId,
    planVersionId: "pv_current",
    paymentProvider: "sandbox",
    paymentMethodId: null,
    creditLinePolicy: "uncapped",
    creditLineAmount: null,
    trialUnits: 0,
    trialEndsAt: null,
    billingAnchor: 1,
    startAt: 500,
    endAt: null,
    metadata: null,
    items: [],
    planVersion: {
      plan: {},
    },
    ...overrides,
  }
}

function createDeps(overrides?: {
  subscription?: SubscriptionFullData
}) {
  const tx = { tx: true }
  const getSubscriptionById = vi
    .fn()
    .mockResolvedValue(Ok(overrides?.subscription ?? createSubscription()))
  const getPlanVersionByIdRecord = vi.fn().mockResolvedValue(
    Ok({
      id: "pv_target",
      projectId,
      active: true,
      status: "published",
      archived: false,
      paymentProvider: "sandbox",
      paymentMethodRequired: false,
    })
  )
  const updatePhase = vi.fn().mockResolvedValue(Ok({ id: "phase_current" }))
  const createPhase = vi.fn().mockResolvedValue(Ok({ id: "phase_new" }))
  const generateBillingPeriods = vi.fn().mockResolvedValue(Ok({ cyclesCreated: 1 }))

  return {
    deps: {
      db: {
        query: {
          paymentProviderConfig: {
            findFirst: vi.fn().mockResolvedValue({
              id: "ppc_123",
              projectId,
              paymentProvider: "sandbox",
              active: true,
            }),
          },
        },
        transaction: vi.fn(async (fn: (txArg: typeof tx) => Promise<unknown> | unknown) => fn(tx)),
      },
      logger: {
        set: vi.fn(),
        error: vi.fn(),
      },
      now: () => now,
      services: {
        billing: {
          generateBillingPeriods,
        },
        plans: {
          getPlanVersionByIdRecord,
        },
        subscriptions: {
          getSubscriptionById,
          updatePhase,
          createPhase,
        },
      },
    },
    tx,
    getPlanVersionByIdRecord,
    updatePhase,
    createPhase,
    generateBillingPeriods,
  }
}

function createInput(whenToChange: "immediately" | "end_of_cycle" = "end_of_cycle") {
  return {
    id: subscriptionId,
    projectId,
    planVersionId: "pv_target",
    currentPlanVersionId: "pv_current",
    currentCycleEndAt,
    timezone: "UTC",
    whenToChange,
    paymentMethodRequired: true,
    paymentMethodId: "pm_123",
    creditLinePolicy: "capped" as const,
    creditLineAmount: 1_500,
    trialUnits: 7,
  }
}

describe("changeSubscriptionPhasePlan", () => {
  it("closes the active phase and schedules the target phase at the end of the cycle", async () => {
    const { deps, tx, updatePhase, createPhase, generateBillingPeriods } = createDeps()

    const result = await changeSubscriptionPhasePlan(deps as never, createInput("end_of_cycle"))

    if (result.err) {
      throw result.err
    }

    expect(updatePhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        id: "phase_current",
        endAt: currentCycleEndAt - 1,
      }),
      subscriptionId,
      projectId,
      db: tx,
      now,
    })
    expect(createPhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        subscriptionId,
        customerId,
        planVersionId: "pv_target",
        startAt: currentCycleEndAt,
        paymentMethodRequired: true,
        paymentMethodId: "pm_123",
        creditLinePolicy: "capped",
        creditLineAmount: 1_500,
        trialUnits: 7,
      }),
      projectId,
      db: tx,
      now,
    })
    expect(generateBillingPeriods).toHaveBeenCalledWith({
      projectId,
      subscriptionId,
      now,
      db: tx,
    })
  })

  it("falls back to an immediate boundary when the cycle end is stale", async () => {
    const staleCycleEnd = now - 100
    const subscription = createSubscription()
    subscription.currentCycleEndAt = staleCycleEnd
    const { deps, tx, updatePhase, createPhase } = createDeps({ subscription })

    const result = await changeSubscriptionPhasePlan(
      { ...deps, now: () => now } as never,
      createInput("end_of_cycle")
    )

    if (result.err) {
      throw result.err
    }

    expect(updatePhase).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ endAt: now }),
        db: tx,
      })
    )
    expect(createPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ startAt: now + 1 }),
        db: tx,
      })
    )
  })

  it("rejects the target plan version when its currency does not match expectedCurrency", async () => {
    const { deps, createPhase } = createDeps()

    const result = await changeSubscriptionPhasePlan(
      deps as never,
      { ...createInput("end_of_cycle"), expectedCurrency: "EUR" },
      {
        targetPlanVersion: {
          id: "pv_target",
          projectId,
          active: true,
          status: "published",
          archived: false,
          currency: "USD",
          paymentProvider: "sandbox",
          paymentMethodRequired: false,
        } as never,
      }
    )

    expect(result.err).toBeInstanceOf(SubscriptionChangePhasePlanError)
    if (!(result.err instanceof SubscriptionChangePhasePlanError)) {
      throw new Error("Expected SubscriptionChangePhasePlanError")
    }
    expect(result.err.code).toBe("SUBSCRIPTION_CHANGE_PLAN_TARGET_PLAN_WRONG_CURRENCY")
    expect(createPhase).not.toHaveBeenCalled()
  })

  it("reuses an injected target plan version instead of fetching it again", async () => {
    const { deps, getPlanVersionByIdRecord, createPhase } = createDeps()

    const result = await changeSubscriptionPhasePlan(
      deps as never,
      { ...createInput("end_of_cycle"), expectedCurrency: "USD" },
      {
        targetPlanVersion: {
          id: "pv_target",
          projectId,
          active: true,
          status: "published",
          archived: false,
          currency: "USD",
          paymentProvider: "sandbox",
          paymentMethodRequired: false,
        } as never,
      }
    )

    if (result.err) {
      throw result.err
    }

    expect(getPlanVersionByIdRecord).not.toHaveBeenCalled()
    expect(createPhase).toHaveBeenCalled()
  })

  it("rejects scheduling when a future phase already exists", async () => {
    const activePhase = createPhaseFixture({ endAt: currentCycleEndAt - 1 })
    const futurePhase = createPhaseFixture({
      id: "phase_future",
      planVersionId: "pv_future",
      startAt: currentCycleEndAt,
      endAt: null,
    })
    const { deps, getPlanVersionByIdRecord, createPhase } = createDeps({
      subscription: createSubscription({
        phases: [
          {
            ...activePhase,
            endAt: currentCycleEndAt - 1,
          },
          futurePhase,
        ],
      }),
    })

    const result = await changeSubscriptionPhasePlan(deps as never, createInput("end_of_cycle"))

    expect(result.err).toBeInstanceOf(SubscriptionChangePhasePlanError)
    if (!(result.err instanceof SubscriptionChangePhasePlanError)) {
      throw new Error("Expected SubscriptionChangePhasePlanError")
    }
    expect(result.err.code).toBe("SUBSCRIPTION_CHANGE_PLAN_ALREADY_SCHEDULED")
    expect(getPlanVersionByIdRecord).not.toHaveBeenCalled()
    expect(createPhase).not.toHaveBeenCalled()
  })
})
