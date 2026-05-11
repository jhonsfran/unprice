import type { Analytics } from "@unprice/analytics"
import { currencies, dinero } from "@unprice/db/utils"
import type { grantSchemaExtended } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { toSnapshot } from "dinero.js"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { RatingService } from "../../rating/service"
import { ReferenceBillingModel } from "../../test-fixtures/reference-model"

const propertyRuns = Number.parseInt(process.env.UNPRICE_PROPERTY_RUNS ?? "75", 10)
const propertySeed = process.env.UNPRICE_PROPERTY_SEED
  ? Number.parseInt(process.env.UNPRICE_PROPERTY_SEED, 10)
  : undefined

const periodStart = Date.parse("2026-01-01T00:00:00.000Z")
const periodEnd = Date.parse("2026-02-01T00:00:00.000Z")
const projectId = "proj_test"
const customerId = "cus_test"
const subscriptionId = "sub_test"
const featureSlug = "events"

type Grant = z.infer<typeof grantSchemaExtended>

function createLogger(): Logger {
  return {
    set: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    flush: () => Promise.resolve(),
  } as unknown as Logger
}

function createRatingService() {
  return new RatingService({
    logger: createLogger(),
    analytics: {} as Analytics,
    grantsManager: {} as never,
  })
}

function buildUsageGrant(input: { unitPriceCents: number; allowanceUnits: number }): Grant {
  return {
    id: "grnt_test",
    projectId,
    customerEntitlementId: "ce_test",
    type: "subscription",
    priority: 10,
    allowanceUnits: input.allowanceUnits,
    effectiveAt: periodStart,
    expiresAt: null,
    metadata: null,
    createdAtM: periodStart,
    updatedAtM: periodStart,
    customerEntitlement: {
      id: "ce_test",
      projectId,
      customerId,
      featurePlanVersionId: "fv_test",
      subscriptionId,
      subscriptionPhaseId: "phase_test",
      subscriptionItemId: "item_test",
      effectiveAt: periodStart,
      expiresAt: null,
      overageStrategy: "none",
      metadata: null,
      createdAtM: periodStart,
      updatedAtM: periodStart,
      featurePlanVersion: {
        id: "fv_test",
        projectId,
        planVersionId: "pv_test",
        type: "feature",
        featureId: "feat_test",
        featureType: "usage",
        unitOfMeasure: "events",
        config: {
          price: {
            dinero: dinero({
              amount: input.unitPriceCents,
              currency: currencies.EUR,
            }).toJSON(),
            displayAmount: (input.unitPriceCents / 100).toFixed(2),
          },
          usageMode: "unit",
          units: 1,
        },
        billingConfig: {
          name: "monthly",
          billingInterval: "month",
          billingIntervalCount: 1,
          billingAnchor: "dayOfCreation",
          planType: "recurring",
        },
        resetConfig: null,
        meterConfig: {
          aggregationMethod: "sum",
          aggregationField: "value",
          eventId: "evt_test",
          eventSlug: featureSlug,
        },
        metadata: null,
        order: 0,
        defaultQuantity: null,
        limit: null,
        createdAtM: periodStart,
        updatedAtM: periodStart,
        feature: {
          id: "feat_test",
          projectId,
          slug: featureSlug,
          code: 1,
          title: "Events",
          description: null,
          unitOfMeasure: "events",
          meterConfig: null,
          createdAtM: periodStart,
          updatedAtM: periodStart,
        },
      },
    },
  }
}

function createReferenceModel(input: { usage: number; unitPriceCents: number }) {
  const model = new ReferenceBillingModel()
  model.addCustomer({ id: customerId, currency: "EUR" })
  model.addPlan({
    id: "plan_test",
    currency: "EUR",
    whenToBill: "pay_in_arrear",
    features: [
      {
        id: "feat_test",
        slug: featureSlug,
        kind: "usage",
        includedUnits: 0,
        unitPriceCents: input.unitPriceCents,
      },
    ],
  })
  model.addSubscription({
    id: subscriptionId,
    customerId,
    planId: "plan_test",
    startsAt: periodStart,
  })
  model.createBillingPeriod({
    subscriptionId,
    customerId,
    planId: "plan_test",
    periodStart,
    periodEnd,
  })
  model.meterUsage({
    id: "evt_test",
    customerId,
    subscriptionId,
    featureSlug,
    quantity: input.usage,
    occurredAt: periodStart,
  })
  return model
}

function totalRatedCents(charges: Awaited<ReturnType<RatingService["rateBillingPeriod"]>>["val"]) {
  return (charges ?? []).reduce(
    (sum, charge) => sum + Number(toSnapshot(charge.price.totalPrice.dinero).amount),
    0
  )
}

describe("RatingService properties", () => {
  it("matches the reference model for generated unit-priced usage", async () => {
    const inputArbitrary = fc.record({
      unitPriceCents: fc.integer({ min: 1, max: 10_000 }),
      usage: fc.integer({ min: 0, max: 10_000 }),
      allowanceUnits: fc.integer({ min: 1, max: 10_000 }),
    })

    await fc.assert(
      fc.asyncProperty(inputArbitrary, async (input) => {
        const rating = createRatingService()
        const result = await rating.rateBillingPeriod({
          projectId,
          customerId,
          featureSlug,
          startAt: periodStart,
          endAt: periodEnd,
          grants: [buildUsageGrant(input)],
          usageData: [{ featureSlug, usage: input.usage }],
        })

        const model = createReferenceModel(input)
        const invoice = model.billPeriod({ subscriptionId, periodStart, periodEnd })

        expect(result.err).toBeUndefined()
        expect(totalRatedCents(result.val)).toBe(invoice.totalCents)
        expect((result.val ?? []).reduce((sum, charge) => sum + charge.usage, 0)).toBe(input.usage)
      }),
      {
        examples: [
          [
            {
              unitPriceCents: 250,
              usage: 12,
              allowanceUnits: 5,
            },
          ],
        ],
        numRuns: propertyRuns,
        seed: propertySeed,
      }
    )
  })
})
