import { type RateRowInput, rateCardSchema, rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { CARD_FROM, features, usdCard } from "./fixtures"
import type { CardRows } from "./model"
import { resolveRow } from "./resolve"

const at = CARD_FROM + 1_000

function card(id: string, rows: readonly Partial<RateRowInput>[]): CardRows {
  return {
    card: rateCardSchema.parse({
      id,
      projectId: "proj_fixture",
      name: id,
      unit: "money:USD",
      marginPolicy: { type: "manual" },
    }),
    rows: rows.map((row) =>
      rateRowSchema.parse({
        id: "row",
        rateCardId: id,
        featureSlug: "llm_tokens",
        match: {},
        price: { type: "unit", components: [{ property: "input_tokens", rate: "1", per: 1 }] },
        cost: null,
        effectiveFrom: CARD_FROM,
        effectiveTo: null,
        source: "manual",
        sourceRef: null,
        ...row,
      })
    ),
  }
}

function resolved(cards: Parameters<typeof resolveRow>[0], model: unknown, when = at) {
  const result = resolveRow(cards, features.llmTokens, { model }, when)
  return result.err ? result.err.rejection : `${result.val.card.id}/${result.val.row.id}`
}

describe("resolveRow", () => {
  const base = card("base", [
    { id: "base_gpt", match: { model: "gpt-4.1" } },
    { id: "base_default", match: {} },
  ])
  const overlay = card("overlay", [
    { id: "overlay_claude", match: { model: "claude-sonnet-4" } },
    { id: "overlay_default", match: {} },
  ])

  it("orders overlay exact, base exact, overlay default, base default", () => {
    expect(resolved({ base, overlay }, "claude-sonnet-4")).toBe("overlay/overlay_claude")
    expect(resolved({ base, overlay }, "gpt-4.1")).toBe("base/base_gpt")
    expect(resolved({ base, overlay }, "gpt-5")).toBe("overlay/overlay_default")
    expect(resolved({ base }, "gpt-5")).toBe("base/base_default")
  })

  it("matches dimension values by their string form", () => {
    const sized = card("sized", [
      { id: "size_1024", featureSlug: "images", match: { size: "1024" } },
    ])
    const result = resolveRow({ base: sized }, features.images, { size: 1024 }, at)
    expect(result.val?.row.id).toBe("size_1024")
  })

  it("uses only rows effective at the usage time, end exclusive", () => {
    const end = CARD_FROM + 10_000
    const dated = card("dated", [
      { id: "old", match: { model: "gpt-4.1" }, effectiveTo: end },
      { id: "new", match: { model: "gpt-4.1" }, effectiveFrom: end },
    ])
    expect(resolved({ base: dated }, "gpt-4.1", end - 1)).toBe("dated/old")
    expect(resolved({ base: dated }, "gpt-4.1", end)).toBe("dated/new")
    expect(resolved({ base: dated }, "gpt-4.1", CARD_FROM - 1)).toEqual({
      code: "NOT_PRICED",
      feature: "llm_tokens",
      match: { model: "gpt-4.1" },
    })
  })

  it("never resolves a flat row for usage", () => {
    const result = resolveRow({ base: usdCard }, features.baseFee, {}, at)
    expect(result.err?.rejection).toEqual({ code: "NOT_PRICED", feature: "base_fee", match: {} })
  })

  it("does not match an exact row when the dimension is missing", () => {
    const exactOnly = card("exact", [{ id: "gpt", match: { model: "gpt-4.1" } }])
    expect(resolved({ base: exactOnly }, undefined)).toEqual({
      code: "NOT_PRICED",
      feature: "llm_tokens",
      match: {},
    })
  })
})
