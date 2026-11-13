import { eq } from "@unprice/db"
import { versions as versionsTable } from "@unprice/db/schema"
import { createRateCardInputSchema, ratePriceSchema } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import { NoopMetrics } from "../metrics/noop"
import { PlanService } from "../plans/service"
import { seedTestDb } from "../test-fixtures/seed-db"
import { pricePlanVersion } from "./price-plan-version"
import {
  NOW,
  createRateCardIntegrationFixture,
  projectId,
  rejection,
  value,
} from "./service.integration.fixture"

describe("RateCardService", () => {
  const { db, rateCards, services, cardRows } = createRateCardIntegrationFixture()

  it("refuses a credits card on a plan version, since its invoices are in money", async () => {
    await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
    const planVersionId = "pv_test_monthly_arrear"
    await db
      .update(versionsTable)
      .set({ status: "draft", publishedAt: null })
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

  describe("plan version pricing", () => {
    const planVersionId = "pv_test_monthly_arrear"
    const flat = (amount: string) => ratePriceSchema.parse({ type: "flat", amount })

    beforeEach(async () => {
      await seedTestDb({ db, fixtures: ["plan-monthly-arrear.sql"] })
      await db
        .update(versionsTable)
        .set({ status: "draft", publishedAt: null })
        .where(eq(versionsTable.id, planVersionId))
    })

    it("assembles the version's prices and customer-facing lines in the plan service", async () => {
      const version = await value(
        services.plans.getPlanVersionWithPrices({ projectId, planVersionId })
      )
      expect(version?.flatPrice).toBe("99\u00a0€")
      expect(
        version?.planFeatures.find((feature) => feature.feature.slug === "access-pro")
      ).toMatchObject({ displayPrice: "99\u00a0€", displayFeatureText: "Access Pro" })
      expect(
        version?.planFeatures.find((feature) => feature.feature.slug === "events")
          ?.displayFeatureText
      ).toContain("0,001\u00a0€ per event")
    })

    it("refuses to change a published version's card", async () => {
      await db
        .update(versionsTable)
        .set({ status: "published" })
        .where(eq(versionsTable.id, planVersionId))
      expect(
        await rejection(
          rateCards.assignToPlanVersion(projectId, {
            planVersionId,
            currency: "EUR",
            cardId: "card_test_arrear",
          })
        )
      ).toEqual({ code: "PLAN_VERSION_PUBLISHED", planVersionId })
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
      const listed = await rateCards.listCards(projectId)
      expect(listed.map(({ name }) => name)).toEqual(["PRO Arrears EUR", cardName])
      expect(listed.find((card) => card.id === orphan.id)?.version).toMatchObject({
        planSlug: "pro",
        planVersionId,
        currency: "USD",
      })
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
