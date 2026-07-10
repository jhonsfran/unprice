import type { Database } from "@unprice/db"
import type { PlanVersionApi } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UnPriceCustomerError } from "../../customers/errors"

const { checkPaymentProviderAvailabilityMock, getCustomerCurrentAccessMock } = vi.hoisted(() => ({
  checkPaymentProviderAvailabilityMock: vi.fn(),
  getCustomerCurrentAccessMock: vi.fn(),
}))

vi.mock("../customer/get-current-access", () => ({
  getCustomerCurrentAccess: getCustomerCurrentAccessMock,
}))

vi.mock("../payment-provider/availability", () => ({
  checkPaymentProviderAvailability: checkPaymentProviderAvailabilityMock,
}))

import {
  UnPricePaymentProviderError,
  isMissingPaymentMethodError,
} from "../../payment-provider/errors"
import { getWorkspaceUpgradeOptions } from "./get-upgrade-options"
import { scheduledPlanChangeUnavailableReason } from "./scheduled-plan-change"

const now = Date.parse("2026-07-04T10:00:00.000Z")

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

function createPlan(id: string, slug: string): PlanVersionApi["plan"] {
  return {
    id,
    projectId: "proj_billing",
    createdAtM: now,
    updatedAtM: now,
    slug,
    title: slug.toUpperCase(),
    active: true,
    description: `${slug} plan`,
    metadata: null,
    defaultPlan: false,
    enterprisePlan: false,
  }
}

function createPlanVersion(overrides: Partial<PlanVersionApi> = {}): PlanVersionApi {
  const id = overrides.id ?? "pv_available"
  const planId = overrides.planId ?? `plan_${id}`
  const plan = overrides.plan ?? createPlan(planId, id.replace(/^pv_/, ""))

  return {
    id,
    projectId: "proj_billing",
    createdAtM: now,
    updatedAtM: now,
    planId,
    description: `${id} plan version`,
    latest: true,
    title: id.toUpperCase(),
    tags: [],
    active: true,
    status: "published",
    publishedAt: now,
    publishedBy: null,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    paymentProvider: "sandbox",
    dueBehaviour: "cancel",
    currency: "USD",
    billingConfig: {
      name: "Monthly",
      billingInterval: "month",
      billingIntervalCount: 1,
      billingAnchor: "dayOfCreation",
      planType: "recurring",
    },
    whenToBill: "pay_in_advance",
    gracePeriod: 0,
    collectionMethod: "charge_automatically",
    trialUnits: 0,
    autoRenew: true,
    metadata: null,
    paymentMethodRequired: false,
    version: 1,
    plan,
    planFeatures: [],
    flatPrice: "$0.00",
    ...overrides,
  }
}

