import { TRPCError } from "@trpc/server"
import { SchemaError } from "@unprice/error"
import { UnPriceSubscriptionError } from "@unprice/services/subscriptions"
import { WorkspaceChangePlanError } from "@unprice/services/use-cases"
import { afterEach, describe, expect, it, vi } from "vitest"
import { domainErrorToTrpcError } from "#domain-error"

const { changeWorkspacePlanMock } = vi.hoisted(() => ({
  changeWorkspacePlanMock: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async (importActual) => {
  const actual = await importActual<typeof import("@unprice/services/use-cases")>()

  return {
    ...actual,
    changeWorkspacePlan: changeWorkspacePlanMock,
  }
})

import { changePlanMutation } from "./changePlan.impl"

afterEach(() => {
  changeWorkspacePlanMock.mockReset()
})

describe("changePlan error mapping", () => {
  it("keeps provider-disabled failures human-readable and customer-visible", () => {
    const error = domainErrorToTrpcError(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_PROVIDER_UNAVAILABLE",
        message:
          "Stripe is disabled for this project. Enable it in payment settings before creating subscriptions.",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Stripe is disabled")
  })

  it("keeps already-scheduled plan change failures customer-visible", () => {
    const error = domainErrorToTrpcError(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED",
        message:
          "A plan change is already scheduled. Contact support to modify it before choosing another plan.",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("A plan change is already scheduled")
  })

  it("maps wrong-project target failures to bad request", () => {
    const error = domainErrorToTrpcError(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT",
        message: "Target plan version was not found for this workspace billing project",
      })
    )

    expect(error.code).toBe("BAD_REQUEST")
  })

  it("maps expected subscription failures to precondition failed", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "SUBSCRIPTION_NOT_ACTIVE",
        message: "Subscription must be active to create a new phase. Please contact support.",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Subscription must be active")
  })

  it("keeps phase overlap failures customer-visible", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "PHASE_OVERLAP",
        message: "Phases overlap, there is already a phase in the same date range",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Phases overlap")
  })

  it("keeps unexpected subscription failures internal", () => {
    const error = domainErrorToTrpcError(
      new UnPriceSubscriptionError({
        code: "SUBSCRIPTION_OPERATION_FAILED",
        message: "database failed",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps generic failures internal", () => {
    const error = domainErrorToTrpcError(new Error("database failed"))

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("maps schema-like failures to bad request", () => {
    const error = domainErrorToTrpcError(
      new SchemaError({ message: "targetPlanVersionId is required" })
    )

    expect(error.code).toBe("BAD_REQUEST")
  })
})

describe("workspace changePlan mutation", () => {
  it("rejects non-owner and non-admin callers before the use case runs", async () => {
    const verifyRole = vi.fn(() => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "You must be a member with roles (OWNER/ADMIN) of this workspace to perform this action",
      })
    })

    await expect(
      changePlanMutation({
        input: {
          workspaceSlug: "acme",
          targetPlanVersionId: "pv_target",
          whenToChange: "immediately",
        },
        ctx: {
          verifyRole,
          workspace: {
            id: "ws_123",
            slug: "acme",
            unPriceCustomerId: "cus_workspace",
          },
          db: {} as never,
          analytics: {} as never,
          logger: {} as never,
          services: {} as never,
        },
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    })

    expect(verifyRole).toHaveBeenCalledWith(["OWNER", "ADMIN"])
    expect(changeWorkspacePlanMock).not.toHaveBeenCalled()
  })

  it("returns the use-case payload when role checks pass", async () => {
    changeWorkspacePlanMock.mockResolvedValue({
      val: {
        status: "scheduled",
        subscriptionId: "sub_123",
        phaseId: "phase_new",
        effectiveAt: Date.parse("2026-07-31T00:00:00.000Z"),
      },
    })

    const result = await changePlanMutation({
      input: {
        workspaceSlug: "acme",
        targetPlanVersionId: "pv_target",
        whenToChange: "end_of_cycle",
      },
      ctx: {
        verifyRole: vi.fn(),
        workspace: {
          id: "ws_123",
          slug: "acme",
          unPriceCustomerId: "cus_workspace",
        },
        db: {} as never,
        analytics: {} as never,
        logger: {} as never,
        services: {
          billing: {},
          customers: {},
          plans: {},
          subscriptions: {},
        } as never,
      },
    })

    expect(result).toEqual({
      status: "scheduled",
      subscriptionId: "sub_123",
      phaseId: "phase_new",
      effectiveAt: Date.parse("2026-07-31T00:00:00.000Z"),
    })
  })
})
