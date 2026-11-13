import { upsertBudgetInternalInputSchema } from "@unprice/db/validators"
import type { Amount } from "@unprice/money"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { usdCard } from "../pricing/fixtures"
import { priceUsage } from "../pricing/rate"
import type { BudgetCommand, BudgetEvent, PricedEvent, Usage } from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"

const runs = Number.parseInt(process.env.UNPRICE_MODEL_RUNS ?? "200", 10)
/** 200 runs take 4 to 5 s alone and over 20 s while the pre-commit hook runs every suite at once. */
const PROPERTY_TIMEOUT_MS = 60_000
const seed = process.env.UNPRICE_MODEL_SEED
  ? Number.parseInt(process.env.UNPRICE_MODEL_SEED, 10)
  : undefined

const ZERO = BigInt(0)
const ONE = BigInt(100_000_000)
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const MONTHS = [
  { key: "inv_2026-11", start: Date.parse("2026-11-01T00:00:00.000Z") },
  { key: "inv_2026-12", start: Date.parse("2026-12-01T00:00:00.000Z") },
  { key: "inv_2027-01", start: Date.parse("2027-01-01T00:00:00.000Z") },
  { key: "inv_2027-02", start: Date.parse("2027-02-01T00:00:00.000Z") },
] as const
const FIRST = MONTHS[0].start
const LAST_CLOCK = MONTHS[3].start - 3 * day

/** Every event slug and the features it feeds; `ai` feeds a priced and an unpriced feature. */
const FEATURES = [
  { slug: "llm_tokens", eventSlug: "ai", dimensions: ["model"], meterProperty: null, priced: true },
  { slug: "ai_requests", eventSlug: "ai", dimensions: [], meterProperty: null, priced: false },
  {
    slug: "api_calls",
    eventSlug: "api",
    dimensions: [],
    meterProperty: "calls",
    included: "1000",
    priced: true,
  },
  { slug: "emails", eventSlug: "email", dimensions: [], meterProperty: "emails", priced: true },
] as const

const configOf = (features: readonly (typeof FEATURES)[number][]) =>
  upsertBudgetInternalInputSchema.parse({
    key: "unprice:customer:cus_model",
    unit: "USD",
    limits: [],
    pricing: {
      cards: { base: usdCard.card.id },
      features: features.map((feature) => ({ included: null, ...feature })),
    },
  }).config
const config = configOf(FEATURES)
/** Emails stop being metered; the change waits until no hold is open. */
const withoutEmails = configOf(FEATURES.filter((feature) => feature.slug !== "emails"))
const pricedFeatures = config.pricing?.features ?? []

const eventArb: fc.Arbitrary<BudgetEvent> = fc.oneof(
  fc
    .record({
      model: fc.constantFrom("gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4"),
      input_tokens: fc.integer({ min: 0, max: 400_000 }),
      cached_input_tokens: fc.integer({ min: 0, max: 100_000 }),
      output_tokens: fc.integer({ min: 0, max: 60_000 }),
      cache_write_tokens: fc.integer({ min: 0, max: 30_000 }),
    })
    .map((properties) => ({ slug: "ai", properties })),
  fc.integer({ min: 1, max: 8_000 }).map((calls) => ({ slug: "api", properties: { calls } })),
  fc.integer({ min: 1, max: 2_500 }).map((emails) => ({ slug: "email", properties: { emails } }))
)

type Verb = "record" | "charge" | "settle" | "abandon" | "reprice"

const stepArb = (verbs: readonly Verb[]) =>
  fc.record({
    advance: fc.integer({ min: 0, max: 3 * day }),
    verb: fc.constantFrom(...verbs),
    lag: fc.integer({ min: 0, max: day - minute }),
    ttlMs: fc.integer({ min: 15 * minute, max: day }),
    sealFirst: fc.boolean(),
    event: eventArb,
  })

const scenarioArb = (verbs: readonly Verb[]) =>
  fc.record({
    sealLag: fc.integer({ min: 0, max: 12 * hour }),
    steps: fc.array(stepArb(verbs), { minLength: 20, maxLength: 60, size: "max" }),
  })

