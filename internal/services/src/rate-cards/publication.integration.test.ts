import { eq } from "@unprice/db"
import {
  features as featuresTable,
  planVersionFeatures as planVersionFeaturesTable,
  versions as versionsTable,
} from "@unprice/db/schema"
import { type MeterConfig, type RateRowDraft, rateRowDraftSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { publishRateRows } from "../use-cases/rate-cards"
import {
  LIVE_VERSION,
  MINUTE,
  NOW,
  TOKENS_METER,
  createRateCardIntegrationFixture,
  gpt41,
  intervals,
  planFeature,
  projectId,
  rejection,
  value,
} from "./service.integration.fixture"

describe("RateCardService publication", () => {
  const { db, rateCards, services, createCard, liveCard, publish, cardRows } =
    createRateCardIntegrationFixture()

  it("gives a change the notice only once a published version prices with the card", async () => {
    const card = await liveCard([planFeature("fv_live_tokens", "ft_llm_tokens", TOKENS_METER, 3)])
    await db
      .update(versionsTable)
      .set({ publishedAt: null })
      .where(eq(versionsTable.id, LIVE_VERSION))
    const unscheduled = (rows: RateRowDraft[], now: number) =>
      publishRateRows({ services }, { projectId, cardId: card.id, rows, now })
    const close = (rowId: string, now: number) =>
      rateCards.closeRows({ projectId, cardId: card.id, rowIds: [rowId], now })

    const first = await value(unscheduled([gpt41("2.00", "8.00")], NOW))
    const draftChange = await value(unscheduled([gpt41("2.00", "7.00")], NOW + MINUTE))
    await db
      .update(versionsTable)
      .set({ status: "published", publishedAt: NOW + 2 * MINUTE })
      .where(eq(versionsTable.id, LIVE_VERSION))
    const liveEarly = await rejection(
      publish(card.id, [gpt41("2.00", "6.00")], NOW + 4 * MINUTE, NOW + 3 * MINUTE)
    )
    const liveChange = await value(unscheduled([gpt41("2.00", "6.00")], NOW + 3 * MINUTE))
    const [open] = liveChange.inserted
    const liveClose = await value(close(open?.id ?? "", NOW + 4 * MINUTE))
    const closeRetry = await value(close(open?.id ?? "", NOW + 5 * MINUTE))

    expect([first.inserted[0]?.effectiveFrom, draftChange.inserted[0]?.effectiveFrom]).toEqual([
      NOW,
      NOW + MINUTE,
    ])
    expect(liveEarly).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + 13 * MINUTE,
    })
    expect(liveChange.inserted[0]?.effectiveFrom).toBe(NOW + 13 * MINUTE)
    expect(liveClose).toEqual({
      closed: [{ rowId: open?.id, effectiveTo: NOW + 14 * MINUTE }],
      unchanged: 0,
    })
    expect(closeRetry).toEqual({ closed: [], unchanged: 1 })
    expect(await rateCards.isLive(projectId, card.id)).toBe(true)
    expect(intervals(await cardRows(card.id)).map(([from, to]) => [from, to])).toEqual([
      [0, MINUTE],
      [MINUTE, 13 * MINUTE],
      [13 * MINUTE, 14 * MINUTE],
    ])
  })

  it("checks a card's rows against the plan features of the versions that price with it", async () => {
    await db
      .update(featuresTable)
      .set({ meterConfig: { ...TOKENS_METER, groupBy: [] } })
      .where(eq(featuresTable.id, "ft_llm_tokens"))
    const unassignedCard = await createCard({ type: "manual" }, "Unassigned")
    const unassigned = await rejection(publish(unassignedCard.id, [gpt41("2.00", "8.00")], NOW))
    const card = await liveCard([planFeature("fv_live_tokens", "ft_llm_tokens", TOKENS_METER, 3)])

    const assigned = await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))
    await db
      .update(planVersionFeaturesTable)
      .set({ meterConfig: { ...TOKENS_METER, groupBy: [] } })
      .where(eq(planVersionFeaturesTable.id, "fv_live_tokens"))
    const regrouped = await rejection(
      publish(card.id, [{ ...gpt41("2.00", "8.00"), match: { model: "gpt-5" } }], NOW + 10 * MINUTE)
    )
    const pricing = await rateCards.featuresPricingWith(projectId, card.id)

    expect(unassigned).toMatchObject({
      code: "INVALID_CARD",
      violations: [{ code: "UNKNOWN_DIMENSION", key: "model" }],
    })
    expect(assigned.inserted.map((row) => row.match)).toEqual([{ model: "gpt-4.1" }])
    expect(regrouped).toMatchObject({
      code: "INVALID_CARD",
      violations: [{ code: "UNKNOWN_DIMENSION", key: "model" }],
    })
    expect(pricing?.features.sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: "access-pro", dimensions: [], meterProperty: null, included: null },
      { slug: "events", dimensions: [], meterProperty: "events", included: null },
      { slug: "llm_tokens", dimensions: [], meterProperty: "input_tokens", included: null },
    ])
    expect(await rateCards.featuresPricingWith(projectId, unassignedCard.id)).toBeNull()
  })

  it("refuses a price change inside the notice and closes the old row at a change after it", async () => {
    const card = await liveCard([planFeature("fv_live_tokens", "ft_llm_tokens", TOKENS_METER, 3)])
    await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))

    const early = await rejection(publish(card.id, [gpt41("2.00", "6.00")], NOW + 5 * MINUTE))
    const afterEarly = intervals(await cardRows(card.id))
    const change = await value(publish(card.id, [gpt41("2.00", "6.00")], NOW + 10 * MINUTE))
    const spanning = await rateCards.getEffectiveRows({
      projectId,
      cardIds: [card.id],
      from: NOW,
      to: NOW + 20 * MINUTE,
    })
    const before = await rateCards.getEffectiveRows({
      projectId,
      cardIds: [card.id],
      from: NOW,
      to: NOW + 10 * MINUTE,
    })

    expect(early).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + 10 * MINUTE,
    })
    expect(afterEarly).toEqual([[0, null, ["2", "8"]]])
    expect(change.closed.map((close) => close.effectiveTo - NOW)).toEqual([10 * MINUTE])
    expect(intervals(spanning)).toEqual([
      [0, 10 * MINUTE, ["2", "8"]],
      [10 * MINUTE, null, ["2", "6"]],
    ])
    expect(intervals(before)).toEqual([[0, 10 * MINUTE, ["2", "8"]]])
  })

  it("refuses a change before a scheduled one and chains a later change after it", async () => {
    const card = await createCard()
    await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))
    await value(publish(card.id, [gpt41("2.00", "7.00")], NOW + 60 * MINUTE))

    const earlier = await rejection(publish(card.id, [gpt41("2.00", "6.00")], NOW + 30 * MINUTE))
    await value(publish(card.id, [gpt41("2.00", "6.00")], NOW + 90 * MINUTE))

    expect(earlier).toEqual({
      code: "SCHEDULE_CONFLICT",
      featureSlug: "llm_tokens",
      scheduledFrom: NOW + 60 * MINUTE,
    })
    expect(intervals(await cardRows(card.id))).toEqual([
      [0, 60 * MINUTE, ["2", "8"]],
      [60 * MINUTE, 90 * MINUTE, ["2", "7"]],
      [90 * MINUTE, null, ["2", "6"]],
    ])
  })

  it("rejects a publish that would overlap two rows of the same specificity, writing nothing", async () => {
    const card = await createCard()

    const overlap = await rejection(
      publish(card.id, [gpt41("2.00", "8.00"), gpt41("3.00", "9.00")], NOW)
    )
    const unknown = await rejection(
      publish(card.id, [{ ...gpt41("2.00", "8.00"), featureSlug: "images" }], NOW)
    )

    expect(overlap).toMatchObject({
      code: "INVALID_CARD",
      violations: [{ code: "OVERLAPPING_ROWS", feature: "llm_tokens" }],
    })
    expect(unknown).toEqual({ code: "UNKNOWN_FEATURE", features: ["images"] })
    expect(await cardRows(card.id)).toEqual([])
  })

  it("writes a retried publish once, even when the retry recomputes its start", async () => {
    const card = await createCard()
    await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))
    const retriedFirst = await value(publish(card.id, [gpt41("2.00", "8.00")], NOW + MINUTE))
    await value(publish(card.id, [gpt41("2.00", "6.00")], NOW + 10 * MINUTE))
    const retriedChange = await value(
      publish(card.id, [gpt41("2.00", "6.00")], NOW + 11 * MINUTE, NOW + MINUTE)
    )

    expect([retriedFirst.inserted, retriedFirst.unchanged]).toEqual([[], 1])
    expect([retriedChange.inserted, retriedChange.unchanged]).toEqual([[], 1])
    expect(intervals(await cardRows(card.id))).toEqual([
      [0, 10 * MINUTE, ["2", "8"]],
      [10 * MINUTE, null, ["2", "6"]],
    ])
  })

  it("keeps publishing after a feature is regrouped and retires its stale rows", async () => {
    const imagesMeter: MeterConfig = {
      eventId: "evt_images",
      eventSlug: "images",
      aggregationMethod: "count",
      groupBy: ["size"],
    }
    await db.insert(featuresTable).values({
      id: "ft_images",
      projectId,
      slug: "images",
      title: "Images",
      meterConfig: imagesMeter,
    })
    const image = rateRowDraftSchema.parse({
      featureSlug: "images",
      match: { size: "1024" },
      price: { type: "unit", components: [{ property: null, rate: "0.04", per: 1 }] },
      cost: null,
    })
    const card = await liveCard([
      planFeature("fv_live_tokens", "ft_llm_tokens", TOKENS_METER, 3),
      planFeature("fv_live_images", "ft_images", imagesMeter, 4),
    ])
    const [stale] = (await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))).inserted
    await db
      .update(planVersionFeaturesTable)
      .set({ meterConfig: { ...TOKENS_METER, groupBy: ["model_id"] } })
      .where(eq(planVersionFeaturesTable.id, "fv_live_tokens"))
    const close = (effectiveTo: number, now: number) =>
      rateCards.closeRows({
        projectId,
        cardId: card.id,
        rowIds: [stale?.id ?? ""],
        effectiveTo,
        now,
      })
    // Each call stamps its own now, as the tRPC procedures do with Date.now().
    const regroup = (now: number) =>
      publishRateRows(
        { services },
        {
          projectId,
          cardId: card.id,
          rows: [{ ...gpt41("2.00", "8.00"), match: { model_id: "gpt-4.1" } }],
          closeRowIds: [stale?.id ?? ""],
          effectiveFrom: NOW + 11 * MINUTE,
          now,
        }
      )

    const images = await value(publish(card.id, [image], NOW + 10 * MINUTE))
    const early = await rejection(close(NOW + 9 * MINUTE, NOW))
    const mixed = await rejection(
      publish(
        card.id,
        [{ ...gpt41("2.00", "8.00"), match: { model_id: "gpt-4.1" } }],
        NOW + 11 * MINUTE,
        NOW + MINUTE
      )
    )
    const regrouped = await value(regroup(NOW + MINUTE))
    const retried = await value(regroup(NOW + 2 * MINUTE))
    const closeRetried = await value(close(NOW + 11 * MINUTE, NOW + 3 * MINUTE))
    const atSwitch = await rateCards.getEffectiveRows({
      projectId,
      cardIds: [card.id],
      from: NOW + 11 * MINUTE - 1,
      to: NOW + 11 * MINUTE + 1,
    })

    expect(images.inserted.map((row) => row.featureSlug)).toEqual(["images"])
    expect(early).toEqual({
      code: "NOTICE_TOO_SHORT",
      featureSlug: "llm_tokens",
      earliest: NOW + 10 * MINUTE,
    })
    expect(mixed).toMatchObject({
      code: "INVALID_CARD",
      violations: [{ code: "MIXED_MATCH_KEYS", feature: "llm_tokens" }],
    })
    expect(regrouped.inserted.map((row) => row.match)).toEqual([{ model_id: "gpt-4.1" }])
    expect(regrouped.closed).toEqual([{ rowId: stale?.id, effectiveTo: NOW + 11 * MINUTE }])
    expect([retried.inserted, retried.closed, retried.unchanged]).toEqual([[], [], 2])
    expect(closeRetried).toEqual({ closed: [], unchanged: 1 })
    // No gap: the old row ends at the instant the new one starts.
    expect(
      atSwitch
        .filter((row) => row.featureSlug === "llm_tokens")
        .map((row) => [row.match, row.effectiveFrom - NOW, row.effectiveTo])
    ).toEqual([
      [{ model: "gpt-4.1" }, 0, NOW + 11 * MINUTE],
      [{ model_id: "gpt-4.1" }, 11 * MINUTE, null],
    ])
    expect(
      (await cardRows(card.id)).map((row) => [
        row.featureSlug,
        row.match,
        row.effectiveFrom - NOW,
        row.effectiveTo === null ? null : row.effectiveTo - NOW,
      ])
    ).toEqual([
      ["images", { size: "1024" }, 10 * MINUTE, null],
      ["llm_tokens", { model: "gpt-4.1" }, 0, 11 * MINUTE],
      ["llm_tokens", { model_id: "gpt-4.1" }, 11 * MINUTE, null],
    ])
  })
})
