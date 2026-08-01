import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  type MonetizationConfig,
  buildIntegrationContract,
  computeConfigHash,
  integrationContractSchema,
  monetizationConfigSchema,
  sha256Hex,
} from "./monetization"

// Two features, declared in an order that differs from their sorted order, so
// the hash's featureSlug sort is actually exercised by the reordering test.
const config: MonetizationConfig = {
  events: [
    { slug: "ai_completion", name: "AI completion" },
    { slug: "chat_request", name: "Chat request" },
  ],
  features: [
    { slug: "input-tokens", title: "Input tokens", unitOfMeasure: "token" },
    { slug: "chat-messages", title: "Chat messages", unitOfMeasure: "message" },
  ],
  plans: [
    {
      slug: "free",
      title: "Free",
      description: "Free tier",
      defaultPlan: true,
      version: {
        currency: "USD",
        paymentProvider: "sandbox",
        billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
        features: [
          {
            featureSlug: "input-tokens",
            featureType: "usage",
            config: { usageMode: "unit", price: "0.000002" },
            meterConfig: {
              eventSlug: "ai_completion",
              aggregationMethod: "sum",
              aggregationField: "input_tokens",
            },
            limit: 20,
            resetConfig: { interval: "day" },
          },
          {
            featureSlug: "chat-messages",
            featureType: "usage",
            config: { usageMode: "unit", price: "0" },
            meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
            limit: 20,
            resetConfig: { interval: "day", intervalCount: 1 },
          },
        ],
      },
    },
  ],
}

const countMeter = { eventSlug: "ai_completion", aggregationMethod: "count" }

/** Replaces the first priced feature, for cases the boundary must reject. */
function withFirstFeature(feature: unknown) {
  const invalid = structuredClone(config) as unknown as {
    plans: { version: { features: unknown[] } }[]
  }
  invalid.plans[0]!.version.features[0] = feature
  return invalid
}

/** Rebuilds every object with its keys in the opposite order. */
function withReversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withReversedKeys)

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, withReversedKeys(entry)])
    )
  }

  return value
}

describe("monetizationConfigSchema", () => {
  it("accepts slugs and decimal strings at the boundary", () => {
    expect(() => monetizationConfigSchema.parse(config)).not.toThrow()
  })

  it("rejects internal identifiers and Dinero snapshots", () => {
    expect(() =>
      monetizationConfigSchema.parse({
        ...config,
        plans: [{ ...config.plans[0]!, version: { ...config.plans[0]!.version, planId: "pl_1" } }],
      })
    ).toThrow()
  })

  it("rejects a non-count aggregation without a field", () => {
    const invalid = structuredClone(config)
    invalid.plans[0]!.version.features[0]!.meterConfig!.aggregationField = undefined
    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(/aggregationField/i)
  })

  it("rejects a meter pointing at an undeclared event", () => {
    const invalid = structuredClone(config)
    invalid.plans[0]!.version.features[0]!.meterConfig!.eventSlug = "nope"
    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(/nope/)
  })

  it("rejects zero or more than one default plan", () => {
    const none = structuredClone(config)
    none.plans[0]!.defaultPlan = false
    expect(() => monetizationConfigSchema.parse(none)).toThrow(/default/i)
  })

  it("rejects two plans claiming the default", () => {
    const two = structuredClone(config)
    two.plans.push({ ...structuredClone(two.plans[0]!), slug: "pro", title: "Pro" })
    expect(() => monetizationConfigSchema.parse(two)).toThrow(/default/i)
  })

  it("rejects a priced feature that is not declared in the document", () => {
    const invalid = structuredClone(config)
    invalid.plans[0]!.version.features[0]!.featureSlug = "unknown-feature"
    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(/unknown-feature/)
  })

  // The pricing rules below all come from `planVersionFeatureInsertBaseSchema`;
  // the boundary delegates to it rather than restating them.
  it.each([
    [
      "an empty config",
      { featureSlug: "input-tokens", featureType: "usage", config: {}, meterConfig: countMeter },
      /usageMode/i,
    ],
    [
      "a flat feature carrying a meterConfig",
      {
        featureSlug: "input-tokens",
        featureType: "flat",
        config: { price: "1" },
        meterConfig: countMeter,
      },
      /meter config is only supported for usage/i,
    ],
    [
      "unit-mode usage without a price",
      {
        featureSlug: "input-tokens",
        featureType: "usage",
        config: { usageMode: "unit" },
        meterConfig: countMeter,
      },
      /price is required/i,
    ],
    [
      "tiers with a gap",
      {
        featureSlug: "input-tokens",
        featureType: "usage",
        config: {
          usageMode: "tier",
          tierMode: "graduated",
          tiers: [
            { firstUnit: 1, lastUnit: 10, unitPrice: "1", flatPrice: "0" },
            { firstUnit: 20, lastUnit: null, unitPrice: "1", flatPrice: "0" },
          ],
        },
        meterConfig: countMeter,
      },
      /consecutive/i,
    ],
    [
      "a usage feature without a meter",
      {
        featureSlug: "input-tokens",
        featureType: "usage",
        config: { usageMode: "unit", price: "1" },
      },
      /meter config is required/i,
    ],
    [
      "a config field that does not apply to the feature type",
      {
        featureSlug: "input-tokens",
        featureType: "flat",
        config: {
          price: "1",
          tiers: [{ firstUnit: 1, lastUnit: null, unitPrice: "1", flatPrice: "0" }],
        },
      },
      /tiers.*does not apply to a flat feature/,
    ],
  ])("rejects %s", (_label, feature, message) => {
    expect(() => monetizationConfigSchema.parse(withFirstFeature(feature))).toThrow(message)
  })

  it("accepts a zero limit, as the internal schema does", () => {
    const zeroed = structuredClone(config)
    zeroed.plans[0]!.version.features[0]!.limit = 0
    expect(() => monetizationConfigSchema.parse(zeroed)).not.toThrow()
  })

  it("rejects a Dinero snapshot where a decimal string is expected", () => {
    const invalid = structuredClone(config)
    expect(() =>
      monetizationConfigSchema.parse({
        ...invalid,
        plans: [
          {
            ...invalid.plans[0]!,
            version: {
              ...invalid.plans[0]!.version,
              features: [
                {
                  ...invalid.plans[0]!.version.features[0]!,
                  config: {
                    usageMode: "unit",
                    price: {
                      dinero: {
                        amount: 2,
                        currency: { code: "USD", base: 10, exponent: 2 },
                        scale: 8,
                      },
                      displayAmount: "0.000002",
                    },
                  },
                },
              ],
            },
          },
        ],
      })
    ).toThrow()
  })
})

