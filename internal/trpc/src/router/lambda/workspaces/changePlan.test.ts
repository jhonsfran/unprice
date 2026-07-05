import { TRPCError } from "@trpc/server"
import { WorkspaceChangePlanError } from "@unprice/services/use-cases"
import { afterEach, describe, expect, it, vi } from "vitest"

const { changeWorkspacePlanMock } = vi.hoisted(() => ({
  changeWorkspacePlanMock: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", () => {
  class WorkspaceChangePlanError extends Error {
    public readonly code: string
    public readonly retry = false

    constructor(opts: { code: string; message: string }) {
      super(opts.message)
      this.name = "WorkspaceChangePlanError"
      this.code = opts.code
    }
  }

  return {
    changeWorkspacePlan: changeWorkspacePlanMock,
    WorkspaceChangePlanError,
  }
})

import { changePlanErrorToTrpcError, changePlanMutation } from "./changePlan.impl"

afterEach(() => {
  changeWorkspacePlanMock.mockReset()
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

  it("keeps provider-disabled failures human-readable and customer-visible", () => {
    const error = changePlanErrorToTrpcError(
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
    const error = changePlanErrorToTrpcError(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_PLAN_CHANGE_ALREADY_SCHEDULED",
        message:
          "A plan change is already scheduled. Contact support to modify it before choosing another plan.",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("A plan change is already scheduled")
  })

  it("maps wrong-project target failures the same way as not-found", () => {
    const error = changePlanErrorToTrpcError(
      new WorkspaceChangePlanError({
        code: "WORKSPACE_TARGET_PLAN_VERSION_WRONG_PROJECT",
        message: "Target plan version was not found for this workspace billing project",
      })
    )

    expect(error.code).toBe("BAD_REQUEST")
  })

  it("maps expected service failures to precondition failed", () => {
    const error = changePlanErrorToTrpcError(
      Object.assign(
        new Error("Subscription must be active to create a new phase. Please contact support."),
        {
          name: "UnPriceSubscriptionError",
        }
      )
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Subscription must be active")
  })

  it("keeps unexpected subscription failures internal", () => {
    const error = changePlanErrorToTrpcError(
      Object.assign(new Error("database failed"), {
        name: "UnPriceSubscriptionError",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps phase overlap failures customer-visible", () => {
    const error = changePlanErrorToTrpcError(
      Object.assign(new Error("Phases overlap, there is already a phase in the same date range"), {
        name: "UnPriceSubscriptionError",
      })
    )

    expect(error.code).toBe("PRECONDITION_FAILED")
    expect(error.message).toContain("Phases overlap")
  })

  it("keeps generic fetch failures internal", () => {
    const error = changePlanErrorToTrpcError(
      Object.assign(new Error("database failed"), {
        name: "FetchError",
      })
    )

    expect(error.code).toBe("INTERNAL_SERVER_ERROR")
  })

  it("maps schema-like failures to bad request", () => {
    const error = changePlanErrorToTrpcError(
      Object.assign(new Error("targetPlanVersionId is required"), {
        name: "SchemaError",
      })
    )

    expect(error.code).toBe("BAD_REQUEST")
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
