import { TRPCError, initTRPC } from "@trpc/server"
import type { WorkspaceRole } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import { type RateCardRejection, UnPriceRateCardError } from "@unprice/services/rate-cards"
import { describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})

import { publishRows } from "./publishRows"

const input = {
  cardId: "rc_1",
  effectiveFrom: 1_796_083_200_000,
  rows: [
    {
      featureSlug: "llm_tokens",
      match: { model: "gpt-4.1" },
      price: { type: "unit" as const, components: [{ property: null, rate: "2", per: 1 }] },
      cost: null,
    },
  ],
}

/** A caller with `role` whose card refuses every publish with `rejection`. */
function callerAs(role: WorkspaceRole, rejection: RateCardRejection) {
  const published: unknown[] = []
  const ctx = {
    project: { id: "proj_1" },
    verifyRole: (roles: WorkspaceRole[]) => {
      if (!roles.includes(role)) throw new TRPCError({ code: "FORBIDDEN", message: "forbidden" })
    },
    services: {
      features: { listFeaturesByProject: async () => Ok([]) },
      rateCards: {
        publishRows: async (publish: { drafts: unknown[] }) => {
          published.push(publish.drafts)
          return Err(new UnPriceRateCardError(rejection))
        },
      },
    },
  } as unknown as Context
  const router = initTRPC.context<Context>().create().router({ publishRows })
  return { caller: router.createCaller(ctx), published }
}

describe("rateCards.publishRows", () => {
  it("forbids a MEMBER before anything is published", async () => {
    const { caller, published } = callerAs("MEMBER", { code: "CARD_NOT_FOUND", cardId: "rc_1" })

    await expect(caller.publishRows(input)).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(published).toEqual([])
  })

  it("hands the rows to close to the same publish", async () => {
    const closed: unknown[] = []
    const ctx = {
      project: { id: "proj_1" },
      verifyRole: () => undefined,
      services: {
        features: { listFeaturesByProject: async () => Ok([]) },
        rateCards: {
          publishRows: async (publish: { closeRowIds?: readonly string[] }) => {
            closed.push(publish.closeRowIds)
            return Ok({ inserted: [], closed: [], unchanged: 0 })
          },
        },
      },
    } as unknown as Context
    const router = initTRPC.context<Context>().create().router({ publishRows })

    await router.createCaller(ctx).publishRows({ ...input, closeRowIds: ["rr_old"] })

    expect(closed).toEqual([["rr_old"]])
  })

  it("maps each rejection to its tRPC code and keeps the violations in the message", async () => {
    const violation = {
      code: "OVERLAPPING_ROWS" as const,
      feature: "llm_tokens",
      rowIds: ["rr_1", "rr_2"] as const,
    }
    const cases: [RateCardRejection, string][] = [
      [{ code: "CARD_NOT_FOUND", cardId: "rc_1" }, "NOT_FOUND"],
      [{ code: "NOTICE_TOO_SHORT", featureSlug: "llm_tokens", earliest: 0 }, "BAD_REQUEST"],
      [{ code: "SCHEDULE_CONFLICT", featureSlug: "llm_tokens", scheduledFrom: 0 }, "CONFLICT"],
      [{ code: "INVALID_CARD", violations: [violation] }, "BAD_REQUEST"],
      [
        { code: "FEATURE_NOT_PRICEABLE", features: [{ slug: "llm_tokens", reason: "slug: x" }] },
        "BAD_REQUEST",
      ],
    ]

    const codes = []
    for (const [rejection] of cases) {
      const error = await callerAs("ADMIN", rejection)
        .caller.publishRows(input)
        .catch((caught: TRPCError) => caught)
      codes.push((error as TRPCError).code)
    }
    const invalid = await callerAs("OWNER", { code: "INVALID_CARD", violations: [violation] })
      .caller.publishRows(input)
      .catch((caught: TRPCError) => caught.message)

    expect(codes).toEqual(cases.map(([, code]) => code))
    expect(invalid).toBe(
      'The card would be invalid: [{"code":"OVERLAPPING_ROWS","feature":"llm_tokens","rowIds":["rr_1","rr_2"]}]'
    )
  })
})