describe("computeConfigHash", () => {
  it("is stable across feature and key ordering", () => {
    const reordered = structuredClone(config)
    reordered.plans[0]!.version.features.push(reordered.plans[0]!.version.features.shift()!)

    // Guard against the fixture silently making this a no-op again.
    expect(reordered.plans[0]!.version.features.map((feature) => feature.featureSlug)).not.toEqual(
      config.plans[0]!.version.features.map((feature) => feature.featureSlug)
    )
    expect(computeConfigHash(reordered.plans[0]!)).toBe(computeConfigHash(config.plans[0]!))
  })

  it("is stable when object keys are reordered at every level", () => {
    const rekeyed = withReversedKeys(config.plans[0]) as MonetizationConfig["plans"][number]

    expect(Object.keys(rekeyed.version)).not.toEqual(Object.keys(config.plans[0]!.version))
    expect(Object.keys(rekeyed.version.billingConfig)).not.toEqual(
      Object.keys(config.plans[0]!.version.billingConfig)
    )
    expect(Object.keys(rekeyed.version.features[0]!.config)).not.toEqual(
      Object.keys(config.plans[0]!.version.features[0]!.config)
    )
    expect(Object.keys(rekeyed.version.features[0]!.meterConfig!)).not.toEqual(
      Object.keys(config.plans[0]!.version.features[0]!.meterConfig!)
    )
    expect(Object.keys(rekeyed.version.features[1]!.resetConfig!)).not.toEqual(
      Object.keys(config.plans[0]!.version.features[1]!.resetConfig!)
    )
    expect(computeConfigHash(rekeyed)).toBe(computeConfigHash(config.plans[0]!))
  })

  it("ignores plan title and description", () => {
    const renamed = structuredClone(config)
    renamed.plans[0]!.title = "Free forever"
    renamed.plans[0]!.description = "Renamed and re-described"
    expect(computeConfigHash(renamed.plans[0]!)).toBe(computeConfigHash(config.plans[0]!))
  })

  it("changes when a price, limit, reset, currency, or billing interval changes", () => {
    for (const mutate of [
      (c: typeof config) => {
        c.plans[0]!.version.features[0]!.config.price = "0.000003"
      },
      (c: typeof config) => {
        c.plans[0]!.version.features[0]!.limit = 21
      },
      (c: typeof config) => {
        c.plans[0]!.version.features[0]!.resetConfig!.interval = "month"
      },
      (c: typeof config) => {
        c.plans[0]!.version.currency = "EUR"
      },
      (c: typeof config) => {
        c.plans[0]!.version.billingConfig.interval = "year"
      },
    ]) {
      const changed = structuredClone(config)
      mutate(changed)
      expect(computeConfigHash(changed.plans[0]!)).not.toBe(computeConfigHash(config.plans[0]!))
    }
  })

  it("is stable across two plans that describe the same version", () => {
    const twin = structuredClone(config)
    twin.plans[0]!.slug = "starter"
    twin.plans[0]!.defaultPlan = false
    expect(computeConfigHash(twin.plans[0]!)).toBe(computeConfigHash(config.plans[0]!))
  })

  it("returns a lowercase hex sha-256 digest", () => {
    expect(computeConfigHash(config.plans[0]!)).toMatch(/^[0-9a-f]{64}$/)
  })

  // The hash must be taken from parse output, never from a raw request body:
  // priceSchema and billingIntervalCountSchema coerce, so these two documents
  // are the same configuration but differ byte-for-byte before validation.
  it("agrees across coerced and already-typed input once parsed", () => {
    const coerced = structuredClone(config) as unknown as {
      plans: {
        version: {
          billingConfig: Record<string, unknown>
          features: Record<string, unknown>[]
        }
      }[]
    }
    const version = coerced.plans[0]!.version
    const feature = version.features[0]!

    version.billingConfig.intervalCount = "1"
    feature.limit = "20"
    ;(feature.config as Record<string, unknown>).price = 0.000002

    expect(computeConfigHash(monetizationConfigSchema.parse(coerced).plans[0]!)).toBe(
      computeConfigHash(monetizationConfigSchema.parse(config).plans[0]!)
    )
  })
})

