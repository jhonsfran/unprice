import { TRPCError } from "@trpc/server"
import { WorkspaceChangePlanError } from "@unprice/services/use-cases"
import { afterEach, describe, expect, it, vi } from "vitest"

const { changeWorkspacePlanMock } = vi.hoisted(() => ({
  changeWorkspacePlanMock: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async () => {
  const actual = await vi.importActual<typeof import("@unprice/services/use-cases")>(
    "@unprice/services/use-cases"
  )

  return {
    ...actual,
    changeWorkspacePlan: changeWorkspacePlanMock,
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
