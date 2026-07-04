import type { Database } from "@unprice/db"
import { FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"

const { getCustomerCurrentAccessMock } = vi.hoisted(() => ({
  getCustomerCurrentAccessMock: vi.fn(),
}))

vi.mock("../customer/get-current-access", async () => {
  const actual = await vi.importActual<typeof import("../customer/get-current-access")>(
    "../customer/get-current-access"
  )

  return {
    ...actual,
    getCustomerCurrentAccess: getCustomerCurrentAccessMock,
  }
})

import { WorkspaceChangePlanError, changeWorkspacePlan } from "./change-plan"

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

function createDeps(overrides?: {
  now?: number
  currentPlanVersionId?: string
  currentCycleEndAt?: number
  targetPlanVersion?: Partial<{
    id: string
    active: boolean
    status: "draft" | "published"
    archived: boolean
    currency: string
    paymentProvider: "sandbox" | "stripe" | "square"
    paymentMethodRequired: boolean
  }>
  paymentProviderConfig?: Partial<{
    active: boolean
    paymentProvider: "sandbox" | "stripe" | "square"
    status: string
    connectionType: string
    mode: string
  }> | null
  validatePaymentMethodResult?: unknown
  scopedTargetPlanVersionResult?: unknown
  versionAcrossProjects?: { id: string; projectId: string } | null
}) {
  const now = overrides?.now ?? Date.parse("2026-07-04T10:00:00.000Z")
  const currentCycleEndAt = overrides?.currentCycleEndAt ?? now + 86_400_000
  const tx = { tag: "tx" } as unknown as Database
  const logger = createLogger()

  getCustomerCurrentAccessMock.mockResolvedValue(
    Ok({
      customerId: "cus_workspace",
      generatedAt: now,
      activePlan: {
        subscriptionId: "sub_123",
        planSlug: "pro",
        status: "active",
        currentCycleStartAt: now - 1000,
        currentCycleEndAt,
        renewAt: currentCycleEndAt,
        timezone: "UTC",
        activePhase: {
          id: "phase_current",
          planVersionId: overrides?.currentPlanVersionId ?? "pv_current",
          creditLinePolicy: "uncapped",
          creditLineAmount: null,
          paymentProvider: "sandbox",
          startAt: now - 1000,
          endAt: currentCycleEndAt,
          planVersion: {
            id: overrides?.currentPlanVersionId ?? "pv_current",
            version: 1,
            billingConfig: {
              name: "Monthly",
              billingInterval: "month",
              billingIntervalCount: 1,
              billingAnchor: "dayOfCreation",
              planType: "recurring",
            },
          },
        },
      },
      activeSubscriptionCount: 1,
      entitlementCount: 0,
      usageUnavailable: false,
      usageWindow: {
        start: now - 1000,
        end: now,
      },
      entitlements: [],
    })
  )

  const db = {
    query: {
      paymentProviderConfig: {
        findFirst: vi.fn().mockResolvedValue(
          overrides?.paymentProviderConfig === null
            ? null
            : {
                id: "ppc_123",
                projectId: "proj_billing",
                paymentProvider: overrides?.paymentProviderConfig?.paymentProvider ?? "sandbox",
                active: overrides?.paymentProviderConfig?.active ?? true,
                connectionType:
                  overrides?.paymentProviderConfig?.connectionType ?? "managed_connection",
                mode: overrides?.paymentProviderConfig?.mode ?? "test",
                status: overrides?.paymentProviderConfig?.status ?? "active",
              }
        ),
      },
      versions: {
        findFirst: vi.fn().mockResolvedValue(overrides?.versionAcrossProjects ?? null),
      },
    },
    transaction: vi.fn(async (callback: (db: Database) => Promise<unknown>) => callback(tx)),
  } as unknown as Database

  const getCustomerByIdAcrossProjects = vi.fn().mockResolvedValue(
    Ok({
      id: "cus_workspace",
      projectId: "proj_billing",
      defaultCurrency: "USD",
      project: {
        defaultCurrency: "USD",
      },
    })
  )
  const getPlanVersionByIdRecord = vi.fn().mockResolvedValue(
    overrides?.scopedTargetPlanVersionResult ??
      Ok({
        id: overrides?.targetPlanVersion?.id ?? "pv_target",
        projectId: "proj_billing",
        active: overrides?.targetPlanVersion?.active ?? true,
        status: overrides?.targetPlanVersion?.status ?? "published",
        archived: overrides?.targetPlanVersion?.archived ?? false,
        currency: overrides?.targetPlanVersion?.currency ?? "USD",
        paymentProvider: overrides?.targetPlanVersion?.paymentProvider ?? "sandbox",
        paymentMethodRequired: overrides?.targetPlanVersion?.paymentMethodRequired ?? false,
      })
  )
  const validatePaymentMethod = vi
    .fn()
    .mockResolvedValue(
      overrides?.validatePaymentMethodResult ??
        Ok({ paymentMethodId: "pm_123", requiredPaymentMethod: true })
    )
  const updatePhase = vi.fn().mockResolvedValue(Ok({ id: "phase_current" }))
  const createPhase = vi.fn().mockResolvedValue(Ok({ id: "phase_new" }))
  const generateBillingPeriods = vi
    .fn()
    .mockResolvedValue(Ok({ cyclesCreated: 1, phasesProcessed: 2 }))

  const deps = {
    db,
    analytics: {
      getFeaturesUsagePeriod: vi.fn().mockResolvedValue({ data: [] }),
    },
    logger,
    now: () => now,
    services: {
      customers: {
        getCustomerByIdAcrossProjects,
        validatePaymentMethod,
      },
      plans: {
        getPlanVersionByIdRecord,
      },
      subscriptions: {
        updatePhase,
        createPhase,
      },
      billing: {
        generateBillingPeriods,
      },
    },
  } as const

  return {
    deps,
    tx,
    now,
    validatePaymentMethod,
    updatePhase,
    createPhase,
    generateBillingPeriods,
    getPlanVersionByIdRecord,
  }
}

function createInput(whenToChange: "immediately" | "end_of_cycle" = "immediately") {
  return {
    workspaceSlug: "acme",
    workspace: {
      id: "ws_123",
      slug: "acme",
      unPriceCustomerId: "cus_workspace",
    },
    targetPlanVersionId: "pv_target",
    whenToChange,
  }
}

describe("changeWorkspacePlan", () => {
  it("rejects the same plan version", async () => {
    const input = createInput()
    const { deps } = createDeps({
      currentPlanVersionId: input.targetPlanVersionId,
    })

    const result = await changeWorkspacePlan(deps as never, input)

    expect(result.err).toBeInstanceOf(WorkspaceChangePlanError)
    expect((result.err as WorkspaceChangePlanError).code).toBe(
      "WORKSPACE_TARGET_PLAN_VERSION_SAME_AS_CURRENT"
    )
  })

  it("returns requires_payment_method when the target plan needs a default method", async () => {
    const { deps, validatePaymentMethod, createPhase, updatePhase } = createDeps({
      targetPlanVersion: {
        paymentProvider: "sandbox",
        paymentMethodRequired: true,
      },
      paymentProviderConfig: {
        paymentProvider: "sandbox",
        active: true,
      },
      validatePaymentMethodResult: {
        err: new FetchError({
          message: "No payment methods found",
          retry: false,
        }),
      },
    })

    const result = await changeWorkspacePlan(deps as never, createInput())

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      status: "requires_payment_method",
      paymentProvider: "sandbox",
      message: "Add a payment method before changing to this plan.",
    })
    expect(validatePaymentMethod).toHaveBeenCalled()
    expect(updatePhase).not.toHaveBeenCalled()
    expect(createPhase).not.toHaveBeenCalled()
  })

  it("returns a provider-unavailable error when the target provider is disabled", async () => {
    const { deps } = createDeps({
      targetPlanVersion: {
        paymentProvider: "stripe",
      },
      paymentProviderConfig: {
        paymentProvider: "stripe",
        active: false,
      },
    })

    const result = await changeWorkspacePlan(deps as never, createInput())

    expect(result.err).toBeInstanceOf(WorkspaceChangePlanError)
    expect((result.err as WorkspaceChangePlanError).code).toBe(
      "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE"
    )
    expect(result.err?.message).toContain("Stripe is disabled")
  })

  it("returns a wrong-project error when the target version exists outside the billing project", async () => {
    const { deps, getPlanVersionByIdRecord } = createDeps({
      scopedTargetPlanVersionResult: Ok(null),
      versionAcrossProjects: {
        id: "pv_target",
        projectId: "proj_other",
      },
    })

    const result = await changeWorkspacePlan(deps as never, createInput())

    expect(getPlanVersionByIdRecord).toHaveBeenCalledWith({
      planVersionId: "pv_target",
      projectId: "proj_billing",
    })
    expect(result.err).toBeInstanceOf(WorkspaceChangePlanError)
    expect((result.err as WorkspaceChangePlanError).code).toBe(
      "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT"
    )
    expect(result.err?.message).toContain("different billing project")
  })

  it("closes the current phase and creates the new one at now + 1 for immediate changes", async () => {
    const { deps, tx, updatePhase, createPhase, generateBillingPeriods } = createDeps()
    const now = deps.now()

    const result = await changeWorkspacePlan(deps as never, createInput("immediately"))

    expect(result.val).toEqual({
      status: "changed",
      subscriptionId: "sub_123",
      phaseId: "phase_new",
    })
    expect(updatePhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        id: "phase_current",
        subscriptionId: "sub_123",
        startAt: now - 1000,
        endAt: now,
      }),
      subscriptionId: "sub_123",
      projectId: "proj_billing",
      db: tx,
      now,
    })
    expect(createPhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        subscriptionId: "sub_123",
        planVersionId: "pv_target",
        startAt: now + 1,
        paymentProvider: "sandbox",
      }),
      projectId: "proj_billing",
      db: tx,
      now: now + 1,
    })
    expect(generateBillingPeriods).toHaveBeenCalledWith({
      projectId: "proj_billing",
      subscriptionId: "sub_123",
      now,
      db: tx,
    })
  })

  it("creates the new phase at the current cycle end for end-of-cycle changes", async () => {
    const now = Date.parse("2026-07-04T10:00:00.000Z")
    const currentCycleEndAt = now + 86_400_000
    const { deps, tx, updatePhase, createPhase } = createDeps({
      now,
      currentCycleEndAt,
    })

    const result = await changeWorkspacePlan(deps as never, createInput("end_of_cycle"))

    expect(result.val).toEqual({
      status: "scheduled",
      subscriptionId: "sub_123",
      phaseId: "phase_new",
      effectiveAt: currentCycleEndAt,
    })
    expect(updatePhase).not.toHaveBeenCalled()
    expect(createPhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        subscriptionId: "sub_123",
        planVersionId: "pv_target",
        startAt: currentCycleEndAt,
      }),
      projectId: "proj_billing",
      db: tx,
      now: currentCycleEndAt,
    })
  })
})
