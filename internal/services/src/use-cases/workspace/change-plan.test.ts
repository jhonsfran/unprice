import type { Database } from "@unprice/db"
import { FetchError, Ok, SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { UnPricePaymentProviderError } from "../../payment-provider/errors"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"

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
import { scheduledPlanChangeUnavailableReason } from "./scheduled-plan-change"

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
  activePhaseEndAt?: number | null
  activePhasePaymentMethodId?: string | null
  scheduledPhaseStartAt?: number
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
          paymentMethodId: overrides?.activePhasePaymentMethodId ?? "pm_phase_current",
          creditLinePolicy: "uncapped",
          creditLineAmount: null,
          paymentProvider: "sandbox",
          startAt: now - 1000,
          endAt: overrides?.activePhaseEndAt ?? null,
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
  const getSubscriptionById = vi.fn().mockResolvedValue(
    Ok({
      id: "sub_123",
      customerId: "cus_workspace",
      projectId: "proj_billing",
      active: true,
      status: "active",
      currentCycleStartAt: now - 1000,
      currentCycleEndAt,
      renewAt: currentCycleEndAt,
      timezone: "UTC",
      phases: [
        {
          id: "phase_current",
          projectId: "proj_billing",
          subscriptionId: "sub_123",
          planVersionId: overrides?.currentPlanVersionId ?? "pv_current",
          paymentProvider: "sandbox",
          paymentMethodId: overrides?.activePhasePaymentMethodId ?? "pm_phase_current",
          creditLinePolicy: "uncapped",
          creditLineAmount: null,
          trialUnits: 0,
          trialEndsAt: null,
          billingAnchor: 0,
          metadata: null,
          startAt: now - 1000,
          endAt: overrides?.activePhaseEndAt ?? null,
        },
        ...(overrides?.scheduledPhaseStartAt
          ? [
              {
                id: "phase_scheduled",
                projectId: "proj_billing",
                subscriptionId: "sub_123",
                planVersionId: "pv_scheduled",
                paymentProvider: "sandbox",
                paymentMethodId: null,
                creditLinePolicy: "uncapped" as const,
                creditLineAmount: null,
                trialUnits: 0,
                trialEndsAt: null,
                billingAnchor: 0,
                metadata: null,
                startAt: overrides.scheduledPhaseStartAt,
                endAt: null,
              },
            ]
          : []),
      ],
    })
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
        getSubscriptionById,
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
    getSubscriptionById,
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

  it("rejects self-serve changes when another phase is already scheduled", async () => {
    const { deps, getPlanVersionByIdRecord, updatePhase, createPhase, generateBillingPeriods } =
      createDeps({
        scheduledPhaseStartAt: Date.parse("2026-08-04T00:00:00.000Z"),
      })

    const result = await changeWorkspacePlan(deps as never, createInput("immediately"))

    expect(result.err).toBeInstanceOf(WorkspaceChangePlanError)
    expect((result.err as WorkspaceChangePlanError).code).toBe(
      "WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED"
    )
    expect(result.err?.message).toBe(scheduledPlanChangeUnavailableReason)
    expect(getPlanVersionByIdRecord).toHaveBeenCalledTimes(1)
    expect(updatePhase).not.toHaveBeenCalled()
    expect(createPhase).not.toHaveBeenCalled()
    expect(generateBillingPeriods).not.toHaveBeenCalled()
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
        err: new UnPricePaymentProviderError({
          code: "MISSING_PAYMENT_METHOD",
          message: "No payment methods found",
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
    expect(result.err?.message).toBe(
      "Target plan version was not found for this workspace billing project"
    )
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
        paymentMethodId: "pm_phase_current",
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
      now: now + 1,
      db: tx,
    })
  })

  it("ends an open-ended current phase at cycle end minus one before scheduling the next phase", async () => {
    const now = Date.parse("2026-07-04T10:00:00.000Z")
    const currentCycleEndAt = now + 86_400_000
    const activePhasePaymentMethodId = "pm_phase_current"
    const activePhase = {
      startAt: now - 1000,
      endAt: null as number | null,
    }
    const { deps, tx, updatePhase, createPhase, generateBillingPeriods } = createDeps({
      now,
      currentCycleEndAt,
      activePhaseEndAt: activePhase.endAt,
      activePhasePaymentMethodId,
    })

    updatePhase.mockImplementation(async ({ input }) => {
      activePhase.endAt = input.endAt
      return Ok({ id: "phase_current" })
    })

    createPhase.mockImplementation(async ({ input, now: effectiveNow }) => {
      const overlapsOpenEndedPhase =
        activePhase.endAt === null || input.startAt <= activePhase.endAt
      const isConsecutive = activePhase.endAt !== null && activePhase.endAt + 1 === input.startAt
      const wouldActivateTargetPhase = input.startAt <= effectiveNow

      if (overlapsOpenEndedPhase || !isConsecutive) {
        return {
          err: new UnPriceSubscriptionError({
            code: "SUBSCRIPTION_OPERATION_FAILED",
            message: "Phases overlap, there is already a phase in the same date range",
          }),
        }
      }

      if (wouldActivateTargetPhase) {
        return {
          err: new UnPriceSubscriptionError({
            code: "SUBSCRIPTION_OPERATION_FAILED",
            message: "Scheduled future phase activated immediately",
          }),
        }
      }

      return Ok({ id: "phase_new" })
    })

    const result = await changeWorkspacePlan(deps as never, createInput("end_of_cycle"))

    expect(result.val).toEqual({
      status: "scheduled",
      subscriptionId: "sub_123",
      phaseId: "phase_new",
      effectiveAt: currentCycleEndAt,
    })
    expect(updatePhase).toHaveBeenCalledWith({
      input: expect.objectContaining({
        id: "phase_current",
        subscriptionId: "sub_123",
        paymentMethodId: activePhasePaymentMethodId,
        startAt: now - 1000,
        endAt: currentCycleEndAt - 1,
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
        startAt: currentCycleEndAt,
      }),
      projectId: "proj_billing",
      db: tx,
      now,
    })
    expect(generateBillingPeriods).toHaveBeenCalledWith({
      projectId: "proj_billing",
      subscriptionId: "sub_123",
      now,
      db: tx,
    })
    expect(activePhase.endAt).toBe(currentCycleEndAt - 1)
  })

  it("returns the phase error and skips period generation when phase creation fails", async () => {
    const phaseError = new SchemaError({
      message: "phase create failed",
    })
    const { deps, updatePhase, createPhase, generateBillingPeriods } = createDeps()
    createPhase.mockResolvedValue({ err: phaseError })

    const result = await changeWorkspacePlan(deps as never, createInput("immediately"))

    expect(result.err).toBe(phaseError)
    expect(updatePhase).toHaveBeenCalled()
    expect(createPhase).toHaveBeenCalled()
    expect(generateBillingPeriods).not.toHaveBeenCalled()
  })

  it("rolls back staged immediate-change writes when billing period generation fails", async () => {
    const billingError = new FetchError({
      message: "billing period generation failed",
      retry: false,
    })
    const committedWrites: string[] = []
    let rolledBack = false
    const tx = {
      stagedWrites: [] as string[],
    } as unknown as Database & { stagedWrites: string[] }

    const { deps, updatePhase, createPhase, generateBillingPeriods } = createDeps()

    deps.db.transaction = vi.fn(async (callback: (db: Database) => Promise<unknown>) => {
      try {
        const result = await callback(tx)
        committedWrites.push(...tx.stagedWrites)
        return result
      } catch (error) {
        rolledBack = true
        return Promise.reject(error)
      }
    }) as never

    updatePhase.mockImplementation(async ({ db }) => {
      ;(db as Database & { stagedWrites: string[] }).stagedWrites.push("close-current-phase")
      return Ok({ id: "phase_current" })
    })

    createPhase.mockImplementation(async ({ db }) => {
      ;(db as Database & { stagedWrites: string[] }).stagedWrites.push("create-target-phase")
      return Ok({ id: "phase_new" })
    })

    generateBillingPeriods.mockResolvedValue({ err: billingError })

    const result = await changeWorkspacePlan(deps as never, createInput("immediately"))

    expect(result.err).toBe(billingError)
    expect(updatePhase).toHaveBeenCalled()
    expect(createPhase).toHaveBeenCalled()
    expect(generateBillingPeriods).toHaveBeenCalled()
    expect(rolledBack).toBe(true)
    expect(committedWrites).toEqual([])
    expect(tx.stagedWrites).toEqual(["close-current-phase", "create-target-phase"])
  })
})
