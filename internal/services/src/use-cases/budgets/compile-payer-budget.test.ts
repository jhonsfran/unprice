import { rateDecimalSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { PAYER_HOLDS, type PayerBudgetSource, compilePayerBudget } from "./compile-payer-budget"

const hour = 60 * 60 * 1000
const day = 24 * hour
const NOV = Date.parse("2026-11-01T00:00:00.000Z")
const NOV_15 = Date.parse("2026-11-15T00:00:00.000Z")
const DEC = Date.parse("2026-12-01T00:00:00.000Z")
const NOW = Date.parse("2026-11-10T12:00:00.000Z")
/** A month anchored on the 1st at midnight, as the budget stores it: its earliest equivalent. */
const FIRST_OF_MONTH = Date.UTC(1970, 0, 1)

const amount = (decimal: string) => rateDecimalSchema.parse(decimal)

type Phase = PayerBudgetSource["phases"][number]
type Item = Phase["items"][number]
type Feature = Item["feature"]

const monthly = {
  name: "monthly",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: 1,
  planType: "recurring",
} as const

function feature(slug: string, overrides: Partial<Feature> = {}): Feature {
  return {
    slug,
    featureType: "usage",
    meterConfig: null,
    included: null,
    billingConfig: monthly,
    resetConfig: null,
    overageStrategy: "none",
    ...overrides,
  }
}

const count = (eventSlug: string) => ({
  eventId: `ev_${eventSlug}`,
  eventSlug,
  aggregationMethod: "count" as const,
})

const sum = (eventSlug: string, field: string, groupBy?: string[]) => ({
  eventId: `ev_${eventSlug}`,
  eventSlug,
  aggregationMethod: "sum" as const,
  aggregationField: field,
  ...(groupBy && { groupBy }),
})

/** The item's November billing period, unless it says otherwise. */
function item(f: Feature, periods: Item["billingPeriods"] = [novemberOf(f.slug)]): Item {
  return { feature: f, billingPeriods: periods }
}

function novemberOf(slug: string) {
  return { id: `bp_${slug}_nov`, statementKey: "sk_nov", start: NOV, end: DEC }
}

function phase(overrides: Partial<Phase>): Phase {
  return {
    id: "phase_1",
    startAt: NOV,
    endAt: null,
    subscriptionEndsAt: null,
    billingAnchor: 1,
    creditLinePolicy: "uncapped",
    currency: "USD",
    card: null,
    items: [],
    ...overrides,
  }
}

function source(phases: Phase[], grants: PayerBudgetSource["grants"] = [], now = NOW) {
  return { projectId: "proj_1", customerId: "cus_1", now, phases, grants }
}

function compiled(input: PayerBudgetSource) {
  const result = compilePayerBudget(input)
  if (result.err) throw result.err
  return result.val
}

const statement = (slug: string, id: string, key: string, start: number, end: number) => ({
  periodId: `${slug}:${id}`,
  statementKey: key,
  featureSlug: slug,
  start,
  end,
})

describe("compilePayerBudget", () => {
  it("compiles a free plan: free meters without a card, its allowance as a hard monthly limit", () => {
    const apiCalls = feature("api_calls", { meterConfig: count("api.call") })
    const projects = feature("projects", { featureType: "flat" })
    const free = phase({ items: [item(apiCalls), item(projects, [])] })
    const grants = [
      { featureSlug: "api_calls", allowanceUnits: 1000, effectiveAt: NOV, expiresAt: null },
    ]

    expect(compiled(source([free], grants))).toEqual({
      phaseId: "phase_1",
      budget: {
        key: "unprice:customer:cus_1",
        unit: "money:USD",
        config: {
          limits: [
            {
              id: `api_calls:month:${FIRST_OF_MONTH}`,
              amount: amount("1000"),
              window: "month",
              anchor: FIRST_OF_MONTH,
              enforce: "hard",
              measure: { type: "quantity", feature: "api_calls" },
            },
          ],
          holds: PAYER_HOLDS,
          onUnavailable: "deny",
          closesAt: null,
          pricing: {
            features: [
              {
                slug: "api_calls",
                eventSlug: "api.call",
                meterProperty: null,
                dimensions: [],
                included: null,
                priced: false,
              },
            ],
            statements: "required",
            funding: { mode: "postpaid" },
          },
        },
      },
      statements: [statement("api_calls", "bp_api_calls_nov", "sk_nov", NOV, DEC)],
    })
  })

  it("compiles a flat seat plan with tokens priced per model by the card, without a cap", () => {
    const seats = feature("seats", { featureType: "package" })
    const tokens = feature("llm_tokens", { meterConfig: sum("ai.call", "tokens", ["model"]) })
    const pro = phase({
      card: { id: "rc_usd", unit: "money:USD" },
      items: [item(seats, []), item(tokens)],
    })
    const grants = [
      { featureSlug: "seats", allowanceUnits: 5, effectiveAt: NOV, expiresAt: null },
      { featureSlug: "llm_tokens", allowanceUnits: null, effectiveAt: NOV, expiresAt: null },
    ]

    const { budget, statements } = compiled(source([pro], grants))

    expect(budget).toEqual({
      key: "unprice:customer:cus_1",
      unit: "money:USD",
      config: {
        limits: [],
        holds: PAYER_HOLDS,
        onUnavailable: "deny",
        closesAt: null,
        pricing: {
          cards: { base: "rc_usd" },
          features: [
            {
              slug: "llm_tokens",
              eventSlug: "ai.call",
              meterProperty: "tokens",
              dimensions: ["model"],
              included: null,
              priced: true,
            },
          ],
          statements: "required",
          funding: { mode: "postpaid" },
        },
      },
    })
    expect(statements).toEqual([statement("llm_tokens", "bp_llm_tokens_nov", "sk_nov", NOV, DEC)])
  })

  it("compiles graduated API calls with an included allowance and a soft limit reset daily at 01:00", () => {
    const apiCalls = feature("api_calls", {
      meterConfig: sum("api.batch", "calls"),
      included: "1000",
      overageStrategy: "always",
      resetConfig: {
        name: "daily",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 1,
        planType: "recurring",
      },
    })
    const growth = phase({ card: { id: "rc_usd", unit: "money:USD" }, items: [item(apiCalls)] })
    const grants = [
      { featureSlug: "api_calls", allowanceUnits: 40_000, effectiveAt: NOV, expiresAt: null },
      { featureSlug: "api_calls", allowanceUnits: 10_000, effectiveAt: NOV, expiresAt: DEC },
      // expired before now: it no longer counts
      { featureSlug: "api_calls", allowanceUnits: 99_000, effectiveAt: NOV, expiresAt: NOV + day },
    ]

    const { budget } = compiled(source([growth], grants))

    expect(budget.config.limits).toEqual([
      {
        id: "api_calls:day:3600000",
        amount: amount("50000"),
        window: "day",
        anchor: hour,
        enforce: "soft",
        measure: { type: "quantity", feature: "api_calls" },
      },
    ])
    expect(budget.config.pricing?.features).toEqual([
      {
        slug: "api_calls",
        eventSlug: "api.batch",
        meterProperty: "calls",
        dimensions: [],
        included: amount("1000"),
        priced: true,
      },
    ])
  })

  it("funds a capped plan's priced usage from the customer's wallet", () => {
    const credits = feature("ai_credits", { meterConfig: sum("ai.call", "credits") })
    const prepaid = phase({
      creditLinePolicy: "capped",
      card: { id: "rc_usd", unit: "money:USD" },
      items: [item(credits)],
    })

    expect(compiled(source([prepaid])).budget.config.pricing).toEqual({
      cards: { base: "rc_usd" },
      features: [
        {
          slug: "ai_credits",
          eventSlug: "ai.call",
          meterProperty: "credits",
          dimensions: [],
          included: null,
          priced: true,
        },
      ],
      statements: "required",
      funding: { mode: "prepaid", customerId: "cus_1" },
    })
  })

  it("budgets in credits when the plan's card prices in credits, and refuses to prepay them", () => {
    const credits = feature("ai_credits", { meterConfig: sum("ai.call", "credits") })
    const sold = phase({ card: { id: "rc_credits", unit: "credits:ai" }, items: [item(credits)] })

    const { budget } = compiled(source([sold]))
    expect([budget.unit, budget.config.pricing?.funding]).toEqual([
      "credits:ai",
      { mode: "postpaid" },
    ])

    const capped = compilePayerBudget(source([{ ...sold, creditLinePolicy: "capped" }]))
    expect(capped.err?.issue).toEqual({ code: "PREPAID_NEEDS_MONEY", unit: "credits:ai" })
  })

  it("compiles a mid-period plan change from the new phase and keeps the old period's statement", () => {
    const calls = (overrides: Partial<Feature> = {}) =>
      feature("api_calls", { meterConfig: count("api.call"), ...overrides })
    // Phases end inclusively: the old one's last millisecond is the one before the new one starts,
    // and its billing period was cut to that millisecond.
    const starter = phase({
      id: "phase_starter",
      endAt: NOV_15 - 1,
      card: { id: "rc_starter", unit: "money:USD" },
      items: [
        item(calls(), [{ id: "bp_starter", statementKey: "sk_nov", start: NOV, end: NOV_15 - 1 }]),
      ],
    })
    const scale = phase({
      id: "phase_scale",
      startAt: NOV_15,
      card: { id: "rc_scale", unit: "money:USD" },
      items: [
        item(calls({ included: "5000" }), [
          { id: "bp_scale", statementKey: "sk_nov", start: NOV_15, end: DEC },
        ]),
      ],
    })
    const grants = [
      { featureSlug: "api_calls", allowanceUnits: 1000, effectiveAt: NOV, expiresAt: NOV_15 },
      { featureSlug: "api_calls", allowanceUnits: 20_000, effectiveAt: NOV_15, expiresAt: null },
    ]

    const changed = compiled(source([scale, starter], grants, NOV_15 + hour))

    expect(changed.phaseId).toBe("phase_scale")
    expect(changed.budget.config.closesAt).toBeNull()
    expect(changed.budget.config.pricing?.cards).toEqual({ base: "rc_scale" })
    // The same schedule as before the change, so the month's count carries over.
    expect(changed.budget.config.limits.map(({ id, amount }) => [id, amount])).toEqual([
      [`api_calls:month:${FIRST_OF_MONTH}`, amount("20000")],
    ])
    // Contiguous: the old statement covers the phase's last millisecond and ends where the next starts.
    expect(changed.statements).toEqual([
      statement("api_calls", "bp_starter", "sk_nov", NOV, NOV_15),
      statement("api_calls", "bp_scale", "sk_nov", NOV_15, DEC),
    ])

    const before = compiled(source([scale, starter], grants, NOV_15 - hour))
    expect([before.phaseId, before.budget.config.closesAt]).toEqual(["phase_starter", null])
  })

  it("closes the budget where a canceled phase ends and drops periods past the late window", () => {
    const calls = feature("api_calls", { meterConfig: count("api.call") })
    const canceledAt = NOV + 20 * day
    const october = {
      id: "bp_oct",
      statementKey: "sk_oct",
      start: Date.parse("2026-10-01T00:00:00.000Z"),
      end: NOV,
    }
    const november = { id: "bp_nov", statementKey: "sk_nov", start: NOV, end: canceledAt }
    const canceled = phase({
      startAt: Date.parse("2026-10-01T00:00:00.000Z"),
      endAt: canceledAt,
      items: [item(calls, [october, november])],
    })

    const { budget, statements } = compiled(source([canceled]))

    expect(budget.config.closesAt).toBe(canceledAt)
    expect(statements).toEqual([statement("api_calls", "bp_nov", "sk_nov", NOV, canceledAt + 1)])
  })

  it("ignores a phase scheduled after a cancel and closes where the subscription ended", () => {
    const calls = feature("api_calls", { meterConfig: count("api.call") })
    const canceledAt = NOV + 20 * day
    const current = phase({
      id: "phase_current",
      endAt: canceledAt,
      subscriptionEndsAt: canceledAt,
      card: { id: "rc_current", unit: "money:USD" },
      items: [item(calls, [{ id: "bp_nov", statementKey: "sk_nov", start: NOV, end: DEC }])],
    })
    // A downgrade scheduled for December that the cancel left in place.
    const scheduled = phase({
      id: "phase_scheduled",
      startAt: DEC,
      subscriptionEndsAt: canceledAt,
      currency: "EUR",
      card: { id: "rc_scheduled", unit: "money:EUR" },
      items: [
        item(calls, [{ id: "bp_dec", statementKey: "sk_dec", start: DEC, end: DEC + 31 * day }]),
      ],
    })

    for (const at of [NOW, canceledAt + hour]) {
      const { phaseId, budget, statements } = compiled(source([current, scheduled], [], at))
      expect([phaseId, budget.unit, budget.config.closesAt, budget.config.pricing?.cards]).toEqual([
        "phase_current",
        "money:USD",
        canceledAt,
        { base: "rc_current" },
      ])
      // The period not yet cut to the cancel still ends with it.
      expect(statements).toEqual([statement("api_calls", "bp_nov", "sk_nov", NOV, canceledAt + 1)])
    }
  })

  it("returns INVALID_BUDGET for a source that fails its schema instead of throwing", () => {
    const result = compilePayerBudget({ ...source([phase({})]), now: -1 })
    expect(result.err?.issue.code).toBe("INVALID_BUDGET")
    expect(result.err?.issue).toMatchObject({ message: expect.stringContaining("now") })
  })

  it("refuses a meter the budget cannot count, and a customer without phases", () => {
    const peak = feature("storage", {
      meterConfig: {
        eventId: "ev_s",
        eventSlug: "storage",
        aggregationMethod: "max",
        aggregationField: "gb",
      },
    })

    expect(compilePayerBudget(source([phase({ items: [item(peak)] })])).err?.issue).toEqual({
      code: "UNSUPPORTED_AGGREGATION",
      featureSlug: "storage",
      aggregationMethod: "max",
    })
    expect(compilePayerBudget(source([])).err?.issue).toEqual({
      code: "NO_PHASE",
      customerId: "cus_1",
    })
  })
})
