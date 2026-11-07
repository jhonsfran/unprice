import { eq } from "@unprice/db"
import { versions as versionsTable } from "@unprice/db/schema"
import { createRateCardInputSchema, ratePriceSchema } from "@unprice/db/validators"
import { Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache/service"
import { NoopMetrics } from "../metrics/noop"
import { PlanService } from "../plans/service"
import { seedTestDb } from "../test-fixtures/seed-db"
import { pricePlanVersion } from "./price-plan-version"
import { projectFeaturePricing } from "./project-features"
import { RateCardService } from "./service"
import {
  MINUTE,
  NOW,
  createRateCardIntegrationFixture,
  projectId,
  rejection,
  value,
} from "./service.integration.fixture"

describe("RateCardService", () => {
  const { db, rateCards, features, services, cardRows } = createRateCardIntegrationFixture()

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
