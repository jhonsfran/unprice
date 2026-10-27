import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"

import type { ServiceContext } from "../../context"
import { UnPriceSubscriptionError } from "../../subscriptions/errors"
import type { PersonalWorkspaceDeletionState } from "../../workspaces/service"
import { DeletePersonalWorkspaceError, deletePersonalWorkspace } from "./delete-personal-workspace"

const workspace = {
  id: "ws_1",
  slug: "sebastian",
  name: "Sebastian",
  unPriceCustomerId: "cus_ws_1",
  isPersonal: true,
  isMain: false,
  isInternal: false,
  createdBy: "usr_1",
}

function createDeps({
  checkState = "ok",
  mainProject = { id: "proj_main" },
  cancelError,
}: {
  checkState?: PersonalWorkspaceDeletionState | "ok"
  mainProject?: { id: string } | null
  cancelError?: UnPriceSubscriptionError
} = {}) {
  const calls: string[] = []

  const workspaces = {
    checkPersonalWorkspaceDeletion: vi.fn(async () => {
      calls.push("check")
      return Ok(checkState === "ok" ? { state: "ok" as const, workspace } : { state: checkState })
    }),
    deletePersonalWorkspaceAndOwner: vi.fn(async () => {
      calls.push("delete")
      return Ok({ state: "ok" as const, workspace })
    }),
  }

  const projects = {
    getMainProject: vi.fn(async () => Ok(mainProject)),
  }

  const subscriptions = {
    listActiveSubscriptions: vi.fn(async () => [{ id: "sub_1" }]),
    cancelSubscription: vi.fn(async ({ subscriptionId }: { subscriptionId: string }) => {
      calls.push(`cancel:${subscriptionId}`)
      return cancelError ? { err: cancelError } : Ok({ id: subscriptionId })
    }),
  }

  const customers = {
    deactivate: vi.fn(async () => {
      calls.push("deactivate")
      return Ok({ success: true })
    }),
  }

  const logger = {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger

  return {
    deps: {
      services: { workspaces, projects, subscriptions, customers } as unknown as Pick<
        ServiceContext,
        "workspaces" | "projects" | "subscriptions" | "customers"
      >,
      logger,
      now: () => 1_700_000_000_000,
    },
    calls,
    workspaces,
    subscriptions,
    customers,
  }
}

const input = { workspaceId: "ws_1", userId: "usr_1", confirmation: "sebastian" }

describe("deletePersonalWorkspace", () => {
  it("cancels workspace billing, then deletes the workspace and its owner", async () => {
    const { deps, calls, subscriptions, customers, workspaces } = createDeps()

    const result = await deletePersonalWorkspace(deps, input)

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({
      workspace: { id: "ws_1", slug: "sebastian", name: "Sebastian" },
    })
    expect(calls).toEqual(["check", "cancel:sub_1", "deactivate", "delete"])
    expect(subscriptions.listActiveSubscriptions).toHaveBeenCalledWith({
      customerId: "cus_ws_1",
      projectId: "proj_main",
    })
    expect(customers.deactivate).toHaveBeenCalledWith({
      customerId: "cus_ws_1",
      projectId: "proj_main",
    })
    expect(workspaces.deletePersonalWorkspaceAndOwner).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "usr_1",
    })
  })

  it.each([
    ["not_found", "WORKSPACE_NOT_FOUND"],
    ["not_personal", "WORKSPACE_NOT_PERSONAL"],
    ["main_workspace", "WORKSPACE_IS_MAIN"],
    ["internal_workspace", "WORKSPACE_IS_INTERNAL"],
    ["not_owner", "WORKSPACE_NOT_OWNER"],
    ["has_other_workspaces", "WORKSPACE_HAS_OTHER_WORKSPACES"],
  ] as const)("blocks %s before touching billing or data", async (state, code) => {
    const { deps, calls } = createDeps({ checkState: state })

    const result = await deletePersonalWorkspace(deps, input)

    expect(result.err).toBeInstanceOf(DeletePersonalWorkspaceError)
    expect((result.err as DeletePersonalWorkspaceError).code).toBe(code)
    expect(calls).toEqual(["check"])
  })

  it("rejects a confirmation that does not match the slug", async () => {
    const { deps, calls } = createDeps()

    const result = await deletePersonalWorkspace(deps, { ...input, confirmation: "Sebastian" })

    expect((result.err as DeletePersonalWorkspaceError).code).toBe(
      "WORKSPACE_CONFIRMATION_MISMATCH"
    )
    expect(calls).toEqual(["check"])
  })

  it("does not delete anything when billing cancellation fails", async () => {
    const cancelError = new UnPriceSubscriptionError({
      code: "SUBSCRIPTION_OPERATION_FAILED",
      message: "provider down",
    })
    const { deps, calls, workspaces } = createDeps({ cancelError })

    const result = await deletePersonalWorkspace(deps, input)

    expect(result.err).toBe(cancelError)
    expect(calls).toEqual(["check", "cancel:sub_1"])
    expect(workspaces.deletePersonalWorkspaceAndOwner).not.toHaveBeenCalled()
  })

  it("fails without deleting when the main billing project is missing", async () => {
    const { deps, calls } = createDeps({ mainProject: null })

    const result = await deletePersonalWorkspace(deps, input)

    expect((result.err as DeletePersonalWorkspaceError).code).toBe(
      "WORKSPACE_BILLING_PROJECT_NOT_FOUND"
    )
    expect(calls).toEqual(["check"])
  })
})