describe("sha256Hex", () => {
  // Known-answer vectors: empty input, a single-block input, and an input long
  // enough to force a second padding block.
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %j", (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  // The runtime digest is hand-rolled because it has to stay synchronous in
  // Workers and browser bundles; cross-check it against a reference
  // implementation over multi-byte and multi-block inputs.
  it("matches node crypto for utf-8 and multi-block inputs", () => {
    const inputs = [
      "",
      "a",
      "ü — üñïçôdé",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "x".repeat(1000),
      JSON.stringify(config),
    ]

    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"))
    }
  })
})

describe("buildIntegrationContract", () => {
  const contractConfig: MonetizationConfig = {
    events: [
      { slug: "ai_completion", name: "AI completion" },
      { slug: "chat_request", name: "Chat request" },
    ],
    features: [
      { slug: "input-tokens", title: "Input tokens", unitOfMeasure: "token" },
      { slug: "chat-messages", title: "Chat messages", unitOfMeasure: "message" },
      { slug: "reasoning-model", title: "Reasoning model", unitOfMeasure: "access" },
      { slug: "audit-log", title: "Audit log", unitOfMeasure: "log" },
      { slug: "never-priced", title: "Never priced", unitOfMeasure: "units" },
    ],
    plans: [
      {
        slug: "free",
        title: "Free",
        defaultPlan: true,
        version: {
          currency: "USD",
          paymentProvider: "sandbox",
          billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
          features: [
            {
              featureSlug: "input-tokens",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.000002" },
              meterConfig: {
                eventSlug: "ai_completion",
                aggregationMethod: "sum",
                aggregationField: "input_tokens",
              },
              limit: 20,
            },
            {
              featureSlug: "chat-messages",
              featureType: "usage",
              config: { usageMode: "unit", price: "0" },
              meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
              limit: 20,
            },
            {
              featureSlug: "reasoning-model",
              featureType: "flat",
              config: { price: "0" },
            },
            {
              featureSlug: "audit-log",
              featureType: "usage",
              config: { usageMode: "unit", price: "0" },
              meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
            },
          ],
        },
      },
    ],
  }

  it("classifies every priced feature and skips unpriced declarations", () => {
    const contract = buildIntegrationContract(contractConfig, { free: "pv_free" })

    expect(contract.features).toEqual([
      { slug: "input-tokens", kind: "run-budget", eventSlug: "ai_completion", planSlugs: ["free"] },
      { slug: "chat-messages", kind: "usage-gate", eventSlug: "chat_request", planSlugs: ["free"] },
      { slug: "reasoning-model", kind: "flat-access", eventSlug: null, planSlugs: ["free"] },
      { slug: "audit-log", kind: "usage-evidence", eventSlug: "chat_request", planSlugs: ["free"] },
    ])
  })

  it("reports each event with the numeric properties its meters aggregate", () => {
    const contract = buildIntegrationContract(contractConfig, { free: "pv_free" })

    expect(contract.events).toEqual([
      { slug: "ai_completion", name: "AI completion", requiredProperties: ["input_tokens"] },
      { slug: "chat_request", name: "Chat request", requiredProperties: [] },
    ])
  })

  it("resolves the default plan version and warns about usage unknown before the work runs", () => {
    const contract = buildIntegrationContract(contractConfig, { free: "pv_free" })

    expect(contract.defaultPlan.slug).toBe("free")
    expect(contract.defaultPlan.planVersionId).toBe("pv_free")
    expect(contract.defaultPlan.note).toMatch(/signUp/)
    expect(contract.warnings).toHaveLength(1)
    expect(contract.warnings[0]?.featureSlug).toBe("input-tokens")
    expect(contract.warnings[0]?.message).toMatch(/usage\.record/)
    expect(() => integrationContractSchema.parse(contract)).not.toThrow()
  })

  it("throws when a plan has no resolved plan version", () => {
    expect(() => buildIntegrationContract(contractConfig, {})).toThrow(/free/)
  })
})
