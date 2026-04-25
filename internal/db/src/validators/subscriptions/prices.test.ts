import { dinero, toDecimal } from "dinero.js"
import { describe, expect, it } from "vitest"

import * as currencies from "dinero.js/currencies"
import type { Feature } from "../features"
import type { PlanVersionFeature } from "../planVersionFeatures"
import type { PlanVersionExtended } from "../planVersions"
import type { BillingConfig } from "../shared"
import {
  calculateFlatPricePlan,
  calculatePackagePrice,
  calculateTierPrice,
  calculateTotalPricePlan,
  calculateUnitPrice,
} from "./prices"

describe("pricing calculators", () => {
  it("calculateUnitPrice: applies proration to total (and unit) and keeps subtotal unprorated", () => {
    const price = dinero({ amount: 250, currency: currencies.USD }) // $2.50

    const { val, err } = calculateUnitPrice({
      price: { dinero: price.toJSON(), displayAmount: "2.50" },
      quantity: 4,
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("10.00") // 2.5 * 4
    expect(toDecimal(val!.totalPrice.dinero)).toBe("5.00") // proration 50%
  })

  it("calculatePackagePrice: multiplies by ceil(quantity/units) and prorates total only", () => {
    const price = dinero({ amount: 1000, currency: currencies.USD }) // $10 per package of 5

    const { val, err } = calculatePackagePrice({
      price: { dinero: price.toJSON(), displayAmount: "10.00" },
      quantity: 7,
      units: 5,
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // ceil(7/5) = 2 packages => subtotal $20, total $10 with 50% proration
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("20.00")
    expect(toDecimal(val!.totalPrice.dinero)).toBe("10.00")
  })

  it("calculateTierPrice volume: subtotal includes full flat fee, total includes prorated flat fee", () => {
    const unitPrice = dinero({ amount: 200, currency: currencies.USD }) // $2
    const flatPrice = dinero({ amount: 1000, currency: currencies.USD }) // $10 flat

    const { val, err } = calculateTierPrice({
      tiers: [
        {
          unitPrice: { dinero: unitPrice.toJSON(), displayAmount: "2.00" },
          flatPrice: { dinero: flatPrice.toJSON(), displayAmount: "10.00" },
          firstUnit: 1,
          lastUnit: null,
        },
      ],
      quantity: 3,
      tierMode: "volume",
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // subtotal: 3*2 + 10 = 16
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("16.00")
    // total: 3*2 + (10 * 0.5) = 11
    expect(toDecimal(val!.totalPrice.dinero)).toBe("11.00")
  })

  it("calculateTierPrice graduated: accumulates across tiers and applies flat fee (prorated) on the tier reached", () => {
    const t1Unit = dinero({ amount: 200, currency: currencies.USD }) // $2
    const t2Unit = dinero({ amount: 100, currency: currencies.USD }) // $1
    const t2Flat = dinero({ amount: 300, currency: currencies.USD }) // $3

    const { val, err } = calculateTierPrice({
      tiers: [
        {
          unitPrice: { dinero: t1Unit.toJSON(), displayAmount: "2.00" },
          flatPrice: {
            dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
            displayAmount: "0.00",
          },
          firstUnit: 1,
          lastUnit: 5,
        },
        {
          unitPrice: { dinero: t2Unit.toJSON(), displayAmount: "1.00" },
          flatPrice: { dinero: t2Flat.toJSON(), displayAmount: "3.00" },
          firstUnit: 6,
          lastUnit: null,
        },
      ],
      quantity: 7,
      tierMode: "graduated",
      isUsageBased: false,
      prorate: 0.5,
    })

    expect(err).toBeUndefined()
    // per-unit: (1..5)*$2 => $10, (6..7)*$1 => $2 => total units $12
    // subtotal adds full flat fee of reached tier2: 12 + 3 = 15
    expect(toDecimal(val!.subtotalPrice.dinero)).toBe("15.00")
    // total prorates the flat fee: 12 + 1.5 = 13.5
    expect(toDecimal(val!.totalPrice.dinero)).toBe("13.50")
  })

  it("calculateTotalPricePlan: sums different feature types", () => {
    const unit = dinero({ amount: 500, currency: currencies.USD }) // $5
    const flat = dinero({ amount: 1000, currency: currencies.USD }) // $10

    const features = [
      {
        id: "f-flat",
        featureType: "flat" as const,
        config: {
          price: { dinero: flat.toJSON(), displayAmount: "10.00" },
        },
      },
      {
        id: "f-tier",
        featureType: "tier" as const,
        config: {
          tierMode: "volume",
          tiers: [
            {
              unitPrice: { dinero: unit.toJSON(), displayAmount: "5.00" },
              flatPrice: {
                dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
                displayAmount: "0.00",
              },
              firstUnit: 1,
              lastUnit: null,
            },
          ],
        },
      },
    ]

    const { val, err } = calculateTotalPricePlan({
      features: features as unknown as PlanVersionFeature[],
      quantities: { "f-tier": 2 },
      currency: "USD",
    })

    expect(err).toBeUndefined()
    // total: flat $10 + tier 2 * $5 = $20
    expect(toDecimal(val!.dinero)).toBe("20.00")
  })
})

describe("calculateFlatPricePlan", () => {
  it("should calculate flat price for a plan with flat features", () => {
    const billingConfig = {
      name: "test",
      billingInterval: "month",
      billingIntervalCount: 1,
      planType: "recurring",
      billingAnchor: 1,
    } as BillingConfig

    const planVersion: PlanVersionExtended = {
      id: "pv_4Hs8cAjTgxCWUpFSjta8bDFEkqpF",
      currency: "USD",
      projectId: "project_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
      version: 1,
      planId: "plan_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
      active: true,
      status: "published",
      paymentProvider: "stripe",
      collectionMethod: "charge_automatically",
      trialUnits: 0,
      autoRenew: true,
      paymentMethodRequired: false,
      billingConfig: billingConfig,
      creditLineAmount: 0,
      planFeatures: [
        {
          id: "fv_4HsTVDfaaTtnAkq5sKB1Raj4tgaG",
          featureType: "flat",
          unitOfMeasure: "units",
          config: {
            price: {
              dinero: {
                amount: 3000,
                currency: {
                  code: "USD",
                  base: 10,
                  exponent: 2,
                },
                scale: 2,
              },
              displayAmount: "30.00",
            },
          },
          metadata: {
            realtime: false,
            notifyUsageThreshold: 95,
            overageStrategy: "none",
            blockCustomer: false,
            hidden: false,
          },
          defaultQuantity: 1,
          limit: null,
          createdAtM: 0,
          updatedAtM: 0,
          projectId: "",
          planVersionId: "",
          featureId: "",
          order: 0,
          feature: {
            id: "feature_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
            slug: "feature-1",
          } as Feature,
          billingConfig: billingConfig,
          type: "feature",
          resetConfig: null,
        },
        {
          id: "fv_4HsTVDfaaTtnAkq5sKB1Raj4tg23G",
          featureType: "flat",
          unitOfMeasure: "units",
          config: {
            price: {
              dinero: {
                amount: 2000,
                currency: {
                  code: "USD",
                  base: 10,
                  exponent: 2,
                },
                scale: 2,
              },
              displayAmount: "20.00",
            },
          },
          metadata: {
            realtime: false,
            notifyUsageThreshold: 95,
            overageStrategy: "none",
            blockCustomer: false,
            hidden: false,
          },
          defaultQuantity: 1,
          limit: null,
          createdAtM: 0,
          updatedAtM: 0,
          projectId: "",
          planVersionId: "",
          featureId: "",
          order: 0,
          feature: {
            id: "feature_4HryYvFLF7qeKUuVZtjfixTcXJ5y",
            slug: "feature-2",
          } as Feature,
          billingConfig: billingConfig,
          type: "feature",
          resetConfig: null,
        },
      ],
      whenToBill: "pay_in_advance",
      gracePeriod: 0,
      metadata: null,
      createdAtM: 0,
      updatedAtM: 0,
      description: "",
      latest: true,
      title: "",
      tags: [],
      publishedAt: 0,
      publishedBy: "",
      archived: false,
      archivedAt: null,
      archivedBy: null,
      dueBehaviour: "cancel",
    }

    const result = calculateFlatPricePlan({ planVersion })
    expect(result.err).toBe(undefined)
    if (result.val) {
      expect(toDecimal(result.val.dinero)).toBe("50.00")
      expect(result.val.displayAmount).toBe("$50")
      expect(result.val.hasUsage).toBe(false)
    }
  })
})

describe("combined pricing scenarios", () => {
  it("flat + tier volume (with flat) + usage package (ceil) with prorate", () => {
    const flat = dinero({ amount: 1500, currency: currencies.USD }) // $15 flat feature

    // Tier volume: $2/unit + $5 flat, quantity=7 -> per-unit 7*2=14, subtotal adds flat (19), total prorates flat only 0.5 -> 14 + 2.5 = 16.5
    const tUnit = dinero({ amount: 200, currency: currencies.USD }) // $2
    const tFlat = dinero({ amount: 500, currency: currencies.USD }) // $5

    // Usage package: $3 per 4 units, quantity=9 -> ceil(9/4)=3 packages -> subtotal 3*$3=$9, total with 50% proration => $4.5
    const pkg = dinero({ amount: 300, currency: currencies.USD }) // $3 per 4 units

    const features: PlanVersionFeature[] = [
      {
        id: "f-flat-1",
        featureType: "flat",
        config: {
          price: { dinero: flat.toJSON(), displayAmount: "15.00" },
        },
      } as unknown as PlanVersionFeature,
      {
        id: "f-tier-vol",
        featureType: "tier",
        config: {
          tierMode: "volume",
          tiers: [
            {
              unitPrice: { dinero: tUnit.toJSON(), displayAmount: "2.00" },
              flatPrice: { dinero: tFlat.toJSON(), displayAmount: "5.00" },
              firstUnit: 1,
              lastUnit: null,
            },
          ],
        },
      } as unknown as PlanVersionFeature,
      {
        id: "f-usage-pkg",
        featureType: "usage",
        config: {
          usageMode: "package",
          units: 4,
          price: { dinero: pkg.toJSON(), displayAmount: "3.00" },
        },
      } as unknown as PlanVersionFeature,
    ]

    const { val, err } = calculateTotalPricePlan({
      features,
      quantities: { "f-tier-vol": 7, "f-usage-pkg": 9 },
      prorate: 0.5,
      currency: "USD",
    })

    expect(err).toBeUndefined()
    // Flat feature total with 50% proration: 15 * 0.5 = 7.5
    // Tier total: per-unit 14 + prorated flat 2.5 = 16.5
    // Usage package total: 3 packages * $3 not prorated = 9.0
    // Sum: 7.5 + 16.5 + 9.0 = 33.0
    expect(toDecimal(val!.dinero)).toBe("33.00")
  })

  it("graduated tier (with flat) + usage unit; flat prorated only", () => {
    const t1 = dinero({ amount: 100, currency: currencies.USD }) // $1
    const t2 = dinero({ amount: 50, currency: currencies.USD }) // $0.5
    const flatTier = dinero({ amount: 250, currency: currencies.USD }) // $2.5 flat at tier 2
    // quantity=8 => (1..5)*$1=$5 + (6..8)*$0.5=$1.5 => per-unit total $6.5
    // subtotal adds full flat $2.5 => $9.0
    // total adds prorated flat (0.5) => $6.5 + $1.25 = $7.75

    const usageUnit = dinero({ amount: 40, currency: currencies.USD }) // $0.40 per unit

    const features: PlanVersionFeature[] = [
      {
        id: "f-tier-grad",
        featureType: "tier",
        config: {
          tierMode: "graduated",
          tiers: [
            {
              unitPrice: { dinero: t1.toJSON(), displayAmount: "1.00" },
              flatPrice: {
                dinero: dinero({ amount: 0, currency: currencies.USD }).toJSON(),
                displayAmount: "0.00",
              },
              firstUnit: 1,
              lastUnit: 5,
            },
            {
              unitPrice: { dinero: t2.toJSON(), displayAmount: "0.50" },
              flatPrice: { dinero: flatTier.toJSON(), displayAmount: "2.50" },
              firstUnit: 6,
              lastUnit: null,
            },
          ],
        },
      } as unknown as PlanVersionFeature,
      {
        id: "f-usage-unit",
        featureType: "usage",
        config: {
          usageMode: "unit",
          price: { dinero: usageUnit.toJSON(), displayAmount: "0.40" },
        },
      } as unknown as PlanVersionFeature,
    ]

    const { val, err } = calculateTotalPricePlan({
      features,
      quantities: { "f-tier-grad": 8, "f-usage-unit": 3 }, // usage: 3 * 0.40 = 1.20 (no proration for usage)
      prorate: 0.5,
      currency: "USD",
    })

    expect(err).toBeUndefined()
    // Tier total (with prorated flat): 7.75, Usage unit: 1.20 => 8.95
    expect(toDecimal(val!.dinero)).toBe("8.95")
  })

  it("rounding: package ceil and proration at 0.333 on tier flat", () => {
    // Package: $1.25 per 3 units, quantity=7 -> ceil(7/3)=3 packages => subtotal $3.75, with 33.3% proration => total ~$1.25
    const pkg = dinero({ amount: 125, currency: currencies.USD })
    // Tier volume: $0.80 per unit + $0.90 flat, quantity=2 => per-unit $1.60, prorated flat at 0.333 => ~$0.30, total ~$1.90
    const unit = dinero({ amount: 80, currency: currencies.USD })
    const flat = dinero({ amount: 90, currency: currencies.USD })

    const features: PlanVersionFeature[] = [
      {
        id: "f-tier-vol-small",
        featureType: "tier",
        config: {
          tierMode: "volume",
          tiers: [
            {
              unitPrice: { dinero: unit.toJSON(), displayAmount: "0.80" },
              flatPrice: { dinero: flat.toJSON(), displayAmount: "0.90" },
              firstUnit: 1,
              lastUnit: null,
            },
          ],
        },
      } as unknown as PlanVersionFeature,
      {
        id: "f-usage-pkg-small",
        featureType: "usage",
        config: {
          usageMode: "package",
          units: 3,
          price: { dinero: pkg.toJSON(), displayAmount: "1.25" },
        },
      } as unknown as PlanVersionFeature,
    ]

    const prorate = 0.333 // 33.3%
    const { val, err } = calculateTotalPricePlan({
      features,
      quantities: { "f-tier-vol-small": 2, "f-usage-pkg-small": 7 },
      prorate,
      currency: "USD",
    })

    expect(err).toBeUndefined()
    // Tier: per-unit 2*0.80=1.60 + flat prorated (0.333*0.90 => using calculatePercentage rounding) => 1.60 + 0.30 = 1.90
    // Package: ceil(7/3)=3 packages * 1.25 not prorated => 3.75
    // Total expected 1.8997 + 3.75 => 5.6497
    expect(toDecimal(val!.dinero)).toBe("5.6497")
  })
})