function createDeps(
  planVersions: PlanVersionApi[],
  opts?: {
    scheduledPhaseStartAt?: number
  }
) {
  const validatePaymentMethod = vi
    .fn()
    .mockResolvedValue(Ok({ paymentMethodId: "pm_default", requiredPaymentMethod: true }))
  const listPlanVersions = vi.fn().mockResolvedValue(Ok(planVersions))
  const getSubscriptionById = vi.fn().mockResolvedValue(
    Ok({
      phases: [
        {
          id: "phase_current",
          startAt: now - 1000,
          endAt: null,
        },
        ...(opts?.scheduledPhaseStartAt
          ? [
              {
                id: "phase_scheduled",
                startAt: opts.scheduledPhaseStartAt,
                endAt: null,
              },
            ]
          : []),
      ],
    })
  )

  getCustomerCurrentAccessMock.mockResolvedValue(
    Ok({
      activePlan: {
        subscriptionId: "sub_123",
        currentCycleEndAt: now + 86_400_000,
        activePhase: {
          id: "phase_current",
          planVersionId: "pv_current",
        },
      },
    })
  )
  checkPaymentProviderAvailabilityMock.mockResolvedValue(
    Ok({
      available: true,
      paymentProviderConfig: {},
    })
  )

  return {
    deps: {
      db: {} as Database,
      analytics: {
        getFeaturesUsagePeriod: vi.fn().mockResolvedValue({ data: [] }),
      },
      logger: createLogger(),
      services: {
        customers: {
          getCustomerByIdAcrossProjects: vi.fn().mockResolvedValue(
            Ok({
              id: "cus_workspace",
              projectId: "proj_billing",
              defaultCurrency: "USD",
              project: {
                defaultCurrency: "USD",
              },
            })
          ),
          validatePaymentMethod,
        },
        plans: {
          listPlanVersions,
        },
        subscriptions: {
          getSubscriptionById,
        },
      },
      now: () => now,
    },
    listPlanVersions,
    validatePaymentMethod,
    getSubscriptionById,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("isMissingPaymentMethodError", () => {
  it("treats a MISSING_PAYMENT_METHOD provider error as non-fatal", () => {
    expect(
      isMissingPaymentMethodError(
        new UnPricePaymentProviderError({
          code: "MISSING_PAYMENT_METHOD",
          message: "Required payment method not found",
        })
      )
    ).toBe(true)

    expect(
      isMissingPaymentMethodError(
        new UnPricePaymentProviderError({
          code: "MISSING_PAYMENT_METHOD",
          message: "No payment methods found",
        })
      )
    ).toBe(true)
  })

  it("keeps unrelated failures fatal — classifies by code, never message", () => {
    // A generic provider error with a payment-method-ish message must NOT match:
    // classification is by code, not prose.
    expect(
      isMissingPaymentMethodError(
        new UnPricePaymentProviderError({ message: "No payment methods found" })
      )
    ).toBe(false)

    expect(
      isMissingPaymentMethodError(
        new FetchError({
          message: "Required payment method not found",
          retry: false,
        })
      )
    ).toBe(false)

    expect(
      isMissingPaymentMethodError(
        new UnPriceCustomerError({
          code: "CUSTOMER_NOT_FOUND",
          message: "Customer not found",
        })
      )
    ).toBe(false)

    expect(isMissingPaymentMethodError("No payment methods found")).toBe(false)
  })
})

describe("getWorkspaceUpgradeOptions", () => {
  it("excludes archived non-current plan versions from selectable options", async () => {
    const currentPlanVersion = createPlanVersion({
      id: "pv_current",
      planId: "plan_current",
      plan: createPlan("plan_current", "current"),
    })
    const selectablePlanVersion = createPlanVersion({
      id: "pv_selectable",
      planId: "plan_selectable",
      plan: createPlan("plan_selectable", "selectable"),
    })
    const archivedPlanVersion = createPlanVersion({
      id: "pv_archived",
      planId: "plan_archived",
      plan: createPlan("plan_archived", "archived"),
      archived: true,
      paymentProvider: "stripe",
    })
    const { deps, listPlanVersions } = createDeps([
      currentPlanVersion,
      selectablePlanVersion,
      archivedPlanVersion,
    ])

    const result = await getWorkspaceUpgradeOptions(deps as never, {
      workspace: {
        id: "ws_123",
        slug: "acme",
        unPriceCustomerId: "cus_workspace",
      },
    })

    expect(result.err).toBeUndefined()
    expect(listPlanVersions).toHaveBeenCalledWith({
      projectId: "proj_billing",
      query: {
        published: true,
      },
      opts: {
        skipCache: true,
      },
    })
    expect(result.val?.options.map((option) => option.planVersion.id)).toEqual([
      "pv_current",
      "pv_selectable",
    ])
    expect(checkPaymentProviderAvailabilityMock).toHaveBeenCalledTimes(1)
    expect(checkPaymentProviderAvailabilityMock).toHaveBeenCalledWith(deps, {
      projectId: "proj_billing",
      paymentProvider: "sandbox",
    })
  })

  it("marks non-current plans unavailable when a future phase is already scheduled", async () => {
    const currentPlanVersion = createPlanVersion({
      id: "pv_current",
      planId: "plan_current",
      plan: createPlan("plan_current", "current"),
    })
    const selectablePlanVersion = createPlanVersion({
      id: "pv_selectable",
      planId: "plan_selectable",
      plan: createPlan("plan_selectable", "selectable"),
    })
    const { deps, validatePaymentMethod } = createDeps(
      [currentPlanVersion, selectablePlanVersion],
      {
        scheduledPhaseStartAt: now + 86_400_000,
      }
    )

    const result = await getWorkspaceUpgradeOptions(deps as never, {
      workspace: {
        id: "ws_123",
        slug: "acme",
        unPriceCustomerId: "cus_workspace",
      },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planVersion: expect.objectContaining({ id: "pv_current" }),
          isCurrent: true,
          isAvailable: false,
          unavailableCode: "current",
          unavailableReason: "This is your current plan.",
        }),
        expect.objectContaining({
          planVersion: expect.objectContaining({ id: "pv_selectable" }),
          isCurrent: false,
          isAvailable: false,
          unavailableCode: "scheduled_change",
          unavailableReason: scheduledPlanChangeUnavailableReason,
        }),
      ])
    )
    expect(checkPaymentProviderAvailabilityMock).not.toHaveBeenCalled()
    expect(validatePaymentMethod).not.toHaveBeenCalled()
  })

  it("returns one visible option per plan and keeps the current plan version by default", async () => {
    const proPlan = createPlan("plan_pro", "pro")
    const freePlan = createPlan("plan_free", "free")
    const currentPlanVersion = createPlanVersion({
      id: "pv_current",
      planId: proPlan.id,
      plan: proPlan,
      latest: false,
      version: 1,
    })
    const latestProPlanVersion = createPlanVersion({
      id: "pv_pro_latest",
      planId: proPlan.id,
      plan: proPlan,
      latest: true,
      version: 2,
    })
    const olderFreePlanVersion = createPlanVersion({
      id: "pv_free_v1",
      planId: freePlan.id,
      plan: freePlan,
      latest: false,
      version: 1,
    })
    const latestFreePlanVersion = createPlanVersion({
      id: "pv_free_v2",
      planId: freePlan.id,
      plan: freePlan,
      latest: true,
      version: 2,
    })
    const { deps } = createDeps([
      currentPlanVersion,
      latestProPlanVersion,
      olderFreePlanVersion,
      latestFreePlanVersion,
    ])

    const result = await getWorkspaceUpgradeOptions(deps as never, {
      workspace: {
        id: "ws_123",
        slug: "acme",
        unPriceCustomerId: "cus_workspace",
      },
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.options.map((option) => option.planVersion.id)).toEqual([
      "pv_current",
      "pv_free_v2",
    ])
    expect(result.val?.options[0]?.isCurrent).toBe(true)
  })

  it("uses a requested target plan version for that plan without duplicating the plan", async () => {
    const proPlan = createPlan("plan_pro", "pro")
    const freePlan = createPlan("plan_free", "free")
    const currentPlanVersion = createPlanVersion({
      id: "pv_current",
      planId: proPlan.id,
      plan: proPlan,
      latest: true,
      version: 1,
    })
    const targetFreePlanVersion = createPlanVersion({
      id: "pv_free_v1",
      planId: freePlan.id,
      plan: freePlan,
      latest: false,
      version: 1,
    })
    const latestFreePlanVersion = createPlanVersion({
      id: "pv_free_v2",
      planId: freePlan.id,
      plan: freePlan,
      latest: true,
      version: 2,
    })
    const { deps } = createDeps([currentPlanVersion, targetFreePlanVersion, latestFreePlanVersion])

    const result = await getWorkspaceUpgradeOptions(deps as never, {
      workspace: {
        id: "ws_123",
        slug: "acme",
        unPriceCustomerId: "cus_workspace",
      },
      targetPlanVersionId: targetFreePlanVersion.id,
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.options.map((option) => option.planVersion.id)).toEqual([
      "pv_current",
      "pv_free_v1",
    ])
  })
})
