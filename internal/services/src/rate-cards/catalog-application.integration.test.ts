import { eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import {
  customModelCostInputSchema,
  planVersionCatalogPricingInputSchema,
} from "@unprice/db/validators"
import { beforeEach, describe, expect, it } from "vitest"
import { seedTestDb } from "../test-fixtures/seed-db"
import {
  applyPlanVersionCatalogPricing,
  previewPlanVersionCatalogPricing,
} from "../use-cases/rate-cards/catalog-pricing"
import {
  LIVE_VERSION,
  NOW,
  TOKENS_METER,
  createRateCardIntegrationFixture,
  planFeature,
  projectId,
  value,
} from "./service.integration.fixture"

describe("catalog application", () => {
  const { db, rateCards, modelCosts, services, cardRows } = createRateCardIntegrationFixture()
  const deps = { db, services }
  beforeEach(async () => {
    await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
    await db
      .update(schema.versions)
      .set({ status: "draft", publishedAt: null, currency: "USD" })
      .where(eq(schema.versions.id, LIVE_VERSION))
    await db
      .insert(schema.planVersionFeatures)
      .values(planFeature("pf_tokens", "ft_llm_tokens", TOKENS_METER, 3))
    await db
      .update(schema.planVersionFeatures)
      .set({ meterConfig: TOKENS_METER, config: { usageMode: "unit" } })
      .where(eq(schema.planVersionFeatures.id, "fv_test_arrear_events"))
  })
  function policy(
    featureSlug = "llm_tokens",
    componentMap = { input: "input_tokens", output: "output_tokens" }
  ) {
    return {
      ...planVersionCatalogPricingInputSchema.parse({
        planVersionId: LIVE_VERSION,
        featureSlug,
        markup: "0.3",
        roundTo: "0.01",
        componentMap,
      }),
      projectId,
      now: NOW,
    }
  }
  async function changedCost() {
    await modelCosts.addCustom(
      projectId,
      {
        ...customModelCostInputSchema.parse({
          provider: "openai",
          model: "gpt-4.1",
          components: { input: "9", output: "10" },
        }),
      },
      NOW
    )
  }

  it("keeps an abandoned preview read-only and creates its card only during apply", async () => {
    const input = policy()
    const cardsBefore = await rateCards.listCards(projectId)
    const preview = await value(previewPlanVersionCatalogPricing({ services }, input))
    expect(preview.cardId).toBeNull()
    expect(await rateCards.listCards(projectId)).toEqual(cardsBefore)
    expect(await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")).toBeNull()
    expect(await db.select().from(schema.modelCosts)).toEqual([])
    const result = await applyPlanVersionCatalogPricing(deps, {
      ...input,
      draftHash: preview.draftHash,
    })
    expect(result.err).toBeUndefined()
    expect(result.val?.inserted.length).toBeGreaterThan(0)
    expect(await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")).not.toBeNull()
    expect(await db.select().from(schema.modelCosts)).toEqual([])
  })

  it("rejects a stale reviewed hash without saving policy or prices", async () => {
    const input = policy()
    const preview = await value(previewPlanVersionCatalogPricing({ services }, input))
    await changedCost()
    const result = await applyPlanVersionCatalogPricing(deps, {
      ...input,
      draftHash: preview.draftHash,
    })
    expect(result.err).toMatchObject({ code: "DRAFT_STALE" })
    expect(preview.cardId).toBeNull()
    expect(await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")).toBeNull()
    expect((await rateCards.listCards(projectId)).map((card) => card.id)).toEqual([
      "card_test_arrear",
    ])
    expect(await db.select().from(schema.modelCosts)).toEqual([])
  })

  it("does not save a policy whose reviewed rows fail validation", async () => {
    const input = policy("llm_tokens", { input: "tokens", output: "tokens" })
    const preview = await value(previewPlanVersionCatalogPricing({ services }, input))
    const result = await applyPlanVersionCatalogPricing(deps, {
      ...input,
      draftHash: preview.draftHash,
    })
    expect(result.err).toMatchObject({ code: "INVALID_CARD" })
    expect(preview.cardId).toBeNull()
    expect(await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")).toBeNull()
    expect((await rateCards.listCards(projectId)).map((card) => card.id)).toEqual([
      "card_test_arrear",
    ])
    expect(await db.select().from(schema.modelCosts)).toEqual([])
  })

  it("publishes only the feature shown in the scoped preview", async () => {
    for (const slug of ["llm_tokens", "events"]) {
      const input = policy(slug)
      const preview = await value(previewPlanVersionCatalogPricing({ services }, input))
      await value(applyPlanVersionCatalogPricing(deps, { ...input, draftHash: preview.draftHash }))
    }
    const assigned = await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")
    const cardId = assigned?.cardId ?? ""
    const eventsBefore = (await cardRows(cardId)).filter((row) => row.featureSlug === "events")
    await changedCost()
    const preview = await value(
      rateCards.previewCostPlus(projectId, cardId, NOW + 1, { featureSlug: "llm_tokens" })
    )
    if (!preview.draftHash) throw new Error("expected a publishable preview")
    expect(new Set(preview.draft.changes.map((change) => change.proposed.featureSlug))).toEqual(
      new Set(["llm_tokens"])
    )
    const published = await value(
      rateCards.publishCostPlus({
        projectId,
        cardId,
        featureSlug: "llm_tokens",
        draftHash: preview.draftHash,
        now: NOW + 1,
      })
    )
    expect(published.inserted.length).toBeGreaterThan(0)
    expect(published.inserted.every((row) => row.featureSlug === "llm_tokens")).toBe(true)
    expect((await cardRows(cardId)).filter((row) => row.featureSlug === "events")).toEqual(
      eventsBefore
    )
    const remaining = await value(
      rateCards.previewCostPlus(projectId, cardId, NOW + 1, { featureSlug: "events" })
    )
    expect(remaining.draft.changes.some((change) => change.type === "changed")).toBe(true)
  })
})
