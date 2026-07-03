import type { Database } from "@unprice/db"
import type { Logger } from "@unprice/logs"
import { describe, expect, it, vi } from "vitest"
import { WorkspaceService } from "./service"

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

describe("WorkspaceService.createWorkspaceRecord", () => {
  it("creates a workspace with the server-issued id and owner membership", async () => {
    const workspacesFindFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    const insertValues = vi
      .fn()
      .mockReturnValueOnce({
        returning: vi.fn().mockResolvedValue([
          {
            id: "ws_pending",
            slug: "workspace-slug",
            name: "Workspace",
            unPriceCustomerId: "cus_1",
          },
        ]),
      })
      .mockReturnValueOnce({
        returning: vi.fn().mockResolvedValue([
          {
            userId: "user_1",
            workspaceId: "ws_pending",
            role: "OWNER",
          },
        ]),
      })
    const tx = {
      query: {
        workspaces: {
          findFirst: workspacesFindFirst,
        },
      },
      insert: vi.fn().mockReturnValue({
        values: insertValues,
      }),
    }
    const db = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue({
            id: "user_1",
            image: null,
          }),
        },
      },
      transaction: vi.fn((callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const result = await new WorkspaceService({ db, logger: createLogger() }).createWorkspaceRecord(
      {
        input: {
          id: "ws_pending",
          name: "Workspace",
          unPriceCustomerId: "cus_1",
        },
        userId: "user_1",
        plan: "FREE",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      workspace: {
        id: "ws_pending",
        unPriceCustomerId: "cus_1",
      },
    })
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ws_pending",
        unPriceCustomerId: "cus_1",
      })
    )
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        workspaceId: "ws_pending",
        role: "OWNER",
      })
    )
  })

  it("does not add a caller to an existing workspace they do not belong to", async () => {
    const tx = {
      query: {
        workspaces: {
          findFirst: vi.fn().mockResolvedValue({
            id: "ws_pending",
            unPriceCustomerId: "cus_1",
          }),
        },
        members: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      insert: vi.fn(),
    }
    const db = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue({
            id: "user_2",
            image: null,
          }),
        },
      },
      transaction: vi.fn((callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const result = await new WorkspaceService({ db, logger: createLogger() }).createWorkspaceRecord(
      {
        input: {
          id: "ws_pending",
          name: "Workspace",
          unPriceCustomerId: "cus_1",
        },
        userId: "user_2",
        plan: "FREE",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "workspace_claim_conflict" })
    expect(tx.insert).not.toHaveBeenCalled()
  })
})

describe("WorkspaceService.changeMemberRole", () => {
  it("demotes an owner when another owner remains", async () => {
    const updateReturning = vi.fn().mockResolvedValue([
      {
        userId: "user_1",
        workspaceId: "ws_1",
        role: "ADMIN",
      },
    ])
    const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning })
    const tx = {
      query: {
        members: {
          findFirst: vi.fn().mockResolvedValue({
            userId: "user_1",
            workspaceId: "ws_1",
            role: "OWNER",
          }),
          findMany: vi.fn().mockResolvedValue([{ userId: "user_1" }, { userId: "user_2" }]),
        },
      },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: updateWhere,
        }),
      }),
      execute: vi.fn(),
    }
    const db = {
      transaction: vi.fn((callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const result = await new WorkspaceService({ db, logger: createLogger() }).changeMemberRole({
      workspaceId: "ws_1",
      userId: "user_1",
      role: "ADMIN",
      actorRole: "OWNER",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      state: "ok",
      member: {
        userId: "user_1",
        role: "ADMIN",
      },
    })
    expect(updateWhere).toHaveBeenCalledTimes(1)
  })

  it("blocks demoting the sole remaining owner", async () => {
    const update = vi.fn()
    const tx = {
      query: {
        members: {
          findFirst: vi.fn().mockResolvedValue({
            userId: "user_1",
            workspaceId: "ws_1",
            role: "OWNER",
          }),
          findMany: vi.fn().mockResolvedValue([{ userId: "user_1" }]),
        },
      },
      update,
      execute: vi.fn(),
    }
    const db = {
      transaction: vi.fn((callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    } as unknown as Database

    const result = await new WorkspaceService({ db, logger: createLogger() }).changeMemberRole({
      workspaceId: "ws_1",
      userId: "user_1",
      role: "ADMIN",
      actorRole: "OWNER",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "last_owner" })
    expect(update).not.toHaveBeenCalled()
  })

  it("blocks admins from assigning the owner role", async () => {
    const db = {
      transaction: vi.fn(),
    } as unknown as Database

    const result = await new WorkspaceService({ db, logger: createLogger() }).changeMemberRole({
      workspaceId: "ws_1",
      userId: "user_1",
      role: "OWNER",
      actorRole: "ADMIN",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual({ state: "owner_role_forbidden" })
    expect(db.transaction).not.toHaveBeenCalled()
  })
})
