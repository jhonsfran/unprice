import { TRPCError, initTRPC } from "@trpc/server"
import type { BudgetAuditRow, BudgetCatalogRow } from "@unprice/db/validators"
import type { WorkspaceRole } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})

import { releaseHold } from "./releaseHold"

const AT = 1_796_083_200_000

const catalogRow: BudgetCatalogRow = {
  id: "bgt_1",
  key: "customer:acme",
  unit: "money:USD",
  version: 1,
  cap: "hard",
  limits: [],
  closesAt: null,
  status: "open",
  createdAt: AT,
  updatedAt: AT,
}

/** A caller with `role`, whose services record each release that reached the budget. */
function callerAs(role: WorkspaceRole) {
  const released: unknown[] = []
  const requested: BudgetAuditRow = {
    id: "bga_1",
    budgetId: "bgt_1",
    action: "release_hold",
    subject: "h_7",
    actorUserId: "usr_1",
    reason: "worker crashed before the call",
    status: "requested",
    createdAt: AT,
    updatedAt: AT,
  }
  const ctx = {
    project: { id: "proj_1" },
    userId: "usr_1",
    // the guard's own check, as projectWorkspaceGuard builds it for this member
    verifyRole: (roles: WorkspaceRole[]) => {
      if (!roles.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "forbidden" })
    },
    services: {
      budgetCatalog: { get: async () => Ok(catalogRow) },
      budgetAudit: {
        request: async () => Ok(requested),
        resolve: async (_projectId: string, _id: string, outcome: object) =>
          Ok({ ...requested, ...outcome }),
      },
      budgetOperator: {
        release: async (input: unknown) => {
          released.push(input)
          return Ok({ holdId: "h_7", released: "5", replayed: false, balance: {} })
        },
      },
    },
  } as unknown as Context
  const router = initTRPC.context<Context>().create().router({ releaseHold })
  return { caller: router.createCaller(ctx), released }
}

const input = {
  id: "bgt_1",
  holdId: "h_7",
  reason: "worker crashed before the call",
  confirm: true as const,
}

describe("budgets.releaseHold", () => {
  it("forbids a MEMBER before the budget is called, and lets an ADMIN release", async () => {
    const member = callerAs("MEMBER")
    const admin = callerAs("ADMIN")

    await expect(member.caller.releaseHold(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
    const row = await admin.caller.releaseHold(input)

    expect(member.released).toEqual([])
    expect([row.status, row.status === "applied" && row.released]).toEqual(["applied", "5"])
    expect(admin.released).toEqual([{ projectId: "proj_1", key: "customer:acme", holdId: "h_7" }])
  })

  it("fails input validation without the attestation or with a short reason", async () => {
    const { caller, released } = callerAs("OWNER")
    const { confirm: _, ...unconfirmed } = input

    await expect(caller.releaseHold(unconfirmed as unknown as typeof input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(caller.releaseHold({ ...input, reason: "crashed" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(released).toEqual([])
  })
})