/**
 * Each step's clock. The advances are scaled so the last step lands on LAST_CLOCK: every scenario
 * crosses both month ends and seals November and December.
 */
function clocksOf(steps: readonly Readonly<{ advance: number }>[]): number[] {
  const start = FIRST + day
  const total = steps.reduce((sum, step) => sum + step.advance + 1, 0)
  let elapsed = 0
  return steps.map((step) => {
    elapsed += step.advance + 1
    return start + Math.floor((LAST_CLOCK - start) * (elapsed / total))
  })
}

/** A budget with every feature's statements registered for November to January. */
function newBudget() {
  const store = new MemoryBudgetStore()
  store.cacheCards(usdCard)
  const run = (command: BudgetCommand, clock: number) => {
    const result = store.run(command, clock)
    if (result.err) throw result.err
    if (!result.val.ok) throw new Error(result.val.rejection.code)
    return result.val.outcome
  }
  run(
    {
      type: "upsert",
      key: "unprice:customer:cus_model",
      projectId: "proj_1",
      unit: "money:USD",
      config,
      mayLoosen: true,
    },
    FIRST
  )
  run(
    {
      type: "registerStatements",
      statements: FEATURES.flatMap((feature) =>
        MONTHS.slice(0, 3).map((month, i) => ({
          periodId: periodId(feature.slug, i),
          statementKey: month.key,
          featureSlug: feature.slug,
          start: month.start,
          end: MONTHS[i + 1]?.start ?? month.start,
        }))
      ),
    },
    FIRST
  )
  const sealed = new Set<number>()
  /** Seals November and December once the clock passes their end plus the lag. */
  const sealDue = (clock: number, sealLag: number) => {
    for (const month of [0, 1]) {
      const end = MONTHS[month + 1]?.start ?? 0
      if (sealed.has(month) || clock < end + sealLag) continue
      run({ type: "sealStatements", statementKey: MONTHS[month]?.key ?? "", at: end }, clock)
      sealed.add(month)
    }
  }
  return { store, run, sealed, sealDue }
}

/** Half of every quantity: an actual within its estimate. */
const halved = (event: BudgetEvent): BudgetEvent => ({
  slug: event.slug,
  properties: Object.fromEntries(
    Object.entries(event.properties).map(([key, value]) => [
      key,
      typeof value === "number" ? Math.floor(value / 2) : value,
    ])
  ),
})

const monthOf = (t: number) =>
  MONTHS.findIndex((month, i) => {
    const next = MONTHS[i + 1]
    return next !== undefined && month.start <= t && t < next.start
  })
const periodId = (feature: string, month: number) => `${feature}:${MONTHS[month]?.key}`

/** What the reference expects per statement: usage grouped by match, and the meter quantity. */
type Expected = {
  groups: Map<string, { feature: string; properties: Record<string, unknown> }>
  quantity: Amount
  events: number
}

/** Adds one event to the statement of one of its features. */
function expect1(
  expected: Map<string, Expected>,
  id: string,
  feature: (typeof FEATURES)[number],
  event: BudgetEvent
) {
  const statement = expected.get(id) ?? { groups: new Map(), quantity: ZERO, events: 0 }
  const dimensions = Object.fromEntries(
    feature.dimensions.map((dimension) => [dimension, event.properties[dimension]])
  )
  const group = JSON.stringify(dimensions)
  const usage = statement.groups.get(group) ?? { feature: feature.slug, properties: {} }
  addProperties(usage.properties, event.properties)
  statement.groups.set(group, usage)
  statement.quantity += meterQuantity(feature.meterProperty, event.properties)
  statement.events += 1
  expected.set(id, statement)
}

/** Each statement priced as one event per match from zero equals what the budget accumulated. */
function expectStatements(store: MemoryBudgetStore, expected: Map<string, Expected>) {
  for (const statement of store.statements.values()) {
    const reference = expected.get(statement.periodId) ?? {
      groups: new Map(),
      quantity: ZERO,
      events: 0,
    }
    expect({
      periodId: statement.periodId,
      amount: statement.amount,
      quantity: statement.quantity,
      events: statement.events,
    }).toEqual({
      periodId: statement.periodId,
      amount: pricedInOneEvent(reference),
      quantity: reference.quantity,
      events: reference.events,
    })
  }
}

