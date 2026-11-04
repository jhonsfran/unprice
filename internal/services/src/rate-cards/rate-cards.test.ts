import { type ModelRate, type RateRow, rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { CARD_FROM, features, modelCosts, usdCard, usdCardWithFallback } from "../pricing/fixtures"
import { catalogCosts, changedCosts } from "./model-costs"
import { RATE_CHANGE_NOTICE_MS, featurePricingOf, planClose, planPublish } from "./publish"
import { canonicalJson, toWire } from "./wire"

const NOW = CARD_FROM + 60_000

describe("toWire", () => {
  it("formats amounts so every fixture row parses back to itself", () => {
    const emails = usdCard.rows.find((row) => row.id === "row_emails")

    expect(toWire(emails?.price)).toEqual({
      type: "package",
      property: "emails",
      size: 1000,
      rate: "1",
    })
    expect(usdCard.rows.map((row) => rateRowSchema.parse(toWire(row)))).toEqual(usdCard.rows)
  })

  it("sorts keys at every depth", () => {
    expect(canonicalJson({ b: [{ z: BigInt(150_000_000), a: null }], a: "x" })).toBe(
      '{"a":"x","b":[{"a":null,"z":"1.5"}]}'
    )
  })
})

describe("planPublish", () => {
  const card = usdCard.card
  const open = usdCard.rows.filter((row) => row.id === "row_gpt41")
  const draft = (output: string) => {
    const row = open[0]
    if (!row || row.price.type !== "unit") throw new Error("fixture changed")
    const components = row.price.components.map((component) =>
      component.property === "output_tokens"
        ? { ...component, rate: BigInt(Number(output) * 100_000_000) }
        : component
    )
    return {
      featureSlug: row.featureSlug,
      match: row.match,
      price: { type: "unit" as const, components },
      cost: row.cost,
      source: "manual" as const,
      sourceRef: null,
    }
  }
  const plan = (drafts: ReturnType<typeof draft>[], effectiveFrom: number) =>
    planPublish({
      card,
      rows: open,
      drafts,
      effectiveFrom,
      now: NOW,
      features: [features.llmTokens],
      newRowId: () => "row_new",
    })

  it("closes the open row where its successor starts", () => {
    const result = plan([draft("6")], NOW + RATE_CHANGE_NOTICE_MS)

    expect(result.val?.closes).toEqual([
      { rowId: "row_gpt41", effectiveTo: NOW + RATE_CHANGE_NOTICE_MS },
    ])
    expect(result.val?.inserts.map((row) => [row.id, row.effectiveFrom, row.effectiveTo])).toEqual([
      ["row_new", NOW + RATE_CHANGE_NOTICE_MS, null],
    ])
  })

  it("counts a draft equal to its open row as unchanged, at any start", () => {
    expect(plan([draft("8")], NOW).val).toEqual({ closes: [], inserts: [], unchanged: 1 })
  })

  it("refuses a change one millisecond inside the notice", () => {
    expect(plan([draft("6")], NOW + RATE_CHANGE_NOTICE_MS - 1).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + RATE_CHANGE_NOTICE_MS,
    })
  })

  it("publishes past rows of a deleted feature and an unchanged retry past stale dimensions", () => {
    const regrouped = { ...features.llmTokens, dimensions: ["model_id"] }
    const change = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("6")],
      effectiveFrom: NOW + RATE_CHANGE_NOTICE_MS,
      now: NOW,
      features: [features.llmTokens],
      newRowId: () => "row_new",
    })
    const retry = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("8")],
      effectiveFrom: NOW,
      now: NOW,
      features: [regrouped],
      newRowId: () => "row_new",
    })
    const staleInsert = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("6")],
      effectiveFrom: NOW + RATE_CHANGE_NOTICE_MS,
      now: NOW,
      features: [regrouped],
      newRowId: () => "row_new",
    })

    expect(change.val?.closes).toEqual([
      { rowId: "row_gpt41", effectiveTo: NOW + RATE_CHANGE_NOTICE_MS },
    ])
    expect(retry.val).toEqual({ closes: [], inserts: [], unchanged: 1 })
    expect(staleInsert.err?.rejection).toEqual({
      code: "INVALID_CARD",
      violations: [{ code: "UNKNOWN_DIMENSION", rowId: "row_new", key: "model" }],
    })
  })

  it("publishes a regrouped feature's first row where its retired rows end", () => {
    const retireAt = NOW + RATE_CHANGE_NOTICE_MS
    const retired = usdCard.rows
      .filter((row) => row.featureSlug === "llm_tokens")
      .map((row) => ({ ...row, effectiveTo: retireAt }))
    const regrouped = { ...features.llmTokens, dimensions: ["model_id"] }
    const first = draft("6")

    const result = planPublish({
      card,
      rows: retired,
      drafts: [{ ...first, match: { model_id: "gpt-5" } }],
      effectiveFrom: retireAt,
      now: NOW,
      features: [regrouped],
      newRowId: () => "row_gpt5",
    })

    expect(result.val?.inserts.map((row) => [row.id, row.match, row.effectiveFrom])).toEqual([
      ["row_gpt5", { model_id: "gpt-5" }, retireAt],
    ])
  })

  it("gives a new row the notice once the card has any row, even an ended one", () => {
    const fallback = usdCardWithFallback.rows.filter((row) => row.id === "row_tokens_default")
    const gpt5 = { ...draft("6"), match: { model: "gpt-5" } }
    const publish = (rows: typeof fallback, effectiveFrom: number) =>
      planPublish({
        card,
        rows,
        drafts: [gpt5],
        effectiveFrom,
        now: NOW,
        features: [features.llmTokens],
        newRowId: () => "row_gpt5",
      })
    const ended = fallback.map((row) => ({ ...row, effectiveTo: NOW }))

    expect(publish(fallback, NOW).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + RATE_CHANGE_NOTICE_MS,
    })
    expect(publish(fallback, NOW + RATE_CHANGE_NOTICE_MS).val?.inserts.length).toBe(1)
    expect(publish([], NOW).val?.inserts.map((row) => row.effectiveFrom)).toEqual([NOW])
    expect(publish(ended, NOW).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + RATE_CHANGE_NOTICE_MS,
    })
    expect(publish(ended, NOW + RATE_CHANGE_NOTICE_MS).val?.inserts.length).toBe(1)
  })

  describe("regrouping a feature in one publish", () => {
    const regrouped = { ...features.llmTokens, dimensions: ["model_id"] }
    const stale = usdCard.rows.filter((row) => row.featureSlug === "llm_tokens")
    const staleIds = stale.map((row) => row.id)
    const gpt5 = { ...draft("6"), match: { model_id: "gpt-5" } }
    const regroup = (
      rows: readonly RateRow[],
      closeRowIds: readonly string[] | undefined,
      effectiveFrom: number,
      now = NOW
    ) =>
      planPublish({
        card,
        rows,
        drafts: [gpt5],
        closeRowIds,
        effectiveFrom,
        now,
        features: [regrouped],
        newRowId: () => "row_gpt5",
      })
    const at = NOW + RATE_CHANGE_NOTICE_MS

    it("ends the old rows exactly where the new ones start", () => {
      const result = regroup(stale, staleIds, at)

      expect(result.val?.closes).toEqual(staleIds.map((rowId) => ({ rowId, effectiveTo: at })))
      expect(result.val?.inserts.map((row) => [row.id, row.match, row.effectiveFrom])).toEqual([
        ["row_gpt5", { model_id: "gpt-5" }, at],
      ])
    })

    it("refuses the new rows while the old ones stay open", () => {
      expect(regroup(stale, undefined, at).err?.rejection).toEqual({
        code: "INVALID_CARD",
        violations: [
          { code: "MIXED_MATCH_KEYS", feature: "llm_tokens", keySets: ["model", "model_id"] },
        ],
      })
    })

    it("writes nothing on a retry, even once the notice has passed", () => {
      const done = regroup(stale, staleIds, at)
      if (done.err) throw done.err
      const rows = [...stale.map((row) => ({ ...row, effectiveTo: at })), ...done.val.inserts]

      expect(regroup(rows, staleIds, at, at - 1).val).toEqual({
        closes: [],
        inserts: [],
        unchanged: 4,
      })
    })

    it("gives the ends the notice and refuses a row it cannot end", () => {
      expect(regroup(stale, staleIds, at - 1).err?.rejection).toEqual({
        code: "NOTICE_TOO_SHORT",
        featureSlug: "llm_tokens",
        earliest: at,
      })
      expect(regroup(stale, ["row_gpt41", "row_x"], at).err?.rejection).toEqual({
        code: "ROW_NOT_FOUND",
        rowIds: ["row_x"],
      })
    })
  })

  it("names why a feature the pricing core cannot read is refused", () => {
    const meterConfig = {
      eventId: "evt_1",
      eventSlug: "tokens",
      aggregationMethod: "sum" as const,
      aggregationField: "#tokens",
      groupBy: ["model"],
    }
    const parsed = featurePricingOf({ slug: "llm_tokens", meterConfig })
    const unpriceable = parsed.ok ? [] : [parsed.unpriceable]

    const result = planPublish({
      card,
      rows: [],
      drafts: [draft("6")],
      effectiveFrom: NOW,
      now: NOW,
      features: [],
      unpriceable,
      newRowId: () => "row_new",
    })

    expect(result.err?.rejection).toEqual({
      code: "FEATURE_NOT_PRICEABLE",
      features: [
        {
          slug: "llm_tokens",
          reason: "meter aggregationField: a property name that does not start with #",
        },
      ],
    })
  })
})

