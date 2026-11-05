import { eq } from "@unprice/db"
import {
  features as featuresTable,
  modelCosts as modelCostsTable,
  versions as versionsTable,
} from "@unprice/db/schema"
import {
  type RateRow,
  type RateRowDraft,
  createRateCardInputSchema,
  ratePriceSchema,
  rateRowDraftSchema,
} from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { formatAmount } from "@unprice/money"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { MODEL_CATALOG } from "../budgets/model-catalog"
import type { Cache } from "../cache/service"
import { FeatureService } from "../features/service"
import { NoopMetrics } from "../metrics/noop"
import { PlanService } from "../plans/service"
import { modelCosts, usdCard } from "../pricing/fixtures"
import {
  closeTestDatabaseConnection,
  createTestDatabaseConnection,
  truncateTestDatabase,
} from "../test-fixtures/database"
import { seedTestDb } from "../test-fixtures/seed-db"
import { importModelCosts, publishCostPlus, publishRateRows } from "../use-cases/rate-cards"
import { pricePlanVersion } from "./price-plan-version"
import { projectFeaturePricing } from "./project-features"
import { RateCardService } from "./service"

const db = createTestDatabaseConnection()
const projectId = "proj_test"
const NOW = Date.parse("2026-11-10T12:00:00.000Z")
const MINUTE = 60_000

const rateCards = new RateCardService({ db })
const features = new FeatureService({ db, logger: { error: vi.fn() } as unknown as Logger })
const services = { rateCards, features }

async function value<T>(result: Promise<{ val?: T; err?: Error }>): Promise<T> {
  const { val, err } = await result
  if (err) throw err
  return val as T
}

async function rejection(result: Promise<{ err?: Error & { rejection?: unknown } }>) {
  const { err } = await result
  return err?.rejection
}

function gpt41(input: string, output: string): RateRowDraft {
  return rateRowDraftSchema.parse({
    featureSlug: "llm_tokens",
    match: { model: "gpt-4.1" },
    price: {
      type: "unit",
      components: [
        { property: "input_tokens", rate: input, per: 1_000_000 },
        { property: "output_tokens", rate: output, per: 1_000_000 },
      ],
    },
    cost: null,
  })
}

/** [from, to, output rate] per row: the shape of a card's price history. */
function intervals(rows: readonly RateRow[]) {
  return rows.map((row) => [
    row.effectiveFrom - NOW,
    row.effectiveTo === null ? null : row.effectiveTo - NOW,
    row.price.type === "unit" ? row.price.components.map((c) => formatAmount(c.rate)) : [],
  ])
}

async function createCard(marginPolicy: object = { type: "manual" }) {
  const input = createRateCardInputSchema.parse({
    name: "Standard",
    unit: "money:USD",
    marginPolicy,
  })
  return value(rateCards.createCard(projectId, input))
}

function publish(cardId: string, rows: RateRowDraft[], effectiveFrom: number, now = NOW) {
  return publishRateRows({ services }, { projectId, cardId, rows, effectiveFrom, now })
}

async function cardRows(cardId: string) {
  return (await value(rateCards.getCard(projectId, cardId))).rows
}

