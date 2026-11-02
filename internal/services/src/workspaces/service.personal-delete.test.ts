import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceService, extractDbErrorDetails } from "./service"

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

const personalWorkspace = {
  id: "ws_1",
  slug: "sebastian",
  name: "Sebastian",
  isPersonal: true,
  isMain: false,
  isInternal: false,
  createdBy: "usr_1",
  unPriceCustomerId: "cus_ws_1",
}

function createQueries({
  workspace = personalWorkspace as Record<string, unknown> | null,
  role = "OWNER" as string | null,
  otherMembership = null as { workspaceId: string } | null,
  otherCreatedWorkspace = null as { id: string } | null,
} = {}) {
  return {
    workspaces: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(workspace)
        .mockResolvedValueOnce(otherCreatedWorkspace),
    },
    members: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(role ? { role } : null)
        .mockResolvedValueOnce(otherMembership),
    },
  }
}

async function check(queries: ReturnType<typeof createQueries>) {
  const db = { query: queries } as unknown as Database
  const service = new WorkspaceService({ db, logger: createLogger() })
  const result = await service.checkPersonalWorkspaceDeletion({
    workspaceId: "ws_1",
    userId: "usr_1",
  })
  expect(result.err).toBeUndefined()
  return result.val?.state
}

describe("WorkspaceService.checkPersonalWorkspaceDeletion", () => {
  it("allows the owner of a standalone personal workspace", async () => {
    expect(await check(createQueries())).toBe("ok")
  })

  it("blocks a missing workspace", async () => {
    expect(await check(createQueries({ workspace: null }))).toBe("not_found")
  })

  it("blocks team workspaces", async () => {
    expect(
      await check(createQueries({ workspace: { ...personalWorkspace, isPersonal: false } }))
    ).toBe("not_personal")
  })

  it("blocks the main workspace even when flagged personal", async () => {
    expect(await check(createQueries({ workspace: { ...personalWorkspace, isMain: true } }))).toBe(
      "main_workspace"
    )
  })

  it("blocks internal workspaces", async () => {
    expect(
      await check(createQueries({ workspace: { ...personalWorkspace, isInternal: true } }))
    ).toBe("internal_workspace")
  })

  it("blocks a user who did not create the workspace", async () => {
    expect(
      await check(createQueries({ workspace: { ...personalWorkspace, createdBy: "usr_2" } }))
    ).toBe("not_owner")
  })

  it("blocks a member that is not OWNER", async () => {
    expect(await check(createQueries({ role: "MEMBER" }))).toBe("not_owner")
  })

  it("blocks when the account belongs to another workspace", async () => {
    expect(await check(createQueries({ otherMembership: { workspaceId: "ws_team" } }))).toBe(
      "has_other_workspaces"
    )
  })

  it("blocks when the account created another workspace", async () => {
    expect(await check(createQueries({ otherCreatedWorkspace: { id: "ws_team" } }))).toBe(
      "has_other_workspaces"
    )
  })
})

describe("WorkspaceService.deletePersonalWorkspaceAndOwner", () => {
  function createDb(queries: ReturnType<typeof createQueries>, deletedRows: unknown[]) {
    const deleteCalls: unknown[] = []
    const tx = {
      query: queries,
      execute: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn((table: unknown) => {
        deleteCalls.push(table)
        return {
          where: vi.fn(() => {
            const promise = Promise.resolve(undefined)
            return Object.assign(promise, {
              returning: vi.fn().mockResolvedValue(deletedRows),
            })
          }),
        }
      }),
    }
    const db = {
      transaction: vi.fn((callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database
    return { db, tx, deleteCalls }
  }

  it("locks, re-checks, then deletes the workspace before the user", async () => {
    const { db, tx, deleteCalls } = createDb(createQueries(), [personalWorkspace])
    const service = new WorkspaceService({ db, logger: createLogger() })

    const result = await service.deletePersonalWorkspaceAndOwner({
      workspaceId: "ws_1",
      userId: "usr_1",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      workspace: { id: "ws_1" },
      accountDeleted: true,
    })
    expect(tx.execute).toHaveBeenCalledTimes(1)
    expect(deleteCalls).toHaveLength(2)
  })

  it("deletes nothing when the in-transaction re-check fails", async () => {
    const { db, deleteCalls } = createDb(
      createQueries({ otherMembership: { workspaceId: "ws_team" } }),
      [personalWorkspace]
    )
    const service = new WorkspaceService({ db, logger: createLogger() })

    const result = await service.deletePersonalWorkspaceAndOwner({
      workspaceId: "ws_1",
      userId: "usr_1",
    })

    expect(result.val).toEqual({ state: "has_other_workspaces" })
    expect(deleteCalls).toHaveLength(0)
  })

  it("keeps the user when the workspace row is already gone", async () => {
    const { db, deleteCalls } = createDb(createQueries(), [])
    const service = new WorkspaceService({ db, logger: createLogger() })

    const result = await service.deletePersonalWorkspaceAndOwner({
      workspaceId: "ws_1",
      userId: "usr_1",
    })

    expect(result.val).toEqual({ state: "not_found" })
    expect(deleteCalls).toHaveLength(1)
  })

  it("logs the underlying Postgres error when COMMIT fails, without changing the client message", async () => {
    const pgError = Object.assign(
      new Error("wallet_credits invariant violated for customer cus_1: credits_sum_minor=0"),
      { code: "23514", where: "PL/pgSQL function assert_wallet_credits_match_ledger()" }
    )
    const commitError = Object.assign(new Error("Failed query: commit\nparams: "), {
      query: "commit",
      cause: pgError,
    })
    const db = {
      transaction: vi.fn().mockRejectedValue(commitError),
    } as unknown as Database
    const logger = createLogger()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const service = new WorkspaceService({ db, logger })

    const result = await service.deletePersonalWorkspaceAndOwner({
      workspaceId: "ws_1",
      userId: "usr_1",
    })

    expect(result.err?.message).toBe(
      "error deleting personal workspace: Failed query: commit\nparams: "
    )
    expect(logger.error).toHaveBeenCalledWith(
      result.err,
      expect.objectContaining({
        dbError: expect.objectContaining({
          code: "23514",
          message: pgError.message,
          query: "commit",
        }),
      })
    )
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe("extractDbErrorDetails", () => {
  it("falls back to the cause message when no SQLSTATE is present", () => {
    const error = Object.assign(new Error("Failed query: commit"), {
      query: "commit",
      cause: new Error("connection terminated"),
    })
    expect(extractDbErrorDetails(error)).toEqual({
      message: "connection terminated",
      query: "commit",
    })
  })
})