describe("planClose", () => {
  const open = usdCard.rows.filter((row) => row.featureSlug === "llm_tokens")
  const closeAt = NOW + RATE_CHANGE_NOTICE_MS
  const close = (rows: typeof open, rowIds: string[], effectiveTo: number) =>
    planClose({ rows, rowIds, effectiveTo, now: NOW })

  it("closes open rows and counts a row already closed at that time as unchanged", () => {
    const first = close(open, ["row_gpt41", "row_gpt41_mini", "row_gpt41"], closeAt)
    const closed = open.map((row) =>
      row.id === "row_gpt41" ? { ...row, effectiveTo: closeAt } : row
    )
    const retry = close(closed, ["row_gpt41", "row_gpt41_mini"], closeAt)

    expect(first.val).toEqual({
      closes: [
        { rowId: "row_gpt41", effectiveTo: closeAt },
        { rowId: "row_gpt41_mini", effectiveTo: closeAt },
      ],
      unchanged: 0,
    })
    expect(retry.val).toEqual({
      closes: [{ rowId: "row_gpt41_mini", effectiveTo: closeAt }],
      unchanged: 1,
    })
  })

  it("refuses a close inside the notice, before a row starts, or of a row it cannot close", () => {
    const scheduled = open.map((row) =>
      row.id === "row_gpt41" ? { ...row, effectiveFrom: closeAt + 5 } : row
    )
    const endedEarlier = open.map((row) =>
      row.id === "row_gpt41" ? { ...row, effectiveTo: closeAt + 1 } : row
    )

    expect(close(open, ["row_gpt41"], closeAt - 1).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: closeAt,
    })
    expect(close(scheduled, ["row_gpt41"], closeAt + 5).err?.rejection).toEqual({
      code: "SCHEDULE_CONFLICT",
      featureSlug: "llm_tokens",
      scheduledFrom: closeAt + 5,
    })
    expect(close(endedEarlier, ["row_gpt41"], closeAt).err?.rejection).toEqual({
      code: "ROW_CLOSED",
      rowId: "row_gpt41",
      effectiveTo: closeAt + 1,
    })
    expect(close(open, ["row_gpt41", "row_x", "row_y"], closeAt).err?.rejection).toEqual({
      code: "ROW_NOT_FOUND",
      rowIds: ["row_x", "row_y"],
    })
  })
})

