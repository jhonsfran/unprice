import * as currencies from "dinero.js/currencies"
import { dinero } from "dinero.js"
import { describe, expect, it } from "vitest"
import type { UsageGrant } from "./prices"
import { calculateWaterfallPrice } from "./prices"

describe("calculateWaterfallPrice", () => {
  const USD = currencies.USD
  const zeroUSD = dinero({ amount: 0, currency: USD })

  const usageConfig = {
    usageMode: "unit" as const,
    price: { dinero: dinero({ amount: 100, currency: USD }).toJSON(), displayAmount: "1.00" }, // $1.00 per unit
  }

  const tieredConfig = {
    usageMode: "tier" as const,
    tierMode: "graduated" as const,
    tiers: [
      {
        firstUnit: 1,
        lastUnit: 10,
        unitPrice: {
          dinero: dinero({ amount: 100, currency: USD }).toJSON(),
          displayAmount: "1.00",
        }, // $1.00
        flatPrice: { dinero: zeroUSD.toJSON(), displayAmount: "0.00" },
      },
      {
        firstUnit: 11,
        lastUnit: null,
        unitPrice: {
          dinero: dinero({ amount: 50, currency: USD }).toJSON(),
          displayAmount: "0.50",
        }, // $0.50
        flatPrice: { dinero: zeroUSD.toJSON(), displayAmount: "0.00" },
      },
    ],
  }

  it("single grant: calculates price within limit", () => {
    const grant: UsageGrant = {
      id: "grant1",
      limit: 100,
      priority: 1,
      config: usageConfig,
      prorate: 1,
    }

    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 50,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$50")
    expect(val!.items).toHaveLength(1)
    expect(val!.items[0]?.grantId).toBe("grant1")
    expect(val!.items[0]?.usage).toBe(50)
    expect(val!.items[0]?.isOverage).toBe(false)
  })

  it("single grant: calculates price exactly at limit", () => {
    const grant: UsageGrant = {
      id: "grant1",
      limit: 100,
      priority: 1,
      config: usageConfig,
      prorate: 1,
    }

    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 100,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$100")
    expect(val!.items).toHaveLength(1)
    expect(val!.items[0]?.usage).toBe(100)
    expect(val!.items[0]?.isOverage).toBe(false)
  })

  it("single grant: handles overage correctly (unit pricing)", () => {
    const grant: UsageGrant = {
      id: "grant1",
      limit: 10,
      priority: 1,
      config: usageConfig,
      prorate: 1,
    }

    // Usage 15: 10 at limit + 5 overage
    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 15,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$15")
    expect(val!.items).toHaveLength(2)

    // Base usage
    expect(val!.items[0]?.grantId).toBe("grant1")
    expect(val!.items[0]?.usage).toBe(10)
    expect(val!.items[0]?.price.totalPrice.displayAmount).toBe("$10")
    expect(val!.items[0]?.isOverage).toBe(false)

    // Overage usage
    expect(val!.items[1]?.grantId).toBe("grant1")
    expect(val!.items[1]?.usage).toBe(5)
    expect(val!.items[1]?.price.totalPrice.displayAmount).toBe("$5")
    expect(val!.items[1]?.isOverage).toBe(true)
  })

  it("single grant: handles overage correctly (tiered graduated pricing)", () => {
    const grant: UsageGrant = {
      id: "grant1",
      limit: 5, // Limit falls in first tier ($1.00)
      priority: 1,
      config: tieredConfig,
      prorate: 1,
    }

    // Usage 15:
    // First 5 (limit) -> Tier 1 ($1.00) -> $5.00
    // Next 5 (6-10) -> Tier 1 ($1.00) -> $5.00
    // Next 5 (11-15) -> Tier 2 ($0.50) -> $2.50
    // Total should be $12.50
    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 15,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$12.5")

    expect(val!.items).toHaveLength(2)

    // Base usage (within limit of 5)
    expect(val!.items[0]?.usage).toBe(5)
    expect(val!.items[0]?.price.totalPrice.displayAmount).toBe("$5")

    // Overage usage (10 units)
    // Overage cost = Cost(15) - Cost(5)
    // Cost(15) = (10 * 1.00) + (5 * 0.50) = 12.50
    // Cost(5) = 5.00
    // Delta = 7.50
    expect(val!.items[1]?.usage).toBe(10)
    expect(val!.items[1]?.price.totalPrice.displayAmount).toBe("$7.5")
    expect(val!.items[1]?.isOverage).toBe(true)
  })

  it("multiple grants: waterfall consumption by priority", () => {
    const grant1: UsageGrant = {
      id: "grant1",
      limit: 10,
      priority: 10, // Higher priority
      config: usageConfig, // $1.00
      prorate: 1,
    }
    const grant2: UsageGrant = {
      id: "grant2",
      limit: 10,
      priority: 5, // Lower priority
      config: {
        ...usageConfig,
        price: { dinero: dinero({ amount: 50, currency: USD }).toJSON(), displayAmount: "0.50" }, // $0.50
      },
      prorate: 1,
    }

    // Usage 15:
    // 10 from grant1 @ $1.00 = $10.00
    // 5 from grant2 @ $0.50 = $2.50
    // Total = $12.50
    const { val, err } = calculateWaterfallPrice({
      grants: [grant2, grant1], // Order shouldn't matter in input
      usage: 15,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$12.5")

    expect(val!.items).toHaveLength(2)
    expect(val!.items[0]?.grantId).toBe("grant1")
    expect(val!.items[0]?.usage).toBe(10)
    expect(val!.items[1]?.grantId).toBe("grant2")
    expect(val!.items[1]?.usage).toBe(5)
  })

  it("multiple grants: waterfall with overage on last grant", () => {
    const grant1: UsageGrant = {
      id: "grant1",
      limit: 10,
      priority: 10,
      config: usageConfig, // $1.00
      prorate: 1,
    }
    const grant2: UsageGrant = {
      id: "grant2",
      limit: 10,
      priority: 5,
      config: {
        ...usageConfig,
        price: { dinero: dinero({ amount: 200, currency: USD }).toJSON(), displayAmount: "2.00" }, // $2.00
      },
      prorate: 1,
    }

    // Usage 25:
    // 10 from grant1 @ $1.00 = $10.00
    // 10 from grant2 @ $2.00 = $20.00
    // 5 overage extended from grant2 @ $2.00 = $10.00
    // Total = $40.00
    const { val, err } = calculateWaterfallPrice({
      grants: [grant1, grant2],
      usage: 25,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$40")

    expect(val!.items).toHaveLength(3)
    expect(val!.items[0]?.grantId).toBe("grant1")
    expect(val!.items[1]?.grantId).toBe("grant2")
    expect(val!.items[1]?.isOverage).toBe(false)
    expect(val!.items[2]?.grantId).toBe("grant2") // Overage attributed to last grant
    expect(val!.items[2]?.isOverage).toBe(true)
    expect(val!.items[2]?.usage).toBe(5)
    expect(val!.items[2]?.price.totalPrice.displayAmount).toBe("$10")
  })

  it("no grants: returns zero price for usage", () => {
    const { val, err } = calculateWaterfallPrice({
      grants: [],
      usage: 100,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$0")
    expect(val!.items).toHaveLength(1)
    expect(val!.items[0]?.grantId).toBeNull()
    expect(val!.items[0]?.usage).toBe(100)
    expect(val!.items[0]?.isOverage).toBe(true)
  })

  it("zero usage: returns zero price", () => {
    const grant: UsageGrant = {
      id: "grant1",
      limit: 100,
      priority: 1,
      config: usageConfig,
      prorate: 1,
    }

    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 0,
      featureType: "usage",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$0")
    expect(val!.items).toHaveLength(0)
  })

  it("flat feature: ignores limits and calculates price based on quantity 1 (if logic permits)", () => {
    // Note: calculateWaterfallPrice uses calculatePricePerFeature which handles featureType 'flat' by forcing quantity=1
    // But calculateWaterfallPrice logic consumes "limit". For flat features, limit is usually irrelevant or 1.
    // If we pass a flat grant, it should just return the flat price.

    const flatConfig = {
      price: { dinero: dinero({ amount: 500, currency: USD }).toJSON(), displayAmount: "5.00" },
    }

    const grant: UsageGrant = {
      id: "grant1",
      limit: 1,
      priority: 1,
      config: flatConfig,
      prorate: 1,
    }

    const { val, err } = calculateWaterfallPrice({
      grants: [grant],
      usage: 1, // Usage doesn't really matter for flat price calculation internally, but waterfall logic consumes it
      featureType: "flat",
    })

    expect(err).toBeUndefined()
    expect(val!.totalPrice.totalPrice.displayAmount).toBe("$5")
  })
})