function addProperties(into: Record<string, unknown>, from: Readonly<Record<string, unknown>>) {
  for (const [key, value] of Object.entries(from)) {
    into[key] = typeof value === "number" ? Number(into[key] ?? 0) + value : value
  }
}

function meterQuantity(
  meterProperty: string | null,
  properties: Readonly<Record<string, unknown>>
) {
  if (meterProperty === null) return ONE
  return BigInt(Number(properties[meterProperty] ?? 0)) * ONE
}

/** The amount of all of a statement's usage priced as one event per match, from zero positions. */
function pricedInOneEvent(expected: Expected): Amount {
  let total = ZERO
  for (const { feature, properties } of expected.groups.values()) {
    const pricing = pricedFeatures.find((candidate) => candidate.slug === feature)
    if (!pricing?.priced) continue
    const priced = priceUsage({
      cards: { base: usdCard },
      feature: pricing,
      properties,
      at: FIRST,
      positionOf: () => ZERO,
    })
    if (priced.err) throw priced.err
    total += priced.val.amount
  }
  return total
}

describe("statements through the budget", () => {
  it(
    "record-only sequences: statements sum to the ledger and price split usage as one event",
    () => {
      fc.assert(
        fc.property(scenarioArb(["record"]), ({ sealLag, steps }) => {
          const { store, run, sealed, sealDue } = newBudget()
          const expected = new Map<string, Expected>()
          const clocks = clocksOf(steps)
          steps.forEach((step, n) => {
            const clock = clocks[n] ?? LAST_CLOCK
            sealDue(clock, sealLag)
            const at = clock - step.lag
            run(
              { type: "record", idempotencyKey: `e${n}`, event: step.event, occurredAt: at },
              clock
            )

            // ADR-0008 D6: the period containing the event's time, else the next open one.
            let month = monthOf(at)
            while (sealed.has(month)) month += 1
            for (const feature of FEATURES.filter((f) => f.eventSlug === step.event.slug)) {
              expect1(expected, periodId(feature.slug, month), feature, step.event)
            }
          })

          expectStatements(store, expected)
          const statements = [...store.statements.values()]
          const { amount, quantities } = store.ledger.usage.never.consumed
          expect(statements.reduce((sum, s) => sum + s.amount, ZERO)).toBe(amount)
          for (const feature of FEATURES) {
            const counted = statements
              .filter((s) => s.featureSlug === feature.slug)
              .reduce((sum, s) => sum + s.quantity, ZERO)
            expect(counted).toBe(quantities[feature.slug] ?? ZERO)
          }
        }),
        { numRuns: runs, seed }
      )
    },
    PROPERTY_TIMEOUT_MS
  )

  it(
    "with holds, settles, expiries, seals, and repricing: statements price their usage as one event and sum to the ledger less unbilled estimates",
    () => {
      const seen = { unbilled: 0, late: 0, billedExpiries: 0, repriced: 0, deferred: 0 }
      fc.assert(
        fc.property(
          scenarioArb(["record", "charge", "settle", "abandon", "reprice"]),
          ({ sealLag, steps }) => {
            const { store, run, sealDue } = newBudget()
            const unbilled = new Map<string, Usage>()
            // Every event a row billed, by row id: rows are purged after retention.
            const billed = new Map<string, PricedEvent>()
            const billedExpiries = new Set<string>()
            const capture = () => {
              for (const row of store.rows.values()) {
                if ((row.kind === "charge" || row.kind === "record") && row.priced) {
                  billed.set(row.id, row.priced)
                }
                if (row.kind !== "hold" || row.state.status !== "settled") continue
                if (row.state.unbilled) unbilled.set(row.id, row.reserved)
                if (row.state.priced) billed.set(row.id, row.state.priced)
                if (row.state.priced && row.state.byExpiry) billedExpiries.add(row.id)
              }
            }
            let repriced = false
            const clocks = clocksOf(steps)
            let clock = FIRST + day
            steps.forEach((step, n) => {
              clock = clocks[n] ?? LAST_CLOCK
              // Sealing before the alarm leaves holds open across a seal: their expiry counts late,
              // or, with no later period open, unbilled.
              if (step.sealFirst) sealDue(clock, sealLag)
              store.alarm(clock)
              capture()
              sealDue(clock, sealLag)
              const key = `e${n}`
              const { event, ttlMs } = step
              if (repriced && event.slug === "email" && step.verb !== "reprice") {
                const refused = store.run({ type: "charge", idempotencyKey: key, event }, clock)
                expect(refused.err?.code).toBe("UNKNOWN_EVENT")
              } else if (step.verb === "record") {
                run(
                  { type: "record", idempotencyKey: key, event, occurredAt: clock - step.lag },
                  clock
                )
              } else if (step.verb === "charge") {
                run({ type: "charge", idempotencyKey: key, event }, clock)
              } else if (step.verb === "abandon") {
                run({ type: "authorize", idempotencyKey: key, event, ttlMs }, clock)
              } else if (step.verb === "reprice") {
                const next = repriced ? config : withoutEmails
                const upsert = {
                  key: "unprice:customer:cus_model",
                  projectId: "proj_1",
                  unit: "money:USD",
                }
                const result = store.run(
                  { type: "upsert", ...upsert, config: next, mayLoosen: true, setsPricing: true },
                  clock
                )
                if (result.err) {
                  // An open hold settles under the pricing that estimated it.
                  expect(result.err.code).toBe("RESERVATIONS_OPEN")
                  expect(store.hasOpenReservations()).toBe(true)
                  seen.deferred += 1
                } else {
                  repriced = !repriced
                  seen.repriced += 1
                }
              } else {
                // Two holds estimated at one position; the settles price past each other.
                const holdIds = [`${key}a`, `${key}b`].map((idempotencyKey) => {
                  const placed = run({ type: "authorize", idempotencyKey, event, ttlMs }, clock)
                  if (placed.type !== "authorize") throw new Error("not a hold")
                  return placed.holdId
                })
                run({ type: "settle", holdId: holdIds[1] ?? "", event: halved(event) }, clock)
                run({ type: "settle", holdId: holdIds[0] ?? "", event }, clock)
              }
              capture()
            })
            // January seals before the alarm closes the last holds; with no later period open, their
            // estimates stay unbilled.
            const end = MONTHS[3].start + day
            run({ type: "sealStatements", statementKey: MONTHS[2].key, at: MONTHS[3].start }, end)
            store.alarm(end)
            capture()

            const expected = new Map<string, Expected>()
            for (const priced of billed.values()) {
              for (const feature of priced.features) {
                const metered = FEATURES.find((candidate) => candidate.slug === feature.featureSlug)
                if (!metered) throw new Error(`unknown feature ${feature.featureSlug}`)
                expect1(expected, feature.periodId, metered, priced)
                if (feature.late) seen.late += 1
              }
            }
            seen.billedExpiries += billedExpiries.size
            seen.unbilled += unbilled.size
            expectStatements(store, expected)

            const statements = [...store.statements.values()]
            const { amount, quantities } = store.ledger.usage.never.consumed
            const lost = [...unbilled.values()]
            const total = statements.reduce((sum, s) => sum + s.amount, ZERO)
            expect(total + lost.reduce((sum, usage) => sum + usage.amount, ZERO)).toBe(amount)
            for (const feature of FEATURES) {
              const counted = statements
                .filter((s) => s.featureSlug === feature.slug)
                .reduce((sum, s) => sum + s.quantity, ZERO)
              const uncounted = lost.reduce(
                (sum, usage) => sum + (usage.quantities[feature.slug] ?? ZERO),
                ZERO
              )
              expect(counted + uncounted).toBe(quantities[feature.slug] ?? ZERO)
            }
          }
        ),
        { numRuns: runs, seed }
      )
      // The generators reach every way an expiry closes.
      expect(seen.unbilled).toBeGreaterThan(0)
      expect(seen.late).toBeGreaterThan(0)
      expect(seen.billedExpiries).toBeGreaterThan(0)
      expect(seen.repriced).toBeGreaterThan(0)
      expect(seen.deferred).toBeGreaterThan(0)
    },
    PROPERTY_TIMEOUT_MS
  )
})
