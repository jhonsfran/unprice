import { initTRPC } from "@trpc/server"
import { Ok } from "@unprice/error"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Context } from "#trpc"

vi.mock("#trpc", async () => {
  const { initTRPC } = await import("@trpc/server")
  return { protectedProjectProcedure: initTRPC.create().procedure }
})

import { previewCostPlus } from "./previewCostPlus"

const NOW = 1_796_083_200_000

afterEach(() => {
  vi.useRealTimers()
})

describe("rateCards.previewCostPlus", () => {
  it("previews at the requested time, and gives a publishable hash only for a preview at now", async () => {
    vi.useFakeTimers({ now: NOW })
    const calls: unknown[][] = []
    const ctx = {
      project: { id: "proj_1" },
      services: {
        rateCards: {
          previewCostPlus: async (...args: unknown[]) => {
            calls.push(args)
            return Ok({ draft: { cardId: "rc_1", at: args[2], changes: [] }, draftHash: "h" })
          },
        },
      },
    } as unknown as Context
    const router = initTRPC.context<Context>().create().router({ previewCostPlus })

    const whatIf = await router
      .createCaller(ctx)
      .previewCostPlus({ cardId: "rc_1", at: NOW + 3_600_000, featureSlug: "ai" })
    const current = await router.createCaller(ctx).previewCostPlus({ cardId: "rc_1" })

    expect(calls).toEqual([
      ["proj_1", "rc_1", NOW + 3_600_000, { featureSlug: "ai" }],
      ["proj_1", "rc_1", NOW, { featureSlug: undefined }],
    ])
    expect(whatIf).toEqual({
      draft: { cardId: "rc_1", at: NOW + 3_600_000, changes: [] },
      draftHash: null,
    })
    expect(current).toEqual({ draft: { cardId: "rc_1", at: NOW, changes: [] }, draftHash: "h" })
  })
})
