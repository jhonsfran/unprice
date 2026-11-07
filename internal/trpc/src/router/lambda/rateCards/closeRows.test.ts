import { TRPCError, initTRPC } from "@trpc/server"
import type { WorkspaceRole } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { UnPriceRateCardError } from "@unprice/services/rate-cards"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})

import { closeRows } from "./closeRows"

const NOW = 1_796_083_200_000

/** A caller with `role` whose rate card service answers every call with `answer`. */
function callerAs(role: WorkspaceRole, answer: Result<unknown, UnPriceRateCardError>) {
  const calls: unknown[][] = []
  const ctx = {
    project: { id: "proj_1" },
    verifyRole: (roles: WorkspaceRole[]) => {
      if (!roles.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "forbidden" })
    },
    services: {
      rateCards: {
        closeRows: async (...args: unknown[]) => {
          calls.push(args)
          return answer
        },
      },
    },
  } as unknown as Context
  const router = initTRPC.context<Context>().create().router({ closeRows })
  return { caller: router.createCaller(ctx), calls }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("rateCards.closeRows", () => {
  const input = { cardId: "rc_1", rowIds: ["rr_1"], effectiveTo: NOW + 600_000 }

  it("closes the rows as of now and forbids a MEMBER before anything closes", async () => {
    vi.useFakeTimers({ now: NOW })
    const closed = { closed: [{ rowId: "rr_1", effectiveTo: NOW + 600_000 }], unchanged: 0 }
    const admin = callerAs("ADMIN", Ok(closed))
    const member = callerAs("MEMBER", Ok(closed))

    const result = await admin.caller.closeRows(input)
    const forbidden = await member.caller.closeRows(input).catch((error: TRPCError) => error.code)

    expect(result).toEqual(closed)
    expect(admin.calls).toEqual([
      [
        {
          projectId: "proj_1",
          cardId: "rc_1",
          rowIds: ["rr_1"],
          effectiveTo: NOW + 600_000,
          now: NOW,
        },
      ],
    ])
    expect(forbidden).toBe("FORBIDDEN")
    expect(member.calls).toEqual([])
  })

  it("leaves the end to the card when the caller gives none", async () => {
    vi.useFakeTimers({ now: NOW })
    const { caller, calls } = callerAs("OWNER", Ok({ closed: [], unchanged: 1 }))

    const result = await caller.closeRows({ cardId: "rc_1", rowIds: ["rr_1"] })

    expect(result).toEqual({ closed: [], unchanged: 1 })
    expect(calls).toEqual([[{ projectId: "proj_1", cardId: "rc_1", rowIds: ["rr_1"], now: NOW }]])
    expect("effectiveTo" in (calls[0]?.[0] as object)).toBe(false)
  })

  it("maps a missing row to NOT_FOUND and a closed one to CONFLICT", async () => {
    const missing = await callerAs(
      "OWNER",
      Err(new UnPriceRateCardError({ code: "ROW_NOT_FOUND", rowIds: ["rr_1"] }))
    )
      .caller.closeRows(input)
      .catch((error: TRPCError) => [error.code, error.message])
    const closed = await callerAs(
      "OWNER",
      Err(new UnPriceRateCardError({ code: "ROW_CLOSED", rowId: "rr_1", effectiveTo: NOW }))
    )
      .caller.closeRows(input)
      .catch((error: TRPCError) => [error.code, error.message])

    expect(missing).toEqual(["NOT_FOUND", "Rate rows not found: rr_1"])
    expect(closed).toEqual(["CONFLICT", "Rate row rr_1 already ends at 2026-12-01T00:00:00.000Z"])
  })
})