describe("featurePricingOf", () => {
  it("reads dimensions and the metered property from the meter", () => {
    const meterConfig = {
      eventId: "evt_1",
      eventSlug: "tokens",
      aggregationMethod: "sum" as const,
      aggregationField: "input_tokens",
      groupBy: ["model"],
    }

    expect(featurePricingOf({ slug: "llm_tokens", meterConfig })).toEqual({
      ok: true,
      pricing: {
        slug: "llm_tokens",
        dimensions: ["model"],
        meterProperty: "input_tokens",
        included: null,
      },
    })
    expect(featurePricingOf({ slug: "Bad Slug", meterConfig: null })).toEqual({
      ok: false,
      unpriceable: { slug: "Bad Slug", reason: "slug: a lowercase slug" },
    })
    expect(
      featurePricingOf({ slug: "llm_tokens", meterConfig: { ...meterConfig, groupBy: ["#model"] } })
    ).toEqual({
      ok: false,
      unpriceable: {
        slug: "llm_tokens",
        reason: "meter groupBy: a property name that does not start with #",
      },
    })
  })
})

describe("catalog costs", () => {
  const haiku: ModelRate = {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    unit: "money:USD",
    per: 1_000_000,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    tiers: [],
    limits: { context: 200_000, output: 64_000 },
  }

  it("maps catalog rates to cost components and keeps only changed models", () => {
    const [cost] = catalogCosts([haiku], "2026-10-20", NOW)
    const repriced = catalogCosts([{ ...haiku, rates: { ...haiku.rates, input: 0.8 } }], "v2", NOW)

    expect(cost && toWire(cost)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      components: { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
      effectiveFrom: NOW,
      source: "modelsdev",
      sourceRef: "2026-10-20",
    })
    expect(changedCosts(cost ? [cost, modelCosts.gpt41] : [], repriced)).toEqual(repriced)
    expect(changedCosts(repriced, repriced)).toEqual([])
  })
})
