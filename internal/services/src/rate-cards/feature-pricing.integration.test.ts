import { eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import {
  planVersionCatalogPricingInputSchema,
  planVersionFeatureUpdateBaseSchema,
  rateRowDraftSchema,
} from "@unprice/db/validators"
import { Err } from "@unprice/error"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seedTestDb } from "../test-fixtures/seed-db"
import { duplicatePlanVersion } from "../use-cases/plan-version/duplicate"
import { publishPlanVersion } from "../use-cases/plan-version/publish"
import { removePlanVersionFeature } from "../use-cases/plan-version/remove-feature"
import { updatePlanVersionFeature } from "../use-cases/plan-version/update-feature"
import {
  applyPlanVersionCatalogPricing,
  previewPlanVersionCatalogPricing,
} from "../use-cases/rate-cards/catalog-pricing"
import { UnPriceRateCardError } from "./errors"
import {
  LIVE_VERSION,
  NOW,
  TOKENS_METER,
  createRateCardIntegrationFixture,
  planFeature,
  projectId,
  value,
} from "./service.integration.fixture"

describe("feature pricing transactions", () => {
  const { db, rateCards, cardRows, services, logger } = createRateCardIntegrationFixture()
  const deps = { db, logger, services }
  const featureId = "fv_test_arrear_access"
  const originalCard = "card_test_arrear"

  beforeEach(async () => {
    await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
    await db
      .update(schema.versions)
      .set({ status: "draft", publishedAt: null })
      .where(eq(schema.versions.id, LIVE_VERSION))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function update(fields: Record<string, unknown>) {
    return updatePlanVersionFeature(deps, {
      ...planVersionFeatureUpdateBaseSchema.parse({
        id: featureId,
        planVersionId: LIVE_VERSION,
        ...fields,
      }),
      projectId,
      now: NOW,
    })
  }

  it("rolls back the feature when the requested price has another shape", async () => {
    const before = await cardRows(originalCard)
    const result = await update({
      featureType: "usage",
      config: { usageMode: "unit" },
      meterConfig: { ...TOKENS_METER, groupBy: undefined },
      price: { tiers: [{ upTo: null, rate: "1", flat: "0" }] },
    })
    expect(result.err).toMatchObject({ code: "PRICE_SHAPE_MISMATCH" })
    expect(
      (
        await db.query.planVersionFeatures.findFirst({
          where: eq(schema.planVersionFeatures.id, featureId),
        })
      )?.featureType
    ).toBe("flat")
    expect(await cardRows(originalCard)).toEqual(before)
  })

  it("rolls back a stored feature change when the row planner refuses its tiers", async () => {
    const before = await cardRows(originalCard)
    const result = await update({
      featureType: "tier",
      config: {},
      price: {
        tiers: [
          { upTo: 10, rate: "1", flat: "0" },
          { upTo: 5, rate: "2", flat: "0" },
          { upTo: null, rate: "3", flat: "0" },
        ],
      },
    })
    expect(result.err).toMatchObject({
      code: "INVALID_CARD",
      rejection: {
        violations: expect.arrayContaining([{ code: "TIERS_INVALID", rowId: expect.any(String) }]),
      },
    })
    expect(
      (
        await db.query.planVersionFeatures.findFirst({
          where: eq(schema.planVersionFeatures.id, featureId),
        })
      )?.featureType
    ).toBe("flat")
    expect(await cardRows(originalCard)).toEqual(before)
  })

  it("uses the plan snapshot for the first price on a new currency card", async () => {
    await db
      .update(schema.versions)
      .set({ currency: "USD" })
      .where(eq(schema.versions.id, LIVE_VERSION))
    await db
      .update(schema.features)
      .set({ meterConfig: { ...TOKENS_METER } })
      .where(eq(schema.features.id, "feat_test_events"))
    const result = await updatePlanVersionFeature(deps, {
      ...planVersionFeatureUpdateBaseSchema.parse({
        id: "fv_test_arrear_events",
        planVersionId: LIVE_VERSION,
        price: { tiers: [{ upTo: null, rate: "0.1", flat: "0" }] },
      }),
      projectId,
      now: NOW,
    })
    expect(result.err).toBeUndefined()
    expect(result.val?.state).toBe("ok")
    const assigned = await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")
    expect(assigned).not.toBeNull()
    expect((await cardRows(assigned?.cardId ?? "")).map((row) => row.featureSlug)).toEqual([
      "events",
    ])
  })

  it("does not publish after a concurrent close removes the last price", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
    const lock = rateCards.lockPlanVersionCards.bind(rateCards)
    vi.spyOn(rateCards, "lockPlanVersionCards").mockImplementationOnce(
      async (project, version, tx) => {
        await value(
          rateCards.closeRows({
            projectId,
            cardId: originalCard,
            rowIds: ["row_test_arrear_access"],
            now: NOW,
          })
        )
        return lock(project, version, tx)
      }
    )
    const result = await publishPlanVersion(
      {
        ...deps,
        services: { rateCards, customers: {} } as Parameters<
          typeof publishPlanVersion
        >[0]["services"],
        userId: "user_test_owner",
      },
      { id: LIVE_VERSION, projectId, workspaceUnPriceCustomerId: "cust_test" }
    )
    expect(result.val).toEqual({
      state: "unpriced",
      reason: "missing_rows",
      featureSlugs: ["access-pro"],
    })
    expect(
      (await db.query.versions.findFirst({ where: eq(schema.versions.id, LIVE_VERSION) }))?.status
    ).toBe("draft")
  })

  it("forks only the source version's rows from a card shared with another version", async () => {
    const source = await db.query.versions.findFirst({
      where: eq(schema.versions.id, LIVE_VERSION),
    })
    if (!source) throw new Error("fixture")
    await db.insert(schema.versions).values({ ...source, id: "pv_other", version: 2 })
    await db.insert(schema.planVersionFeatures).values({
      ...planFeature("pf_other_tokens", "ft_llm_tokens", TOKENS_METER, 1),
      planVersionId: "pv_other",
    })
    await value(
      rateCards.assignToPlanVersion(projectId, {
        planVersionId: "pv_other",
        currency: "EUR",
        cardId: originalCard,
      })
    )
    await value(
      rateCards.publishRows({
        projectId,
        cardId: originalCard,
        drafts: [
          rateRowDraftSchema.parse({
            featureSlug: "llm_tokens",
            match: { model: "acme" },
            price: {
              type: "unit",
              components: [{ property: "input_tokens", rate: "1", per: 1 }],
            },
            cost: null,
          }),
        ],
        now: NOW,
      })
    )
    const result = await value(duplicatePlanVersion(deps, { id: LIVE_VERSION, projectId }))
    if (result.state !== "ok") throw new Error(result.state)
    const card = await rateCards.cardForPlanVersion(projectId, result.planVersion.id, "EUR")
    expect((await cardRows(card?.cardId ?? "")).map((row) => row.featureSlug)).toEqual([
      "access-pro",
      "events",
    ])
    expect((await cardRows(originalCard)).some((row) => row.featureSlug === "llm_tokens")).toBe(
      true
    )
  })

  it("rolls back the copied version and card if its row publication fails", async () => {
    const beforeVersions = await db.query.versions.findMany()
    const beforeCards = await rateCards.listCards(projectId)
    const scope = rateCards.withTransaction.bind(rateCards)
    vi.spyOn(rateCards, "withTransaction").mockImplementationOnce((tx) => {
      const scoped = scope(tx)
      vi.spyOn(scoped, "publishRows").mockResolvedValueOnce(
        Err(new UnPriceRateCardError({ code: "INVALID_CARD", violations: [] }))
      )
      return scoped
    })
    const result = await duplicatePlanVersion(deps, { id: LIVE_VERSION, projectId })
    expect(result.err).toMatchObject({ code: "INVALID_CARD" })
    expect(await db.query.versions.findMany()).toEqual(beforeVersions)
    expect(await rateCards.listCards(projectId)).toEqual(beforeCards)
  })

  it("removes a detached catalog policy without blocking the remaining feature", async () => {
    await db
      .update(schema.versions)
      .set({ currency: "USD" })
      .where(eq(schema.versions.id, LIVE_VERSION))
    await db
      .insert(schema.planVersionFeatures)
      .values(planFeature("pf_tokens", "ft_llm_tokens", TOKENS_METER, 3))
    await db
      .update(schema.planVersionFeatures)
      .set({ meterConfig: TOKENS_METER, config: { usageMode: "unit" } })
      .where(eq(schema.planVersionFeatures.id, "fv_test_arrear_events"))
    const policy = (featureSlug: string) => ({
      ...planVersionCatalogPricingInputSchema.parse({
        planVersionId: LIVE_VERSION,
        featureSlug,
        markup: "0.3",
        roundTo: "0.01",
        componentMap: { input: "input_tokens" },
      }),
      projectId,
      now: NOW,
    })
    for (const slug of ["llm_tokens", "events"]) {
      const input = policy(slug)
      const preview = await value(previewPlanVersionCatalogPricing({ services }, input))
      await value(applyPlanVersionCatalogPricing(deps, { ...input, draftHash: preview.draftHash }))
    }
    await value(removePlanVersionFeature(deps, { projectId, id: "pf_tokens", now: NOW + 1 }))
    const assigned = await rateCards.cardForPlanVersion(projectId, LIVE_VERSION, "USD")
    const card = await value(rateCards.getCard(projectId, assigned?.cardId ?? ""))
    expect(card.card.marginPolicy).toMatchObject({
      type: "costPlus",
      features: [{ featureSlug: "events" }],
    })
    expect(
      card.rows
        .filter((row) => row.featureSlug === "llm_tokens")
        .every((row) => row.effectiveTo === NOW + 1)
    ).toBe(true)
    const next = await value(rateCards.previewCostPlus(projectId, card.card.id, NOW + 1))
    if (!next.draftHash) throw new Error("expected a publishable preview")
    expect(new Set(next.draft.changes.map((change) => change.proposed.featureSlug))).toEqual(
      new Set(["events"])
    )
  })

  it("publishes and duplicates versions sharing a card without deadlock", async () => {
    const copy = await value(duplicatePlanVersion(deps, { id: LIVE_VERSION, projectId }))
    if (copy.state !== "ok") throw new Error(copy.state)
    const draftId = copy.planVersion.id
    await db
      .update(schema.versions)
      .set({ collectionMethod: "send_invoice" })
      .where(eq(schema.versions.id, draftId))
    await value(
      rateCards.assignToPlanVersion(projectId, {
        planVersionId: draftId,
        currency: "EUR",
        cardId: originalCard,
      })
    )
    await db
      .update(schema.versions)
      .set({ status: "published", publishedAt: 1, latest: true })
      .where(eq(schema.versions.id, LIVE_VERSION))
    function signal() {
      let release = () => {}
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      return { promise, release: () => release() }
    }
    const publishingLocked = signal()
    const resumePublish = signal()
    const lock = rateCards.lockPlanVersionCards.bind(rateCards)
    vi.spyOn(rateCards, "lockPlanVersionCards").mockImplementation(async (project, version, tx) => {
      if (version === LIVE_VERSION)
        await tx.execute(
          sql`SELECT set_config('application_name', 'rate_card_duplicate_regression', true)`
        )
      const result = await lock(project, version, tx)
      if (version === draftId) {
        publishingLocked.release()
        await resumePublish.promise
      }
      return result
    })
    const publishing = publishPlanVersion(
      {
        ...deps,
        services: {
          rateCards,
          customers: {},
        } as Parameters<typeof publishPlanVersion>[0]["services"],
        userId: "user_test_owner",
      },
      { id: draftId, projectId, workspaceUnPriceCustomerId: "cust_test" }
    )
    await publishingLocked.promise
    const duplicating = duplicatePlanVersion(deps, { id: LIVE_VERSION, projectId })
    let waiting = false
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await db.execute<{ waiting: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = 'rate_card_duplicate_regression' AND wait_event_type = 'Lock') AS waiting`
        )
        if (state.rows[0]?.waiting) {
          waiting = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally {
      resumePublish.release()
    }
    const [published, duplicated] = await Promise.all([publishing, duplicating])
    expect(waiting).toBe(true)
    expect(published.err).toBeUndefined()
    expect(duplicated.err).toBeUndefined()
    expect(published.val?.state).toBe("ok")
    expect(duplicated.val?.state).toBe("ok")
  })
})
