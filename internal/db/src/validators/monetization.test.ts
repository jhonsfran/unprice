import { describe, expect, it } from "vitest"
import {
  type MonetizationConfig,
  buildIntegrationContract,
  computeConfigHash,
  integrationContractSchema,
  monetizationConfigSchema,
  monetizationVersionSchema,
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
            resetConfig: { interval: "day", intervalCount: 1 },
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
    ).toThrow(/Unrecognized key\(s\) in object: 'planId'/)
  })

  // An agent repairs its own document, so it navigates by path, not by prose.
  it("points at the offending node with a usable path", () => {
    const invalid = structuredClone(config)
    invalid.plans[0]!.version.features[0]!.meterConfig!.eventSlug = "nope"
    const result = monetizationConfigSchema.safeParse(invalid)

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([
      "plans",
      0,
      "version",
      "features",
      0,
      "meterConfig",
      "eventSlug",
    ])
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
    expect(() => monetizationConfigSchema.parse(none)).toThrow(/found 0/)

    const two = structuredClone(config)
    two.plans.push({ ...structuredClone(two.plans[0]!), slug: "pro", title: "Pro" })
    expect(() => monetizationConfigSchema.parse(two)).toThrow(/found 2/)
  })

  it("rejects a priced feature that is not declared in the document", () => {
    const invalid = structuredClone(config)
    invalid.plans[0]!.version.features[0]!.featureSlug = "unknown-feature"
    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(/unknown-feature/)
  })

  // Duplicate slugs are a realistic mistake when an agent regenerates a document,
  // and every downstream slug-to-id map assumes they cannot happen.
  //
  // Asserted on the unescaped issue message: ZodError.message is a JSON dump, so
  // a regex containing quotes would never match the escaped form.
  it.each([
    [
      "a duplicate event slug",
      (invalid: MonetizationConfig) => {
        invalid.events.push({ ...invalid.events[0]! })
      },
      'Duplicate slug "ai_completion" in events',
    ],
    [
      "a duplicate feature slug",
      (invalid: MonetizationConfig) => {
        invalid.features.push({ ...invalid.features[0]! })
      },
      'Duplicate slug "input-tokens" in features',
    ],
    [
      "a duplicate plan slug",
      (invalid: MonetizationConfig) => {
        invalid.plans.push({ ...structuredClone(invalid.plans[0]!), defaultPlan: false })
      },
      'Duplicate slug "free" in plans',
    ],
    [
      "the same feature priced twice in one plan",
      (invalid: MonetizationConfig) => {
        invalid.plans[0]!.version.features.push(
          structuredClone(invalid.plans[0]!.version.features[0]!)
        )
      },
      'Feature "input-tokens" is priced twice in plan "free"',
    ],
  ])("rejects %s", (_label, mutate, message) => {
    const invalid = structuredClone(config)
    mutate(invalid)
    const result = monetizationConfigSchema.safeParse(invalid)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(message)
  })

  it("rejects one feature metering different events across plans", () => {
    const invalid = structuredClone(config)
    const second = structuredClone(invalid.plans[0]!)
    second.slug = "pro"
    second.defaultPlan = false
    second.version.features[0]!.meterConfig!.eventSlug = "chat_request"
    invalid.plans.push(second)

    const result = monetizationConfigSchema.safeParse(invalid)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'Feature "input-tokens" meters event "ai_completion" in another plan; one feature must meter one event'
    )
  })

  // filters, groupBy and windowSize are "TODO: implement this later" in shared.ts.
  it.each(["filters", "groupBy", "windowSize"])(
    "rejects the unimplemented meter field %s",
    (field) => {
      const invalid = structuredClone(config) as unknown as {
        plans: { version: { features: { meterConfig: Record<string, unknown> }[] } }[]
      }
      invalid.plans[0]!.version.features[0]!.meterConfig[field] =
        field === "groupBy" ? ["a"] : field === "windowSize" ? "HOUR" : { a: "b" }

      expect(() => monetizationConfigSchema.parse(invalid)).toThrow(
        new RegExp(`Unrecognized key\\(s\\) in object: '${field}'`)
      )
    }
  )

  // resolveResetConfigForFeature discards it for every non-usage feature, so
  // accepting it would hash a field that changes nothing.
  it.each(["flat", "tier", "package"])("rejects a resetConfig on a %s feature", (featureType) => {
    const configs: Record<string, unknown> = {
      flat: { price: "1" },
      tier: {
        tierMode: "volume",
        tiers: [{ firstUnit: 1, lastUnit: null, unitPrice: "1", flatPrice: "0" }],
      },
      package: { price: "10", units: 5 },
    }
    const result = monetizationConfigSchema.safeParse(
      withFirstFeature({
        featureSlug: "input-tokens",
        featureType,
        config: configs[featureType],
        resetConfig: { interval: "day", intervalCount: 1 },
      })
    )

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      `"resetConfig" does not apply to a ${featureType} feature`
    )
    expect(result.error?.issues[0]?.path).toEqual([
      "plans",
      0,
      "version",
      "features",
      0,
      "resetConfig",
    ])
  })

  it("rejects an unknown key inside a price config", () => {
    const invalid = structuredClone(config) as unknown as {
      plans: { version: { features: { config: Record<string, unknown> }[] } }[]
    }
    invalid.plans[0]!.version.features[0]!.config.discount = "0.5"

    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(
      /Unrecognized key\(s\) in object: 'discount'/
    )
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

  // Blanket coercion would turn all of these into a silent zero allowance that
  // denies everything, or into a negative one. `limit` is a money-path field, so
  // it takes an accept-list rather than whatever Number() makes of the input.
  it.each([
    [0, 0],
    [20, 20],
    ["20", 20],
  ])("accepts the limit %j as %i", (input, expected) => {
    const limited = structuredClone(config) as unknown as {
      plans: { version: { features: Record<string, unknown>[] } }[]
    }
    limited.plans[0]!.version.features[0]!.limit = input

    expect(monetizationConfigSchema.parse(limited).plans[0]!.version.features[0]!.limit).toBe(
      expected
    )
  })

  it.each([
    [null, /limit must be omitted/],
    [false, /limit/],
    [true, /limit/],
    ["", /limit/],
    [" ", /limit/],
    [[], /limit/],
    ["1e3", /limit/],
    [-5, /limit/],
    [1.5, /limit/],
  ])("rejects the limit %j", (input, message) => {
    const invalid = structuredClone(config) as unknown as {
      plans: { version: { features: Record<string, unknown>[] } }[]
    }
    invalid.plans[0]!.version.features[0]!.limit = input

    expect(() => monetizationConfigSchema.parse(invalid)).toThrow(message)
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

  it("is stable when nested object keys are reordered", () => {
    const rekeyed = withReversedKeys(config.plans[0]) as MonetizationConfig["plans"][number]

    // computeConfigHash spreads the version, which preserves source key order,
    // so every level below is order-insensitive only because canonicalJson sorts
    // keys recursively.
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

  // Guards against the hash and the schema drifting into two independent field
  // lists: a version field that stops affecting the hash lets two different
  // configurations collide onto one plan version.
  it("covers every field monetizationVersionSchema declares", () => {
    for (const field of Object.keys(monetizationVersionSchema.shape)) {
      const changed = structuredClone(config)
      const version = changed.plans[0]!.version as unknown as Record<string, unknown>

      if (field === "features") {
        version.features = (version.features as unknown[]).slice(0, 1)
      } else {
        delete version[field]
      }

      expect(computeConfigHash(changed.plans[0]!), `${field} must affect the hash`).not.toBe(
        computeConfigHash(config.plans[0]!)
      )
    }
  })

  // An omitted resetConfig is resolved downstream as a copy of the billing
  // cadence, so writing that cadence out is the same configuration and must not
  // produce a second draft version.
  it("treats an omitted resetConfig as the billing cadence", () => {
    const omitted = structuredClone(config) as unknown as {
      plans: { version: { features: Record<string, unknown>[] } }[]
    }
    delete omitted.plans[0]!.version.features[0]!.resetConfig

    const spelledOut = structuredClone(config)
    spelledOut.plans[0]!.version.features[0]!.resetConfig = { interval: "month", intervalCount: 1 }

    expect(computeConfigHash(monetizationConfigSchema.parse(omitted).plans[0]!)).toBe(
      computeConfigHash(monetizationConfigSchema.parse(spelledOut).plans[0]!)
    )

    // A cadence that is genuinely different still changes the hash: the fixture
    // resets daily on a monthly plan.
    expect(computeConfigHash(monetizationConfigSchema.parse(omitted).plans[0]!)).not.toBe(
      computeConfigHash(monetizationConfigSchema.parse(config).plans[0]!)
    )
  })

  // resetConfig.intervalCount defaults to 1, so an omitted count and an explicit
  // one are the same cadence and must not produce two draft versions.
  it("treats an omitted resetConfig.intervalCount as the explicit default", () => {
    const omitted = structuredClone(config) as unknown as {
      plans: { version: { features: { resetConfig: Record<string, unknown> }[] } }[]
    }
    // An absent key, which is what an agent that never read the default writes.
    delete omitted.plans[0]!.version.features[0]!.resetConfig.intervalCount

    expect(computeConfigHash(monetizationConfigSchema.parse(omitted).plans[0]!)).toBe(
      computeConfigHash(monetizationConfigSchema.parse(config).plans[0]!)
    )
  })

  it("hashes an omitted limit stably, and differently from a set one", () => {
    const omitted = structuredClone(config)
    // An absent key, not an undefined one: that is what an agent actually writes.
    delete omitted.plans[0]!.version.features[0]!.limit
    const parsed = monetizationConfigSchema.parse(omitted)

    expect(parsed.plans[0]!.version.features[0]!.limit).toBeUndefined()
    expect(computeConfigHash(parsed.plans[0]!)).not.toBe(computeConfigHash(config.plans[0]!))

    // An explicitly undefined limit is the same configuration, not a third one.
    const explicit = structuredClone(config)
    explicit.plans[0]!.version.features[0]!.limit = undefined
    expect(computeConfigHash(monetizationConfigSchema.parse(explicit).plans[0]!)).toBe(
      computeConfigHash(parsed.plans[0]!)
    )
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

    // The hazard the doc comment warns about: unparsed, the two disagree.
    expect(
      computeConfigHash(coerced.plans[0] as unknown as MonetizationConfig["plans"][number])
    ).not.toBe(computeConfigHash(config.plans[0]!))

    expect(computeConfigHash(monetizationConfigSchema.parse(coerced).plans[0]!)).toBe(
      computeConfigHash(monetizationConfigSchema.parse(config).plans[0]!)
    )
  })
})

describe("buildIntegrationContract", () => {
  // Parsed, not hand-built: the function documents its input as a validated
  // configuration, and a fixture that never parses cannot prove that holds.
  //
  // Two plans on purpose. `chat-messages` is a synchronous gate on free and a
  // budgeted run on pro, so the "most demanding plan wins" rule has to fire;
  // `input-tokens` is priced on both, so the warning has to be deduplicated;
  // and `ai_completion` collects one aggregation field from each plan, so the
  // required-property ordering has to be sorted rather than insertion-ordered.
  const contractConfig = monetizationConfigSchema.parse({
    events: [
      { slug: "ai_completion", name: "AI completion" },
      { slug: "chat_request", name: "Chat request" },
    ],
    features: [
      { slug: "input-tokens", title: "Input tokens", unitOfMeasure: "token" },
      { slug: "output-tokens", title: "Output tokens", unitOfMeasure: "token" },
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
      {
        slug: "pro",
        title: "Pro",
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
              limit: 2000,
            },
            {
              featureSlug: "output-tokens",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.000004" },
              meterConfig: {
                eventSlug: "ai_completion",
                aggregationMethod: "sum",
                aggregationField: "completion_tokens",
              },
            },
            {
              featureSlug: "chat-messages",
              featureType: "usage",
              config: { usageMode: "unit", price: "0.01" },
              meterConfig: {
                eventSlug: "chat_request",
                aggregationMethod: "sum",
                aggregationField: "tokens",
              },
              limit: 5000,
            },
          ],
        },
      },
    ],
  })

  const resolved = { free: "pv_free", pro: "pv_pro" }

  it("classifies every priced feature and skips unpriced declarations", () => {
    const contract = buildIntegrationContract(contractConfig, resolved)

    expect(contract.features).toEqual([
      {
        slug: "input-tokens",
        kind: "run-budget",
        eventSlug: "ai_completion",
        planSlugs: ["free", "pro"],
      },
      {
        slug: "output-tokens",
        kind: "usage-evidence",
        eventSlug: "ai_completion",
        planSlugs: ["pro"],
      },
      // A gate on free and a budgeted run on pro: the integration has to satisfy
      // the more demanding plan, so run-budget wins.
      {
        slug: "chat-messages",
        kind: "run-budget",
        eventSlug: "chat_request",
        planSlugs: ["free", "pro"],
      },
      { slug: "reasoning-model", kind: "flat-access", eventSlug: null, planSlugs: ["free"] },
      { slug: "audit-log", kind: "usage-evidence", eventSlug: "chat_request", planSlugs: ["free"] },
    ])
  })

  it("reports each event with the numeric properties its meters aggregate, sorted", () => {
    const contract = buildIntegrationContract(contractConfig, resolved)

    expect(contract.events).toEqual([
      {
        slug: "ai_completion",
        name: "AI completion",
        requiredProperties: ["completion_tokens", "input_tokens"],
      },
      { slug: "chat_request", name: "Chat request", requiredProperties: ["tokens"] },
    ])
  })

  it("resolves the default plan version and warns about usage unknown before the work runs", () => {
    const contract = buildIntegrationContract(contractConfig, resolved)

    expect(contract.defaultPlan.slug).toBe("free")
    expect(contract.defaultPlan.planVersionId).toBe("pv_free")
    expect(contract.defaultPlan.note).toMatch(/signUp/)

    // One warning per feature, not per plan that prices it.
    expect(contract.warnings.map((warning) => warning.featureSlug)).toEqual([
      "input-tokens",
      "output-tokens",
      "chat-messages",
    ])
    expect(contract.warnings[0]?.message).toMatch(/usage\.record/)
    expect(() => integrationContractSchema.parse(contract)).not.toThrow()
  })

  it("throws when a plan has no resolved plan version", () => {
    expect(() => buildIntegrationContract(contractConfig, { pro: "pv_pro" })).toThrow(/free/)
  })

  it("throws when no plan is the default", () => {
    const orphaned = structuredClone(contractConfig)
    orphaned.plans[0]!.defaultPlan = false

    expect(() => buildIntegrationContract(orphaned, resolved)).toThrow(/no default plan/)
  })
})
