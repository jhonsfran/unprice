import { TRPCError } from "@trpc/server"
import { DeletePersonalWorkspaceError } from "@unprice/services/use-cases"
import { afterEach, describe, expect, it, vi } from "vitest"
import { domainErrorToTrpcError } from "#domain-error"

const { deletePersonalWorkspaceMock } = vi.hoisted(() => ({
  deletePersonalWorkspaceMock: vi.fn(),
}))

vi.mock("@unprice/services/use-cases", async (importActual) => {
  const actual = await importActual<typeof import("@unprice/services/use-cases")>()

  return {
    ...actual,
    deletePersonalWorkspace: deletePersonalWorkspaceMock,
  }
})

import { deletePersonalMutation } from "./deletePersonal.impl"

afterEach(() => {
  deletePersonalWorkspaceMock.mockReset()
})

const services = {
  workspaces: {},
  projects: {},
  subscriptions: {},
  customers: {},
} as never

describe("deletePersonal error mapping", () => {
  it.each([
    ["WORKSPACE_NOT_FOUND", "NOT_FOUND"],
    ["WORKSPACE_NOT_PERSONAL", "BAD_REQUEST"],
    ["WORKSPACE_IS_MAIN", "BAD_REQUEST"],
    ["WORKSPACE_IS_INTERNAL", "BAD_REQUEST"],
    ["WORKSPACE_CONFIRMATION_MISMATCH", "BAD_REQUEST"],
    ["WORKSPACE_NOT_OWNER", "FORBIDDEN"],
    ["WORKSPACE_HAS_OTHER_WORKSPACES", "PRECONDITION_FAILED"],
    ["WORKSPACE_BILLING_PROJECT_NOT_FOUND", "INTERNAL_SERVER_ERROR"],
  ] as const)("maps %s to %s", (code, trpcCode) => {
    const error = domainErrorToTrpcError(
      new DeletePersonalWorkspaceError({ code, message: "blocked" })
    )

    expect(error.code).toBe(trpcCode)
  })
})

describe("workspace deletePersonal mutation", () => {
  it("rejects non-owners before the use case runs", async () => {
    const verifyRole = vi.fn(() => {
      throw new TRPCError({ code: "FORBIDDEN", message: "owner only" })
    })

    await expect(
      deletePersonalMutation({
        input: { workspaceSlug: "sebastian", confirmation: "sebastian" },
        ctx: {
          verifyRole,
          userId: "usr_1",
          workspace: { id: "ws_1" },
          logger: {} as never,
          services,
        },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    expect(verifyRole).toHaveBeenCalledWith(["OWNER"])
    expect(deletePersonalWorkspaceMock).not.toHaveBeenCalled()
  })

  it("passes the resolved workspace and session user to the use case", async () => {
    deletePersonalWorkspaceMock.mockResolvedValue({
      val: {
        workspace: { id: "ws_1", slug: "sebastian", name: "Sebastian" },
        accountDeleted: true,
      },
    })

    const result = await deletePersonalMutation({
      input: { workspaceSlug: "sebastian", confirmation: "sebastian" },
      ctx: {
        verifyRole: vi.fn(),
        userId: "usr_1",
        workspace: { id: "ws_1" },
        logger: {} as never,
        services,
      },
    })

    expect(deletePersonalWorkspaceMock).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      userId: "usr_1",
      confirmation: "sebastian",
    })
    expect(result).toEqual({
      workspace: { id: "ws_1", slug: "sebastian", name: "Sebastian" },
      accountDeleted: true,
    })
  })

  it("throws a mapped tRPC error when the use case refuses", async () => {
    deletePersonalWorkspaceMock.mockResolvedValue({
      err: new DeletePersonalWorkspaceError({
        code: "WORKSPACE_NOT_PERSONAL",
        message: "Only personal workspaces can be deleted with this action",
      }),
    })

    await expect(
      deletePersonalMutation({
        input: { workspaceSlug: "acme", confirmation: "acme" },
        ctx: {
          verifyRole: vi.fn(),
          userId: "usr_1",
          workspace: { id: "ws_team" },
          logger: {} as never,
          services,
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
})