describe("RateCardService", () => {
  afterAll(async () => {
    await closeTestDatabaseConnection(db)
  })

  beforeEach(async () => {
    await truncateTestDatabase(db)
    await seedTestDb({ db, fixtures: ["base-project.sql"] })
    await db.insert(featuresTable).values({
      id: "ft_llm_tokens",
      projectId,
      slug: "llm_tokens",
      title: "LLM tokens",
      meterConfig: {
        eventId: "evt_tokens",
        eventSlug: "tokens",
        aggregationMethod: "sum",
        aggregationField: "input_tokens",
        groupBy: ["model"],
      },
    })
  })

  it("refuses a credits card on a plan version, since its invoices are in money", async () => {
    await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
    const planVersionId = "pv_test_monthly_arrear"
    await db
      .update(versionsTable)
      .set({ status: "draft" })
      .where(eq(versionsTable.id, planVersionId))
    const credits = await value(
      rateCards.createCard(
        projectId,
        createRateCardInputSchema.parse({
          name: "Credits",
          unit: "credits:ai",
          creditValueUsd: "0.01",
          marginPolicy: { type: "manual" },
        })
      )
    )
    const euros = await value(
      rateCards.createCard(
        projectId,
        createRateCardInputSchema.parse({
          name: "Euros",
          unit: "money:EUR",
          marginPolicy: { type: "manual" },
        })
      )
    )

    const refused = await rejection(
      rateCards.assignToPlanVersion(projectId, {
        planVersionId,
        currency: "EUR",
        cardId: credits.id,
      })
    )
    const assigned = await value(
      rateCards.assignToPlanVersion(projectId, { planVersionId, currency: "EUR", cardId: euros.id })
    )

    expect(refused).toEqual({
      code: "CARD_UNIT_MISMATCH",
      cardId: credits.id,
      unit: "credits:ai",
      currency: "EUR",
    })
    expect(assigned).toEqual({
      planVersionId,
      currency: "EUR",
      cardId: euros.id,
      unit: "money:EUR",
    })
    expect(await rateCards.cardForPlanVersion(projectId, planVersionId, "EUR")).toEqual(assigned)
  })

  it("refuses a price change inside the notice and closes the old row at a change after it", async () => {
    const card = await createCard()
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
    await db.insert(featuresTable).values({
      id: "ft_images",
      projectId,
      slug: "images",
      title: "Images",
      meterConfig: {
        eventId: "evt_images",
        eventSlug: "images",
        aggregationMethod: "count",
        groupBy: ["size"],
      },
    })
    const image = rateRowDraftSchema.parse({
      featureSlug: "images",
      match: { size: "1024" },
      price: { type: "unit", components: [{ property: null, rate: "0.04", per: 1 }] },
      cost: null,
    })
    const card = await createCard()
    const [stale] = (await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))).inserted
    await db
      .update(featuresTable)
      .set({
        meterConfig: {
          eventId: "evt_tokens",
          eventSlug: "tokens",
          aggregationMethod: "sum",
          aggregationField: "input_tokens",
          groupBy: ["model_id"],
        },
      })
      .where(eq(featuresTable.id, "ft_llm_tokens"))
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

  it("refuses a cost-plus draft whose open row was replaced after the preview", async () => {
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: { input: "input_tokens", output: "output_tokens" },
        },
      ],
    })
    await value(publish(card.id, [gpt41("2.00", "8.00")], NOW))
    await rateCards.insertModelCosts([modelCosts.gpt41])
    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW))
    await value(publish(card.id, [gpt41("9.00", "9.00")], NOW + 10 * MINUTE))
    const before = intervals(await cardRows(card.id))

    const stale = await rejection(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 60 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(stale).toMatchObject({ code: "DRAFT_STALE" })
    expect(before).toEqual([
      [0, 10 * MINUTE, ["2", "8"]],
      [10 * MINUTE, null, ["9", "9"]],
    ])
    expect(intervals(await cardRows(card.id))).toEqual(before)
  })

  it("publishes a cost-plus revision past a model row scheduled to retire", async () => {
    const day = 24 * 60 * MINUTE
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: { input: "input_tokens", output: "output_tokens" },
        },
      ],
    })
    const claude = { ...gpt41("3.00", "15.00"), match: { model: "claude-sonnet-4" } }
    const [gpt] = (await value(publish(card.id, [gpt41("2.60", "10.40"), claude], NOW))).inserted
    await value(
      rateCards.closeRows({
        projectId,
        cardId: card.id,
        rowIds: [gpt?.id ?? ""],
        effectiveTo: NOW + day,
        now: NOW,
      })
    )
    await rateCards.insertModelCosts([modelCosts.gpt41, modelCosts.claudeSonnet4])

    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW + MINUTE))
    const published = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 20 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(preview.draft.changes.map((change) => [change.type, change.proposed.match])).toEqual([
      ["changed", { model: "claude-sonnet-4" }],
      ["retiring", { model: "gpt-4.1" }],
    ])
    expect([published.inserted.map((row) => row.match), published.unchanged]).toEqual([
      [{ model: "claude-sonnet-4" }],
      1,
    ])
    expect(
      (await cardRows(card.id))
        .map((row) => [
          row.match.model,
          row.effectiveFrom - NOW,
          row.effectiveTo === null ? null : row.effectiveTo - NOW,
        ])
        .sort()
    ).toEqual([
      ["claude-sonnet-4", 0, 20 * MINUTE],
      ["claude-sonnet-4", 20 * MINUTE, null],
      ["gpt-4.1", 0, day],
    ])
  })

  it("imports only changed catalog costs and never touches a manual cost", async () => {
    const day = 24 * 60 * MINUTE
    await db.insert(modelCostsTable).values([
      {
        id: "mc_haiku_current",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        components: { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
        effectiveFrom: NOW - day,
        source: "modelsdev",
        sourceRef: "2026-10-01",
      },
      {
        id: "mc_haiku_manual",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        components: { input: "0.5" },
        effectiveFrom: NOW - day,
        source: "manual",
        sourceRef: "negotiated",
      },
    ])

    const first = await importModelCosts({ services }, { now: NOW })
    const second = await importModelCosts({ services }, { now: NOW + day })
    const haiku = await db
      .select()
      .from(modelCostsTable)
      .where(eq(modelCostsTable.model, "claude-haiku-4-5"))

    expect(first).toEqual({ inserted: MODEL_CATALOG.length - 1, unchanged: 1 })
    expect(second).toEqual({ inserted: 0, unchanged: MODEL_CATALOG.length })
    expect(haiku.map((row) => [row.id, row.source, row.components]).sort()).toEqual([
      [
        "mc_haiku_current",
        "modelsdev",
        { input: "1", output: "5", cache_read: "0.1", cache_write: "1.25" },
      ],
      ["mc_haiku_manual", "manual", { input: "0.5" }],
    ])
  })

  it("previews cost-plus rates and publishes the reviewed draft as catalog rows", async () => {
    const card = await createCard({
      type: "costPlus",
      features: [
        {
          featureSlug: "llm_tokens",
          markup: "0.3",
          roundTo: "0.01",
          dimension: "model",
          componentMap: {
            input: "input_tokens",
            cache_read: "cached_input_tokens",
            output: "output_tokens",
            cache_write: "cache_write_tokens",
          },
        },
      ],
    })
    const tokenRows = usdCard.rows.filter((row) => row.featureSlug === "llm_tokens")
    await value(publish(card.id, tokenRows, NOW))
    await rateCards.insertModelCosts([modelCosts.gpt41, modelCosts.claudeSonnet4])
    const costIds = Object.fromEntries(
      (await db.select().from(modelCostsTable)).map((row) => [row.model, row.id])
    )

    const preview = await value(rateCards.previewCostPlus(projectId, card.id, NOW))
    const stale = await rejection(
      publishCostPlus(
        { services },
        { projectId, cardId: card.id, effectiveFrom: NOW + 10 * MINUTE, draftHash: "f00", now: NOW }
      )
    )
    const published = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 11 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + MINUTE,
        }
      )
    )

    expect(
      preview.draft.changes.map((change) => [
        change.type,
        change.proposed.match,
        change.proposed.price.components.map((c) => `${c.property}=${formatAmount(c.rate)}`),
      ])
    ).toEqual([
      [
        "changed",
        { model: "claude-sonnet-4" },
        [
          "input_tokens=3.9",
          "output_tokens=19.5",
          "cached_input_tokens=0.39",
          "cache_write_tokens=4.88",
        ],
      ],
      [
        "changed",
        { model: "gpt-4.1" },
        ["input_tokens=2.6", "output_tokens=10.4", "cached_input_tokens=0.65"],
      ],
    ])
    const retried = await value(
      publishCostPlus(
        { services },
        {
          projectId,
          cardId: card.id,
          effectiveFrom: NOW + 12 * MINUTE,
          draftHash: preview.draftHash,
          now: NOW + 2 * MINUTE,
        }
      )
    )

    expect(stale).toEqual({ code: "DRAFT_STALE", draftHash: preview.draftHash })
    expect(published.inserted.map((row) => [row.match.model, row.source, row.sourceRef])).toEqual([
      ["claude-sonnet-4", "catalog", costIds["claude-sonnet-4"]],
      ["gpt-4.1", "catalog", costIds["gpt-4.1"]],
    ])
    expect(published.closed.length).toBe(2)
    expect(retried).toEqual({ inserted: [], closed: [], unchanged: 2 })
    expect(
      (await cardRows(card.id)).map((row) => [
        row.match.model,
        row.source,
        row.effectiveFrom - NOW,
        row.effectiveTo === null ? null : row.effectiveTo - NOW,
      ])
    ).toEqual([
      ["gpt-4.1", "manual", 0, 11 * MINUTE],
      ["gpt-4.1-mini", "manual", 0, null],
      ["claude-sonnet-4", "manual", 0, 11 * MINUTE],
      ["claude-sonnet-4", "catalog", 11 * MINUTE, null],
      ["gpt-4.1", "catalog", 11 * MINUTE, null],
    ])
  })

  describe("plan version pricing", () => {
    const planVersionId = "pv_test_monthly_arrear"
    const flat = (amount: string) => ratePriceSchema.parse({ type: "flat", amount })

    beforeEach(async () => {
      await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
      await db
        .update(versionsTable)
        .set({ status: "draft" })
        .where(eq(versionsTable.id, planVersionId))
    })

    it("clears the cached plan versions of a card when it is assigned or its rows change", async () => {
      const remove = vi.fn(async (_keys: string | string[]) => Ok(undefined))
      const cached = new RateCardService({
        db,
        cache: { planVersion: { remove } } as unknown as Pick<Cache, "planVersion">,
      })
      const pricing = await value(projectFeaturePricing(features, projectId))
      const draft = (featureSlug: string, amount: string) => ({
        featureSlug,
        match: {},
        price: flat(amount),
        cost: null,
        source: "manual" as const,
        sourceRef: null,
      })

      const refused = await rejection(
        cached.publishRows({
          projectId,
          cardId: "card_test_arrear",
          drafts: [draft("access-pro", "120")],
          effectiveFrom: NOW,
          now: NOW,
          ...pricing,
        })
      )
      expect(refused).toMatchObject({ code: "NOTICE_TOO_SHORT" })
      expect(remove).not.toHaveBeenCalled()

      const published = await value(
        cached.publishRows({
          projectId,
          cardId: "card_test_arrear",
          drafts: [draft("access-pro", "120")],
          effectiveFrom: NOW + 10 * MINUTE,
          now: NOW,
          ...pricing,
        })
      )
      await value(
        cached.closeRows({
          projectId,
          cardId: "card_test_arrear",
          rowIds: ["row_test_arrear_events"],
          effectiveTo: NOW + 10 * MINUTE,
          now: NOW,
        })
      )
      const replacement = await value(
        cached.createCard(
          projectId,
          createRateCardInputSchema.parse({
            name: "Replacement EUR",
            unit: "money:EUR",
            marginPolicy: { type: "manual" },
          })
        )
      )
      await value(
        cached.assignToPlanVersion(projectId, {
          planVersionId,
          currency: "EUR",
          cardId: replacement.id,
        })
      )

      expect(published.inserted.map((row) => row.featureSlug)).toEqual(["access-pro"])
      expect(remove.mock.calls).toEqual([[[planVersionId]], [[planVersionId]], [[planVersionId]]])
    })

    it("adopts the card an interrupted run created under the version's name, then writes nothing", async () => {
      const cardName = `pro ${planVersionId} USD`
      // A run created the card, then stopped before publishing its rows or assigning it.
      const orphan = await value(
        rateCards.createCard(
          projectId,
          createRateCardInputSchema.parse({
            name: cardName,
            unit: "money:USD",
            marginPolicy: { type: "manual" },
          })
        )
      )
      const input = {
        projectId,
        planVersionId,
        currency: "USD" as const,
        cardName,
        prices: [{ featureSlug: "access-pro", price: flat("49") }],
        now: NOW,
      }

      expect(await value(pricePlanVersion({ services }, input))).toEqual({ cardId: orphan.id })
      const rowsAfterFirst = await cardRows(orphan.id)
      expect(await value(pricePlanVersion({ services }, input))).toEqual({ cardId: orphan.id })

      expect(await rateCards.cardForPlanVersion(projectId, planVersionId, "USD")).toEqual({
        planVersionId,
        currency: "USD",
        cardId: orphan.id,
        unit: "money:USD",
      })
      expect(
        rowsAfterFirst.map(({ featureSlug, price, effectiveFrom, effectiveTo }) => ({
          featureSlug,
          price,
          effectiveFrom,
          effectiveTo,
        }))
      ).toEqual([
        { featureSlug: "access-pro", price: flat("49"), effectiveFrom: NOW, effectiveTo: null },
      ])
      expect(await cardRows(orphan.id)).toEqual(rowsAfterFirst)
      expect((await rateCards.listCards(projectId)).map(({ name }) => name)).toEqual([
        "PRO Arrears EUR",
        cardName,
      ])
    })

    it("refuses to adopt a card under the version's name that prices another unit", async () => {
      const cardName = `pro ${planVersionId} USD`
      const euros = await value(
        rateCards.createCard(
          projectId,
          createRateCardInputSchema.parse({
            name: cardName,
            unit: "money:EUR",
            marginPolicy: { type: "manual" },
          })
        )
      )

      const refused = await rejection(
        pricePlanVersion(
          { services },
          {
            projectId,
            planVersionId,
            currency: "USD",
            cardName,
            prices: [{ featureSlug: "access-pro", price: flat("49") }],
            now: NOW,
          }
        )
      )

      expect(refused).toEqual({
        code: "CARD_UNIT_MISMATCH",
        cardId: euros.id,
        unit: "money:EUR",
        currency: "USD",
      })
      expect(await rateCards.cardForPlanVersion(projectId, planVersionId, "USD")).toBeNull()
    })

    it("drops a draft's cards in other currencies when its currency changes", async () => {
      const plans = new PlanService({
        db,
        logger: { error: vi.fn(), warn: vi.fn() } as unknown as Logger,
        waitUntil: () => {},
        cache: {} as Cache,
        metrics: new NoopMetrics(),
        rateCards,
      })
      const dollars = await value(
        rateCards.createCard(
          projectId,
          createRateCardInputSchema.parse({
            name: "Dollars",
            unit: "money:USD",
            marginPolicy: { type: "manual" },
          })
        )
      )
      await value(
        rateCards.assignToPlanVersion(projectId, {
          planVersionId,
          currency: "USD",
          cardId: dollars.id,
        })
      )

      const updated = await value(
        plans.updatePlanVersionRecord({ projectId, id: planVersionId, currency: "USD" })
      )

      expect(updated.state).toBe("ok")
      expect(await rateCards.cardForPlanVersion(projectId, planVersionId, "EUR")).toBeNull()
      expect(await rateCards.cardForPlanVersion(projectId, planVersionId, "USD")).toEqual({
        planVersionId,
        currency: "USD",
        cardId: dollars.id,
        unit: "money:USD",
      })
    })
  })
})
