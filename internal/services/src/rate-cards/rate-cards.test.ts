import { type ModelRate, type RateRow, rateRowSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { CARD_FROM, features, modelCosts, usdCard, usdCardWithFallback } from "../pricing/fixtures"
import { catalogCosts, changedCosts } from "./model-costs"
import {
  RATE_CHANGE_NOTICE_MS,
  featurePricingOf,
  planClose,
  planFeaturePricing,
  planPublish,
  planVersionViolations,
  unionFeaturePricing,
} from "./publish"
import { canonicalJson, toWire } from "./wire"

const NOW = CARD_FROM + 60_000
const NOTICE = RATE_CHANGE_NOTICE_MS

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
  const plan = (
    drafts: ReturnType<typeof draft>[],
    effectiveFrom: number | undefined,
    noticeMs = NOTICE
  ) =>
    planPublish({
      card,
      rows: open,
      drafts,
      effectiveFrom,
      now: NOW,
      noticeMs,
      features: [features.llmTokens],
      newRowId: () => "row_new",
    })

  it("closes the open row where its successor starts", () => {
    const result = plan([draft("6")], NOW + NOTICE)

    expect(result.val?.closes).toEqual([{ rowId: "row_gpt41", effectiveTo: NOW + NOTICE }])
    expect(result.val?.inserts.map((row) => [row.id, row.effectiveFrom, row.effectiveTo])).toEqual([
      ["row_new", NOW + NOTICE, null],
    ])
  })

  it("counts a draft equal to its open row as unchanged, at any start", () => {
    expect(plan([draft("8")], NOW).val).toEqual({
      effectiveFrom: NOW,
      closes: [],
      inserts: [],
      unchanged: 1,
    })
  })

  it("refuses a change one millisecond inside the notice", () => {
    expect(plan([draft("6")], NOW + NOTICE - 1).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + NOTICE,
    })
  })

  it("starts a change at once on a card no published version prices with", () => {
    const result = plan([draft("6")], NOW, 0)

    expect(result.val?.closes).toEqual([{ rowId: "row_gpt41", effectiveTo: NOW }])
    expect(result.val?.inserts.map((row) => row.effectiveFrom)).toEqual([NOW])
    expect(plan([draft("6")], NOW - 1, 0).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW,
    })
  })

  it("starts at the earliest the card allows when no start is given", () => {
    const live = plan([draft("6")], undefined)
    const draftOnly = plan([draft("6")], undefined, 0)

    expect([
      live.val?.effectiveFrom,
      live.val?.closes,
      live.val?.inserts[0]?.effectiveFrom,
    ]).toEqual([NOW + NOTICE, [{ rowId: "row_gpt41", effectiveTo: NOW + NOTICE }], NOW + NOTICE])
    expect([draftOnly.val?.effectiveFrom, draftOnly.val?.inserts[0]?.effectiveFrom]).toEqual([
      NOW,
      NOW,
    ])
  })

  it("publishes past rows of a deleted feature and an unchanged retry past stale dimensions", () => {
    const regrouped = { ...features.llmTokens, dimensions: ["model_id"] }
    const change = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("6")],
      effectiveFrom: NOW + NOTICE,
      now: NOW,
      noticeMs: NOTICE,
      features: [features.llmTokens],
      newRowId: () => "row_new",
    })
    const retry = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("8")],
      effectiveFrom: NOW,
      now: NOW,
      noticeMs: NOTICE,
      features: [regrouped],
      newRowId: () => "row_new",
    })
    const staleInsert = planPublish({
      card,
      rows: usdCard.rows,
      drafts: [draft("6")],
      effectiveFrom: NOW + NOTICE,
      now: NOW,
      noticeMs: NOTICE,
      features: [regrouped],
      newRowId: () => "row_new",
    })

    expect(change.val?.closes).toEqual([{ rowId: "row_gpt41", effectiveTo: NOW + NOTICE }])
    expect(retry.val).toEqual({ effectiveFrom: NOW, closes: [], inserts: [], unchanged: 1 })
    expect(staleInsert.err?.rejection).toEqual({
      code: "INVALID_CARD",
      violations: [{ code: "UNKNOWN_DIMENSION", rowId: "row_new", key: "model" }],
    })
  })

  it("publishes a regrouped feature's first row where its retired rows end", () => {
    const retireAt = NOW + NOTICE
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
      noticeMs: NOTICE,
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
        noticeMs: NOTICE,
        features: [features.llmTokens],
        newRowId: () => "row_gpt5",
      })
    const ended = fallback.map((row) => ({ ...row, effectiveTo: NOW }))

    expect(publish(fallback, NOW).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + NOTICE,
    })
    expect(publish(fallback, NOW + NOTICE).val?.inserts.length).toBe(1)
    expect(publish([], NOW).val?.inserts.map((row) => row.effectiveFrom)).toEqual([NOW])
    expect(publish(ended, NOW).err?.rejection).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + NOTICE,
    })
    expect(publish(ended, NOW + NOTICE).val?.inserts.length).toBe(1)
  })

  describe("regrouping a feature in one publish", () => {
    const regrouped = { ...features.llmTokens, dimensions: ["model_id"] }
    const stale = usdCard.rows.filter((row) => row.featureSlug === "llm_tokens")
    const staleIds = stale.map((row) => row.id)
    const gpt5 = { ...draft("6"), match: { model_id: "gpt-5" } }
    const regroup = (
      rows: readonly RateRow[],
      closeRowIds: readonly string[] | undefined,
      effectiveFrom: number | undefined,
      now = NOW
    ) =>
      planPublish({
        card,
        rows,
        drafts: [gpt5],
        closeRowIds,
        effectiveFrom,
        now,
        noticeMs: NOTICE,
        features: [regrouped],
        newRowId: () => "row_gpt5",
      })
    const at = NOW + NOTICE

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
        effectiveFrom: at,
        closes: [],
        inserts: [],
        unchanged: 4,
      })
    })

    it("counts a named row that already ended as unchanged when no start is given", () => {
      const done = regroup(stale, staleIds, at)
      if (done.err) throw done.err
      const rows = [...stale.map((row) => ({ ...row, effectiveTo: at })), ...done.val.inserts]

      expect(regroup(rows, staleIds, undefined, at + 1).val).toEqual({
        effectiveFrom: at + 1 + NOTICE,
        closes: [],
        inserts: [],
        unchanged: 4,
      })
      expect(regroup(rows, staleIds, at + 1 + NOTICE, at + 1).err?.rejection).toEqual({
        code: "ROW_CLOSED",
        rowId: "row_gpt41",
        effectiveTo: at,
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
      noticeMs: NOTICE,
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
  const closeAt = NOW + NOTICE
  const close = (
    rows: typeof open,
    rowIds: string[],
    effectiveTo: number | undefined,
    noticeMs = NOTICE
  ) => planClose({ rows, rowIds, effectiveTo, now: NOW, noticeMs })

  it("closes open rows and counts a row already closed at that time as unchanged", () => {
    const first = close(open, ["row_gpt41", "row_gpt41_mini", "row_gpt41"], closeAt)
    const closed = open.map((row) =>
      row.id === "row_gpt41" ? { ...row, effectiveTo: closeAt } : row
    )
    const retry = close(closed, ["row_gpt41", "row_gpt41_mini"], closeAt)

    expect(first.val).toEqual({
      effectiveTo: closeAt,
      closes: [
        { rowId: "row_gpt41", effectiveTo: closeAt },
        { rowId: "row_gpt41_mini", effectiveTo: closeAt },
      ],
      unchanged: 0,
    })
    expect(retry.val).toEqual({
      effectiveTo: closeAt,
      closes: [{ rowId: "row_gpt41_mini", effectiveTo: closeAt }],
      unchanged: 1,
    })
  })

  it("ends at the earliest the card allows when no end is given, and a retry writes nothing", () => {
    const live = close(open, ["row_gpt41"], undefined)
    const draftOnly = close(open, ["row_gpt41"], undefined, 0)
    const ended = open.map((row) =>
      row.id === "row_gpt41" ? { ...row, effectiveTo: closeAt } : row
    )
    const retry = close(ended, ["row_gpt41"], undefined)
    const moved = close(ended, ["row_gpt41"], closeAt + 1)

    expect(live.val).toEqual({
      effectiveTo: closeAt,
      closes: [{ rowId: "row_gpt41", effectiveTo: closeAt }],
      unchanged: 0,
    })
    expect(draftOnly.val).toEqual({
      effectiveTo: NOW,
      closes: [{ rowId: "row_gpt41", effectiveTo: NOW }],
      unchanged: 0,
    })
    expect(retry.val).toEqual({ effectiveTo: closeAt, closes: [], unchanged: 1 })
    expect(moved.err?.rejection).toEqual({
      code: "ROW_CLOSED",
      rowId: "row_gpt41",
      effectiveTo: closeAt,
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
    expect(
      featurePricingOf({
        slug: "images",
        meterConfig: { ...meterConfig, aggregationMethod: "count", aggregationField: "ignored" },
      })
    ).toEqual({
      ok: true,
      pricing: { slug: "images", dimensions: ["model"], meterProperty: null, included: null },
    })
    expect(featurePricingOf({ slug: "Bad Slug", meterConfig: null })).toEqual({
      ok: false,
      unpriceable: {
        slug: "Bad Slug",
        reason:
          "slug: a lowercase slug: letters, digits, - and _, starting with a letter or digit, at most 64 characters",
      },
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

describe("planFeaturePricing", () => {
  const meterConfig = {
    eventId: "evt_1",
    eventSlug: "calls",
    aggregationMethod: "sum" as const,
    aggregationField: "calls",
  }

  it("reads the plan feature's own meter snapshot and included units", () => {
    expect(
      planFeaturePricing({ feature: { slug: "api_calls" }, meterConfig, included: "1000" })
    ).toEqual({ ok: true, pricing: features.apiCallsIncluded })
    expect(planFeaturePricing({ feature: { slug: "base_fee" }, meterConfig: null })).toEqual({
      ok: true,
      pricing: features.baseFee,
    })
  })

  it("unions the versions assigned to a card and refuses a feature they describe differently", () => {
    const v1 = planFeaturePricing({
      feature: { slug: "llm_tokens" },
      meterConfig: { ...meterConfig, aggregationMethod: "count", groupBy: ["model"] },
    })
    const v2 = planFeaturePricing({
      feature: { slug: "llm_tokens" },
      meterConfig: { ...meterConfig, aggregationMethod: "count" },
    })
    const calls = planFeaturePricing({ feature: { slug: "api_calls" }, meterConfig })
    const callsIncluded = planFeaturePricing({
      feature: { slug: "api_calls" },
      meterConfig,
      included: "1000",
    })

    expect(unionFeaturePricing([v1, v1, calls, callsIncluded])).toEqual({
      features: [features.llmTokens, features.apiCallsIncluded],
      unpriceable: [],
    })
    expect(unionFeaturePricing([v1, v2])).toEqual({
      features: [],
      unpriceable: [{ slug: "llm_tokens", reason: "versions disagree on dimensions" }],
    })
    expect(
      unionFeaturePricing([
        calls,
        planFeaturePricing({
          feature: { slug: "api_calls" },
          meterConfig: { ...meterConfig, aggregationField: "requests" },
        }),
      ]).unpriceable
    ).toEqual([{ slug: "api_calls", reason: "versions disagree on meter property" }])
  })
})

describe("planVersionViolations", () => {
  const tokensMeter = {
    eventId: "evt_1",
    eventSlug: "tokens",
    aggregationMethod: "count" as const,
    groupBy: ["model"],
  }

  it("checks only the version's features, each through its own meter snapshot", () => {
    const baseFee = { feature: { slug: "base_fee" }, meterConfig: null }
    const regrouped = {
      feature: { slug: "llm_tokens" },
      meterConfig: { ...tokensMeter, groupBy: ["model_id"] },
    }

    const violations = planVersionViolations(usdCard.card, usdCard.rows, [regrouped, baseFee])
    const fits = planVersionViolations(usdCard.card, usdCard.rows, [
      { ...regrouped, meterConfig: tokensMeter },
      baseFee,
    ])

    expect(violations.map((violation) => [violation.feature, violation.code])).toEqual([
      ["llm_tokens", "UNKNOWN_DIMENSION"],
      ["llm_tokens", "UNKNOWN_DIMENSION"],
      ["llm_tokens", "UNKNOWN_DIMENSION"],
    ])
    expect(fits).toEqual([])
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
