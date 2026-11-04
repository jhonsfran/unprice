import {
  type BudgetConfigInput,
  budgetStatementRegistrationSchema,
  upsertBudgetInternalInputSchema,
} from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import {
  CARD_FROM,
  PRICE_CHANGE_AT,
  creditsCard,
  enterpriseOverlay,
  includedApiCallsCard,
  priceChangeCard,
  usdCard,
} from "../pricing/fixtures"
import type { CardRows } from "../pricing/model"
import type {
  BudgetCommand,
  BudgetEvent,
  BudgetTransition,
  ChargeOperation,
  HoldOperation,
  Statement,
  StatementRegistration,
} from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"
import { amountUsage, usageOf } from "./usage"

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const NOV = CARD_FROM
const DEC = Date.parse("2026-12-01T00:00:00.000Z")
const JAN = Date.parse("2027-01-01T00:00:00.000Z")

type FeatureInput = Readonly<{
  slug: string
  eventSlug: string
  dimensions?: string[]
  meterProperty?: string | null
  included?: string | null
  priced?: boolean
}>

const tokens: FeatureInput = { slug: "llm_tokens", eventSlug: "ai.call", dimensions: ["model"] }
const images: FeatureInput = { slug: "images", eventSlug: "image.generated", dimensions: ["size"] }
const apiCalls: FeatureInput = {
  slug: "api_calls",
  eventSlug: "api.batch",
  meterProperty: "calls",
  included: "1000",
}

/** API calls on the graduated card row with no allowance: 10,000 free, then $5 to enter tier 2. */
const graduatedCalls: FeatureInput = {
  slug: "api_calls",
  eventSlug: "api.batch",
  meterProperty: "calls",
}

type PricedBudget = Readonly<{
  unit?: string
  cards?: readonly CardRows[]
  overlay?: string
  features: readonly FeatureInput[]
  statements?: "required" | "none"
  limits?: BudgetConfigInput["limits"]
}>

function pricedUpsert(budget: PricedBudget): BudgetCommand {
  const [base = usdCard, overlay] = budget.cards ?? [usdCard]
  const parsed = upsertBudgetInternalInputSchema.parse({
    key: "unprice:customer:cus_acme",
    unit: budget.unit ?? "USD",
    limits: budget.limits ?? [],
    pricing: {
      cards: { base: base.card.id, ...(overlay && { overlay: overlay.card.id }) },
      features: budget.features.map((feature) => ({
        dimensions: [],
        meterProperty: null,
        included: null,
        priced: true,
        ...feature,
      })),
      statements: budget.statements ?? "required",
    },
  })
  return { type: "upsert", projectId: "proj_1", mayLoosen: true, setsPricing: true, ...parsed }
}

function pricedStore(budget: PricedBudget, at = NOV + hour) {
  const store = new MemoryBudgetStore()
  store.cacheCards(...(budget.cards ?? [usdCard]))
  ok(store.run(pricedUpsert(budget), at))
  return store
}

type Accepted = Extract<BudgetTransition, { ok: true }>

function ok(result: ReturnType<MemoryBudgetStore["run"]>): Accepted {
  if (result.err) throw result.err
  if (!result.val.ok) throw new Error(`expected an outcome, got ${result.val.rejection.code}`)
  return result.val
}

function rejection(result: ReturnType<MemoryBudgetStore["run"]>) {
  if (!result.err) throw new Error("expected a rejection")
  return result.err.rejection
}

const month = (
  featureSlug: string,
  start: number,
  end: number,
  statementKey = `inv_${new Date(start).toISOString().slice(0, 7)}`
): StatementRegistration => ({
  periodId: `${featureSlug}:${statementKey}`,
  statementKey,
  featureSlug,
  start,
  end,
})

const register = (...statements: StatementRegistration[]): BudgetCommand => ({
  type: "registerStatements",
  statements,
})

const aiCall = (model: string, properties: Record<string, number>): BudgetEvent => ({
  slug: "ai.call",
  properties: { model, ...properties },
})
const image = (size: string): BudgetEvent => ({ slug: "image.generated", properties: { size } })
const apiBatch = (calls: number): BudgetEvent => ({ slug: "api.batch", properties: { calls } })

const charge = (key: string, event: BudgetEvent): BudgetCommand => ({
  type: "charge",
  idempotencyKey: key,
  event,
})
const record = (key: string, event: BudgetEvent, occurredAt: number): BudgetCommand => ({
  type: "record",
  idempotencyKey: key,
  event,
  occurredAt,
})

/** A statement's totals as decimals. */
function totals(statement: Statement | undefined) {
  if (!statement) throw new Error("no statement")
  const { state, events } = statement
  const cost = statement.cost === null ? null : formatAmount(statement.cost)
  return {
    state,
    amount: formatAmount(statement.amount),
    cost,
    quantity: formatAmount(statement.quantity),
    events,
  }
}

const lifetime = (store: MemoryBudgetStore) => {
  const { amount, quantities } = store.ledger.usage.never.consumed
  return {
    amount: formatAmount(amount),
    quantities: Object.fromEntries(
      Object.entries(quantities).map(([feature, quantity]) => [feature, formatAmount(quantity)])
    ),
  }
}

describe("a payer budget prices usage events at ingestion", () => {
  it("prices three model calls on the AI tokens card into one statement", () => {
    const store = pricedStore({ features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))

    ok(
      store.run(
        charge("c1", aiCall("gpt-4.1", { input_tokens: 10_000, output_tokens: 2_000 })),
        NOV + 2 * hour
      )
    )
    const mini = { input_tokens: 50_000, cached_input_tokens: 20_000, output_tokens: 5_000 }
    ok(store.run(charge("c2", aiCall("gpt-4.1-mini", mini)), NOV + 3 * hour))
    const sonnet = { input_tokens: 3_000, output_tokens: 1_000, cache_write_tokens: 4_000 }
    const third = ok(store.run(charge("c3", aiCall("claude-sonnet-4", sonnet)), NOV + 4 * hour))

    expect(third.outcome).toMatchObject({ type: "charge", replayed: false })
    expect(totals(store.statements.get("llm_tokens:inv_2026-11"))).toEqual({
      state: "open",
      amount: "0.105",
      cost: "0.084",
      quantity: "3",
      events: 3,
    })
    expect(lifetime(store)).toEqual({ amount: "0.105", quantities: { llm_tokens: "3" } })

    const writes = store.writes
    const unknown = store.run(
      charge("c4", aiCall("gpt-5", { input_tokens: 1_000 })),
      NOV + 5 * hour
    )
    expect(rejection(unknown)).toEqual({
      code: "NOT_PRICED",
      feature: "llm_tokens",
      match: { model: "gpt-5" },
    })
    expect(store.writes).toBe(writes)
    expect(totals(store.statements.get("llm_tokens:inv_2026-11")).amount).toBe("0.105")
  })

  it("keeps the priced detail on the operation row", () => {
    const store = pricedStore({ features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
    ok(
      store.run(
        charge("c1", aiCall("gpt-4.1", { input_tokens: 10_000, output_tokens: 2_000 })),
        NOV + 2 * hour
      )
    )

    const row = store.rows.get("o:c1") as ChargeOperation
    const feature = row.priced?.features[0]
    expect({
      slug: row.priced?.slug,
      at: row.priced?.at,
      periodId: feature?.periodId,
      late: feature?.late,
      cardId: feature?.cardId,
      rowId: feature?.rowId,
      lines: feature?.lines.map((line) => [line.property, formatAmount(line.amount)]),
    }).toEqual({
      slug: "ai.call",
      at: NOV + 2 * hour,
      periodId: "llm_tokens:inv_2026-11",
      late: false,
      cardId: "rc_usd",
      rowId: "row_gpt41",
      lines: [
        ["input_tokens", "0.02"],
        ["cached_input_tokens", "0"],
        ["output_tokens", "0.016"],
      ],
    })
  })

  it("resets graduated tiers and included units when a statement period starts", () => {
    const store = pricedStore({ features: [apiCalls] })
    ok(store.run(register(month("api_calls", NOV, DEC), month("api_calls", DEC, JAN)), NOV + hour))

    // 6,000 calls less 1,000 included stay in the free tier; 10,000 more enter tier two.
    ok(store.run(charge("n1", apiBatch(6_000)), NOV + 9 * day))
    ok(store.run(charge("n2", apiBatch(10_000)), NOV + 10 * day))
    // A new period: 12,000 calls less 1,000 included is 1,000 into tier two again.
    ok(store.run(charge("d1", apiBatch(12_000)), DEC + 4 * day))

    expect(totals(store.statements.get("api_calls:inv_2026-11"))).toEqual({
      state: "open",
      amount: "10",
      cost: null,
      quantity: "16000",
      events: 2,
    })
    expect(totals(store.statements.get("api_calls:inv_2026-12"))).toEqual({
      state: "open",
      amount: "6",
      cost: null,
      quantity: "12000",
      events: 1,
    })
    expect(lifetime(store)).toEqual({ amount: "16", quantities: { api_calls: "28000" } })
  })

  it("prices each record at its occurredAt across a price change", () => {
    const store = pricedStore({ cards: [priceChangeCard], features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
    const output = { output_tokens: 1_000_000 }

    const clock = PRICE_CHANGE_AT + hour
    ok(store.run(record("r1", aiCall("gpt-4.1", output), PRICE_CHANGE_AT - hour), clock))
    ok(store.run(record("r2", aiCall("gpt-4.1", output), PRICE_CHANGE_AT + 30 * minute), clock))

    const rowOf = (key: string) => (store.rows.get(key) as ChargeOperation).priced?.features[0]
    expect([rowOf("o:r1")?.rowId, rowOf("o:r2")?.rowId]).toEqual(["row_gpt41_v1", "row_gpt41_v2"])
    expect(totals(store.statements.get("llm_tokens:inv_2026-11"))).toEqual({
      state: "open",
      amount: "14",
      cost: "11.2",
      quantity: "2",
      events: 2,
    })
  })

  it("settles at the authorization time's price, across a price change", () => {
    const store = pricedStore({ cards: [priceChangeCard], features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
    const event = aiCall("gpt-4.1", { output_tokens: 1_000_000 })

    const placed = ok(
      store.run(
        { type: "authorize", idempotencyKey: "a1", event, ttlMs: hour },
        PRICE_CHANGE_AT - 10 * minute
      )
    )
    if (placed.outcome.type !== "authorize") throw new Error("not a hold")
    expect(formatAmount(placed.outcome.reserved.amount)).toBe("8")
    ok(
      store.run(
        { type: "settle", holdId: placed.outcome.holdId, event },
        PRICE_CHANGE_AT + 10 * minute
      )
    )

    expect(totals(store.statements.get("llm_tokens:inv_2026-11")).amount).toBe("8")
  })

  it("prices an enterprise customer's overlay rows ahead of the base card", () => {
    const base = pricedStore({ features: [tokens] })
    const enterprise = pricedStore({ cards: [usdCard, enterpriseOverlay], features: [tokens] })
    const call = aiCall("gpt-4.1", { input_tokens: 1_000_000, output_tokens: 1_000_000 })
    const sonnet = aiCall("claude-sonnet-4", { input_tokens: 1_000_000 })
    for (const store of [base, enterprise]) {
      ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
      ok(store.run(charge("c1", call), NOV + 2 * hour))
      ok(store.run(charge("c2", sonnet), NOV + 3 * hour))
    }

    const cardOf = (store: MemoryBudgetStore, key: string) =>
      (store.rows.get(key) as ChargeOperation).priced?.features[0]?.cardId
    expect([cardOf(base, "o:c1"), cardOf(enterprise, "o:c1"), cardOf(enterprise, "o:c2")]).toEqual([
      "rc_usd",
      "rc_enterprise",
      "rc_usd",
    ])
    expect(totals(base.statements.get("llm_tokens:inv_2026-11")).amount).toBe("13")
    expect(totals(enterprise.statements.get("llm_tokens:inv_2026-11")).amount).toBe("11")
  })

  it("blocks a charge past a credits limit, and refuses a card in another unit", () => {
    const store = pricedStore({
      unit: "credits:ai",
      cards: [creditsCard],
      features: [tokens],
      limits: [{ id: "month", amount: "1000", window: "month" }],
    })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))

    ok(store.run(charge("c1", aiCall("gpt-4.1", { input_tokens: 1_000_000 })), NOV + 2 * hour))
    ok(store.run(charge("c2", aiCall("gpt-4.1", { output_tokens: 1_000_000 })), NOV + 3 * hour))
    const blocked = store.run(
      charge("c3", aiCall("gpt-4.1-mini", { input_tokens: 100_000 })),
      NOV + 4 * hour
    )

    expect(rejection(blocked)).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: { limitId: "month", remaining: BigInt(0) },
    })
    expect(totals(store.statements.get("llm_tokens:inv_2026-11"))).toEqual({
      state: "open",
      amount: "1000",
      cost: "8",
      quantity: "2",
      events: 2,
    })

    const usd = new MemoryBudgetStore()
    usd.cacheCards(creditsCard)
    expect(
      rejection(usd.run(pricedUpsert({ cards: [creditsCard], features: [tokens] }), NOV))
    ).toEqual({
      code: "UNIT_MISMATCH",
      cardId: "rc_credits",
      unit: "money:USD",
      cardUnit: "credits:ai",
    })
  })

  it("gates an image authorization on a 50 images a day quantity limit", () => {
    const store = pricedStore({
      features: [images],
      limits: [{ id: "images:day", feature: "images", amount: "50", window: "day" }],
    })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    for (let i = 0; i < 49; i++) {
      ok(store.run(charge(`img${i}`, image("1024")), NOV + 2 * hour + i))
    }

    const fiftieth = ok(
      store.run({ type: "authorize", idempotencyKey: "a50", event: image("1024") }, NOV + 3 * hour)
    )
    const fiftyFirst = store.run(
      { type: "authorize", idempotencyKey: "a51", event: image("512") },
      NOV + 3 * hour
    )

    expect(fiftieth.outcome).toMatchObject({ type: "authorize", replayed: false })
    expect(rejection(fiftyFirst)).toMatchObject({
      code: "LIMIT_EXCEEDED",
      blocked: { limitId: "images:day", remaining: BigInt(0), remedy: "release_holds" },
    })
    expect(totals(store.statements.get("images:inv_2026-11"))).toEqual({
      state: "open",
      amount: "1.96",
      cost: "1.568",
      quantity: "49",
      events: 49,
    })
  })

  it("moves positions only at settle, and refuses an actual above the estimate", () => {
    const store = pricedStore({ features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
    const statement = () => store.statements.get("llm_tokens:inv_2026-11")

    const estimate = aiCall("gpt-4.1", { input_tokens: 100_000, output_tokens: 50_000 })
    const placed = ok(
      store.run(
        { type: "authorize", idempotencyKey: "a1", event: estimate, ttlMs: 2 * hour },
        NOV + 2 * hour
      )
    )
    if (placed.outcome.type !== "authorize") throw new Error("not a hold")
    expect(formatAmount(placed.outcome.reserved.amount)).toBe("0.6")
    expect(statement()?.positions).toEqual({})

    const actual = aiCall("gpt-4.1", { input_tokens: 100_000, output_tokens: 20_000 })
    const settled = ok(
      store.run({ type: "settle", holdId: placed.outcome.holdId, event: actual }, NOV + 3 * hour)
    )
    expect(settled.outcome).toMatchObject({ type: "settle", expired: false })
    expect(totals(statement())).toMatchObject({ amount: "0.36", quantity: "1", events: 1 })
    expect(
      Object.fromEntries(
        Object.entries(statement()?.positions ?? {}).map(([key, value]) => [
          key,
          formatAmount(value),
        ])
      )
    ).toEqual({
      '["llm_tokens","{\\"model\\":\\"gpt-4.1\\"}","input_tokens"]': "100000",
      '["llm_tokens","{\\"model\\":\\"gpt-4.1\\"}","cached_input_tokens"]': "0",
      '["llm_tokens","{\\"model\\":\\"gpt-4.1\\"}","output_tokens"]': "20000",
    })

    const small = ok(
      store.run(
        {
          type: "authorize",
          idempotencyKey: "a2",
          event: aiCall("gpt-4.1", { input_tokens: 10_000 }),
        },
        NOV + 4 * hour
      )
    )
    if (small.outcome.type !== "authorize") throw new Error("not a hold")
    const above = store.run(
      {
        type: "settle",
        holdId: small.outcome.holdId,
        event: aiCall("gpt-4.1", { input_tokens: 20_000 }),
      },
      NOV + 5 * hour
    )
    expect(rejection(above)).toMatchObject({
      code: "HOLD_AMOUNT_EXCEEDED",
      measure: { type: "amount" },
      maximum: BigInt(2_000_000),
      actual: BigInt(4_000_000),
    })
    expect(totals(statement()).amount).toBe("0.36")
  })

  it("counts a late event in the next open period, and refuses one with no period to count in", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC), month("images", DEC, JAN)), NOV + hour))
    ok(store.run(charge("n1", image("1024")), DEC - hour))

    const sealed = ok(
      store.run({ type: "sealStatements", statementKey: "inv_2026-11", at: DEC }, DEC + 10 * minute)
    )
    if (sealed.outcome.type !== "sealStatements") throw new Error("not a seal")
    expect(sealed.outcome.statements.map(totals)).toEqual([
      { state: "sealed", amount: "0.04", cost: "0.032", quantity: "1", events: 1 },
    ])

    ok(store.run(record("late", image("512"), DEC - 30 * minute), DEC + 30 * minute))
    const late = (store.rows.get("o:late") as ChargeOperation).priced?.features[0]
    expect([late?.periodId, late?.late]).toEqual(["images:inv_2026-12", true])
    expect(totals(store.statements.get("images:inv_2026-11")).amount).toBe("0.04")
    expect(totals(store.statements.get("images:inv_2026-12")).amount).toBe("0.018")

    ok(store.run({ type: "sealStatements", statementKey: "inv_2026-12", at: JAN }, JAN + minute))
    const closed = store.run(record("closed", image("512"), JAN - hour), JAN + 2 * minute)
    expect(rejection(closed)).toEqual({
      code: "PERIOD_CLOSED",
      featureSlug: "images",
      at: JAN - hour,
      periodId: "images:inv_2026-12",
    })

    const unregistered = pricedStore({ features: [images] })
    expect(rejection(unregistered.run(charge("c1", image("512")), NOV + hour))).toEqual({
      code: "NO_STATEMENT",
      featureSlug: "images",
      at: NOV + hour,
    })
  })

  it("seals idempotently, seals an unused statement at zero, and completes only sealed ones", () => {
    const store = pricedStore({ features: [images, tokens] })
    ok(
      store.run(
        register(
          month("images", NOV, DEC),
          month("llm_tokens", NOV, DEC),
          month("images", DEC, JAN)
        ),
        NOV + hour
      )
    )
    ok(store.run(charge("n1", image("1024")), NOV + 2 * hour))

    const seal: BudgetCommand = { type: "sealStatements", statementKey: "inv_2026-11", at: DEC }
    const first = ok(store.run(seal, DEC + minute))
    const writes = store.writes
    const again = ok(store.run(seal, DEC + 2 * minute))
    expect(store.writes).toBe(writes)
    expect(again.outcome).toEqual(first.outcome)
    if (again.outcome.type !== "sealStatements") throw new Error("not a seal")
    expect(again.outcome.statements.map((s) => [s.periodId, totals(s)])).toEqual([
      [
        "images:inv_2026-11",
        { state: "sealed", amount: "0.04", cost: "0.032", quantity: "1", events: 1 },
      ],
      [
        "llm_tokens:inv_2026-11",
        { state: "sealed", amount: "0", cost: null, quantity: "0", events: 0 },
      ],
    ])

    const open = store.run(
      { type: "completeStatements", periodIds: ["images:inv_2026-12"] },
      DEC + 3 * minute
    )
    expect(rejection(open)).toEqual({
      code: "STATEMENT_NOT_SEALED",
      periodId: "images:inv_2026-12",
    })
    const complete: BudgetCommand = {
      type: "completeStatements",
      periodIds: ["images:inv_2026-11", "llm_tokens:inv_2026-11"],
    }
    ok(store.run(complete, DEC + 4 * minute))
    const completed = ok(store.run(complete, DEC + 5 * minute))
    if (completed.outcome.type !== "completeStatements") throw new Error("not a completion")
    expect(completed.outcome.statements.map((s) => [s.state, s.completedAt])).toEqual([
      ["completed", DEC + 4 * minute],
      ["completed", DEC + 4 * minute],
    ])

    const listed = ok(store.run({ type: "statements" }, DEC + 6 * minute))
    if (listed.outcome.type !== "statements") throw new Error("not a listing")
    expect(listed.outcome.statements.map((s) => s.periodId)).toEqual(["images:inv_2026-12"])
  })

  it("registers each period once and keeps a feature's periods apart", () => {
    const store = pricedStore({ features: [images] })
    const nov = month("images", NOV, DEC)
    ok(store.run(register(nov), NOV + hour))
    const writes = store.writes

    ok(store.run(register(nov), NOV + 2 * hour))
    expect(store.writes).toBe(writes)
    expect(rejection(store.run(register({ ...nov, end: DEC + day }), NOV + 2 * hour))).toEqual({
      code: "STATEMENT_CONFLICT",
      periodId: "images:inv_2026-11",
    })
    const overlapping = { ...month("images", DEC - day, JAN), periodId: "images:shifted" }
    expect(rejection(store.run(register(overlapping), NOV + 2 * hour))).toEqual({
      code: "STATEMENT_OVERLAP",
      periodId: "images:shifted",
      overlaps: "images:inv_2026-11",
    })
  })

  it("replays a record after a price change with the amount it was first priced at", () => {
    const store = pricedStore({ cards: [priceChangeCard], features: [tokens] })
    ok(store.run(register(month("llm_tokens", NOV, DEC)), NOV + hour))
    const event = aiCall("gpt-4.1", { output_tokens: 1_000_000 })
    const occurredAt = PRICE_CHANGE_AT - hour
    const first = ok(store.run(record("r1", event, occurredAt), PRICE_CHANGE_AT - 30 * minute))

    // The card refresh moves gpt-4.1 to the new price for the whole month.
    const [, successor] = priceChangeCard.rows
    if (!successor) throw new Error("fixture has no successor row")
    store.cacheCards({
      card: priceChangeCard.card,
      rows: [{ ...successor, effectiveFrom: CARD_FROM }],
    })
    const replay = ok(store.run(record("r1", event, occurredAt), PRICE_CHANGE_AT + hour))

    if (replay.outcome.type !== "record" || first.outcome.type !== "record") {
      throw new Error("not a record")
    }
    expect([
      formatAmount(first.outcome.usage.amount),
      formatAmount(replay.outcome.usage.amount),
    ]).toEqual(["8", "8"])
    expect(replay.outcome.replayed).toBe(true)
    expect(totals(store.statements.get("llm_tokens:inv_2026-11")).amount).toBe("8")
    expect(
      rejection(
        store.run(
          record("r1", aiCall("gpt-4.1", { output_tokens: 1 }), occurredAt),
          PRICE_CHANGE_AT + hour
        )
      )
    ).toEqual({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: "r1" })
  })

  it("keeps positions in a perpetual statement when the budget needs no statements", () => {
    const store = pricedStore({ features: [apiCalls], statements: "none" })
    ok(store.run(charge("c1", apiBatch(6_000)), NOV + 2 * hour))
    ok(store.run(charge("c2", apiBatch(10_000)), DEC + 2 * hour))

    expect(totals(store.statements.get("#budget:api_calls"))).toEqual({
      state: "open",
      amount: "10",
      cost: null,
      quantity: "16000",
      events: 2,
    })
  })

  it("rejects an event no feature takes and properties over 4 KB", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    expect(
      rejection(store.run(charge("c1", { slug: "video.rendered", properties: {} }), NOV + hour))
    ).toEqual({ code: "UNKNOWN_EVENT", slug: "video.rendered" })
    const padded = {
      slug: "image.generated",
      properties: { size: "1024", note: "x".repeat(4_100) },
    }
    expect(rejection(store.run(charge("c2", padded), NOV + hour))).toMatchObject({
      code: "INVALID_USAGE",
      property: "properties",
    })
  })

  it("bills an expired estimate to its statement at the amount the ledger consumed", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    const placed = ok(
      store.run({ type: "authorize", idempotencyKey: "a1", event: image("1024") }, NOV + 2 * hour)
    )
    if (placed.outcome.type !== "authorize") throw new Error("not a hold")

    store.alarm(NOV + 3 * hour)

    const hold = store.rows.get(placed.outcome.holdId) as HoldOperation
    expect(formatAmount(placed.outcome.reserved.amount)).toBe("0.04")
    expect(hold.state).toMatchObject({ status: "settled", byExpiry: true })
    expect(totals(store.statements.get("images:inv_2026-11"))).toEqual({
      state: "open",
      amount: "0.04",
      cost: "0.032",
      quantity: "1",
      events: 1,
    })
    expect(lifetime(store)).toEqual({ amount: "0.04", quantities: { images: "1" } })
  })

  it("counts an expired estimate no statement can take, and marks it unbilled", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    const placed = ok(
      store.run(
        { type: "authorize", idempotencyKey: "a1", event: image("1024"), ttlMs: hour },
        DEC - 30 * minute
      )
    )
    if (placed.outcome.type !== "authorize") throw new Error("not a hold")
    ok(store.run({ type: "sealStatements", statementKey: "inv_2026-11", at: DEC }, DEC + minute))

    store.alarm(DEC + hour)

    const hold = store.rows.get(placed.outcome.holdId) as HoldOperation
    expect(hold.state).toMatchObject({ byExpiry: true, unbilled: { reason: "PERIOD_CLOSED" } })
    expect(totals(store.statements.get("images:inv_2026-11")).amount).toBe("0")
    expect(lifetime(store)).toEqual({ amount: "0.04", quantities: { images: "1" } })
  })

  it("reserves the most an estimate can cost, so concurrent holds never share a cheap tier", () => {
    const store = pricedStore({ features: [graduatedCalls] })
    ok(store.run(register(month("api_calls", NOV, DEC)), NOV + hour))
    ok(store.run(charge("c1", apiBatch(9_000)), NOV + 2 * hour))
    const authorize = (key: string) =>
      ok(
        store.run(
          { type: "authorize", idempotencyKey: key, event: apiBatch(1_500), ttlMs: hour },
          NOV + 3 * hour
        )
      )
    const first = authorize("a1")
    const second = authorize("a2")
    if (first.outcome.type !== "authorize" || second.outcome.type !== "authorize") {
      throw new Error("not a hold")
    }
    // From any position, 1,500 calls cost at most the $5 tier entry plus 1,500 x $0.001.
    expect(
      [first.outcome.reserved.amount, second.outcome.reserved.amount].map(formatAmount)
    ).toEqual(["6.5", "6.5"])

    const settle = (holdId: string, calls: number) =>
      ok(store.run({ type: "settle", holdId, event: apiBatch(calls) }, NOV + 4 * hour))
    // 9,000 -> 10,000 is free; 10,000 -> 11,500 enters tier 2.
    const settledFirst = settle(first.outcome.holdId, 1_000)
    const settledSecond = settle(second.outcome.holdId, 1_500)

    if (settledFirst.outcome.type !== "settle" || settledSecond.outcome.type !== "settle") {
      throw new Error("not a settle")
    }
    expect(
      [settledFirst.outcome.actual.amount, settledSecond.outcome.actual.amount].map(formatAmount)
    ).toEqual(["0", "6.5"])
    // One event of 11,500 calls costs the same $6.50.
    const statement = store.statements.get("api_calls:inv_2026-11")
    expect(totals(statement)).toMatchObject({ amount: "6.5", quantity: "11500", events: 3 })
    expect(formatAmount(statement?.positions['["api_calls","","calls"]'] ?? BigInt(0))).toBe(
      "11500"
    )
  })

  it("never lets concurrent holds each claim the same included allowance past a hard limit", () => {
    const store = pricedStore({
      cards: [includedApiCallsCard],
      features: [apiCalls],
      limits: [{ id: "month", amount: "5", window: "month" }],
    })
    ok(store.run(register(month("api_calls", NOV, DEC)), NOV + hour))
    const authorize = (key: string) =>
      store.run(
        { type: "authorize", idempotencyKey: key, event: apiBatch(1_000), ttlMs: hour },
        NOV + 2 * hour
      )
    const holds = ["a1", "a2"].map((key) => ok(authorize(key)))
    // Each reserves $2: 1,000 calls past the allowance. A third does not fit the $5 limit.
    expect(
      holds.map(
        (hold) => hold.outcome.type === "authorize" && formatAmount(hold.outcome.reserved.amount)
      )
    ).toEqual(["2", "2"])
    expect(rejection(authorize("a3"))).toMatchObject({ code: "LIMIT_EXCEEDED" })

    for (const hold of holds) {
      if (hold.outcome.type !== "authorize") throw new Error("not a hold")
      ok(
        store.run(
          { type: "settle", holdId: hold.outcome.holdId, event: apiBatch(1_000) },
          NOV + 3 * hour
        )
      )
    }
    // 2,000 calls with 1,000 included: $2, as one event of 2,000 calls would cost.
    expect(totals(store.statements.get("api_calls:inv_2026-11"))).toMatchObject({
      amount: "2",
      quantity: "2000",
    })
    expect(lifetime(store)).toEqual({ amount: "2", quantities: { api_calls: "2000" } })
  })

  it("refuses an event earlier than every statement of its feature", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", DEC, JAN)), NOV + hour))
    expect(rejection(store.run(record("r1", image("512"), DEC - hour), DEC + 30 * minute))).toEqual(
      { code: "NO_STATEMENT", featureSlug: "images", at: DEC - hour }
    )
  })

  it("never seals a period that has not ended by the budget's clock", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    const early = ok(
      store.run({ type: "sealStatements", statementKey: "inv_2026-11", at: DEC }, NOV + 20 * day)
    )
    ok(store.run(charge("c1", image("1024")), NOV + 21 * day))

    expect(early.outcome).toEqual({ type: "sealStatements", statements: [], funding: [] })
    expect(totals(store.statements.get("images:inv_2026-11"))).toMatchObject({
      state: "open",
      amount: "0.04",
    })
  })

  it("refuses period ids and statement keys that start with #", () => {
    const issues = (fields: Partial<StatementRegistration>) => {
      const parsed = budgetStatementRegistrationSchema.safeParse({
        ...month("images", NOV, DEC),
        ...fields,
      })
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."))
    }
    expect([
      issues({}),
      issues({ periodId: "#budget:images" }),
      issues({ statementKey: "#budget" }),
    ]).toEqual([[], ["periodId"], ["statementKey"]])
  })
})

describe("a payer budget keeps every amount it consumes on a statement", () => {
  const ONE = BigInt(100_000_000)
  const aiRequests: FeatureInput = { slug: "ai_requests", eventSlug: "ai.call", priced: false }

  function unpricedStore(limits: BudgetConfigInput["limits"] = []) {
    const store = new MemoryBudgetStore()
    store.cacheCards(usdCard, includedApiCallsCard)
    const parsed = upsertBudgetInternalInputSchema.parse({
      key: "unprice:customer:cus_acme",
      unit: "USD",
      limits,
    })
    ok(store.run({ type: "upsert", projectId: "proj_1", mayLoosen: true, ...parsed }, NOV + hour))
    return store
  }

  it("takes only events once it prices usage", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    const at = NOV + 2 * hour
    const usage = amountUsage(ONE)
    const refused = [
      store.run({ type: "charge", idempotencyKey: "c1", usage }, at),
      store.run({ type: "authorize", idempotencyKey: "a1", usage }, at),
      store.run({ type: "record", idempotencyKey: "r1", usage, occurredAt: at }, at),
      store.run({ type: "lease", leaseKey: "l1", amount: ONE, ttlMs: hour }, at),
    ]
    expect(refused.map(rejection)).toEqual(Array(4).fill({ code: "EVENT_REQUIRED" }))

    const hold = ok(
      store.run({ type: "authorize", idempotencyKey: "a2", event: image("1024") }, at)
    )
    if (hold.outcome.type !== "authorize") throw new Error("not a hold")
    const { holdId } = hold.outcome
    expect(rejection(store.run({ type: "settle", holdId, actual: usage }, at))).toEqual({
      code: "EVENT_REQUIRED",
    })
    ok(store.run({ type: "settle", holdId, event: image("1024") }, at))
    expect(totals(store.statements.get("images:inv_2026-11")).amount).toBe("0.04")
    expect(lifetime(store)).toEqual({ amount: "0.04", quantities: { images: "1" } })
  })

  it("adds pricing only while no hold or lease is open, whatever it holds", () => {
    const store = unpricedStore()
    const at = NOV + 2 * hour
    ok(store.run({ type: "lease", leaseKey: "l1", amount: ONE, ttlMs: hour }, at))
    const captured = { final: false, captured: ONE, extend: BigInt(0) } as const
    ok(store.run({ type: "report", leaseKey: "l1", seq: 1, request: captured }, at))
    expect(store.ledger.held.amount).toBe(BigInt(0))
    expect(rejection(store.run(pricedUpsert({ features: [images] }), at))).toEqual({
      code: "RESERVATIONS_OPEN",
    })
    const final = { final: true, captured: ONE } as const
    ok(store.run({ type: "report", leaseKey: "l1", seq: 2, request: final }, at))
    ok(store.run(pricedUpsert({ features: [images] }), at))
  })

  it("changes or drops pricing only once open holds are settled", () => {
    const store = pricedStore({ features: [images, tokens] })
    ok(store.run(register(month("images", NOV, DEC), month("llm_tokens", NOV, DEC)), NOV + hour))
    const at = NOV + 2 * hour
    const hold = ok(
      store.run({ type: "authorize", idempotencyKey: "a1", event: image("1024") }, at)
    )
    if (hold.outcome.type !== "authorize") throw new Error("not a hold")
    const unpriced = upsertBudgetInternalInputSchema.parse({
      key: "unprice:customer:cus_acme",
      unit: "USD",
      limits: [],
    })
    const changed: BudgetCommand[] = [
      pricedUpsert({ features: [images] }),
      pricedUpsert({ features: [images, tokens], statements: "none" }),
      { type: "upsert", projectId: "proj_1", mayLoosen: true, setsPricing: true, ...unpriced },
    ]
    expect(changed.map((command) => rejection(store.run(command, at)))).toEqual(
      Array(3).fill({ code: "RESERVATIONS_OPEN" })
    )
    ok(store.run(pricedUpsert({ features: [tokens, images] }), at))
    ok(store.run({ type: "settle", holdId: hold.outcome.holdId, event: image("1024") }, at))
    expect(totals(store.statements.get("images:inv_2026-11")).amount).toBe("0.04")
    ok(store.run(pricedUpsert({ features: [images] }), at))
  })

  it("adds pricing only while nothing is held", () => {
    const store = unpricedStore()
    const held = ok(
      store.run(
        { type: "authorize", idempotencyKey: "a1", usage: amountUsage(ONE) },
        NOV + 2 * hour
      )
    )
    if (held.outcome.type !== "authorize") throw new Error("not a hold")
    expect(rejection(store.run(pricedUpsert({ features: [images] }), NOV + 3 * hour))).toEqual({
      code: "RESERVATIONS_OPEN",
    })
    ok(store.run({ type: "release", holdId: held.outcome.holdId }, NOV + 3 * hour))
    ok(store.run(pricedUpsert({ features: [images] }), NOV + 3 * hour))
    expect(store.budget?.config.pricing?.cards).toEqual({ base: usdCard.card.id })
  })

  it("keeps its pricing through an upsert that does not set it, cards cached or not", () => {
    const store = pricedStore({
      features: [images],
      limits: [{ id: "month", amount: "100", window: "month" }],
    })
    store.cards.clear()
    const tightened = upsertBudgetInternalInputSchema.parse({
      key: "unprice:customer:cus_acme",
      unit: "USD",
      limits: [{ id: "month", amount: "50", window: "month" }],
    })
    const upserted = ok(
      store.run(
        { type: "upsert", projectId: "proj_1", mayLoosen: true, ...tightened },
        NOV + 2 * hour
      )
    )
    if (upserted.outcome.type !== "upsert") throw new Error("not an upsert")
    expect(upserted.outcome.changes.map((change) => change.change)).toEqual(["limit.amount"])
    expect(store.budget?.config.pricing?.features.map((feature) => feature.slug)).toEqual([
      "images",
    ])
  })

  it("ignores pricing an upsert sends without setting it, and the order of features", () => {
    const store = pricedStore({ features: [images, tokens] })
    const { setsPricing: _sets, ...unset } = pricedUpsert({ features: [images] }) as Extract<
      BudgetCommand,
      { type: "upsert" }
    >
    const kept = ok(store.run(unset, NOV + 2 * hour))
    if (kept.outcome.type !== "upsert") throw new Error("not an upsert")
    expect(kept.outcome.changes).toEqual([])
    const reordered = ok(store.run(pricedUpsert({ features: [tokens, images] }), NOV + 2 * hour))
    if (reordered.outcome.type !== "upsert") throw new Error("not an upsert")
    expect(reordered.outcome.changes).toEqual([])
    expect(store.budget?.config.pricing?.features.map((feature) => feature.slug)).toEqual([
      "images",
      "llm_tokens",
    ])
  })

  it("holds only rows in force to a feature's dimensions, so a regrouped card stays usable", () => {
    // Images were matched on `resolution` until the regroup, and on `size` since.
    const regroupAt = NOV + day
    const regrouped: CardRows = {
      card: usdCard.card,
      rows: usdCard.rows.flatMap((row) => {
        if (row.featureSlug !== "images") return [row]
        const before = {
          ...row,
          id: `${row.id}_resolution`,
          match: { resolution: row.match.size ?? "" },
          effectiveTo: regroupAt,
        }
        return [before, { ...row, effectiveFrom: regroupAt }]
      }),
    }
    const store = new MemoryBudgetStore()
    store.cacheCards(regrouped)
    ok(store.run(pricedUpsert({ features: [images] }), regroupAt + hour))
    expect(store.budget?.config.pricing?.features.map((feature) => feature.slug)).toEqual([
      "images",
    ])
  })

  it("lets the alarm close an expired estimate however long ago its cards were cached", () => {
    const store = new MemoryBudgetStore()
    const at = NOV + hour
    store.cacheCardsAt(at, usdCard)
    ok(store.run(pricedUpsert({ features: [images], statements: "none" }), at))
    ok(
      store.run(
        { type: "authorize", idempotencyKey: "a1", event: image("1024"), ttlMs: 2 * minute },
        at
      )
    )
    ok(store.run({ type: "sweep" }, at + 10 * minute))
    expect(store.ledger.held.amount).toBe(BigInt(0))
    expect(lifetime(store)).toEqual({ amount: "0.04", quantities: { images: "1" } })
  })

  it("refuses to price with a card cached five minutes ago or never, and writes nothing", () => {
    const store = new MemoryBudgetStore()
    const at = NOV + hour
    store.cacheCardsAt(at, usdCard)
    ok(store.run(pricedUpsert({ features: [images], statements: "none" }), at))
    const charge = (key: string) =>
      store.run({ type: "charge", idempotencyKey: key, event: image("1024") }, at + 5 * minute)
    ok(
      store.run({ type: "charge", idempotencyKey: "c0", event: image("1024") }, at + 5 * minute - 1)
    )
    expect(rejection(charge("c1"))).toEqual({ code: "CARDS_STALE", cardIds: [usdCard.card.id] })
    expect(store.rows.size).toBe(1)
    store.cards.clear()
    store.cardsAt.clear()
    expect(rejection(charge("c2"))).toEqual({ code: "CARDS_STALE", cardIds: [usdCard.card.id] })
  })

  it("refuses a card that cannot take a feature's allowance, at upsert and at ingestion", () => {
    const store = new MemoryBudgetStore()
    store.cacheCards(usdCard)
    expect(
      rejection(store.run(pricedUpsert({ features: [{ ...images, included: "2" }] }), NOV + hour))
    ).toEqual({
      code: "CARD_INCOMPATIBLE",
      cardId: usdCard.card.id,
      violations: [{ code: "INCLUDED_WITH_DIMENSIONS", feature: "images" }],
    })

    const priced = pricedStore({ cards: [includedApiCallsCard], features: [apiCalls] })
    ok(priced.run(register(month("api_calls", NOV, DEC)), NOV + hour))
    // The card refreshes with a successor that prices a second quantity.
    priced.cacheCards({
      ...includedApiCallsCard,
      rows: includedApiCallsCard.rows.map((row) => ({
        ...row,
        price: {
          type: "unit" as const,
          components: [
            { property: "calls", rate: BigInt(200_000), per: 1 },
            { property: null, rate: BigInt(100_000), per: 1 },
          ],
        },
        cost: null,
      })),
    })
    expect(rejection(priced.run(charge("c1", apiBatch(500)), NOV + 2 * hour))).toEqual({
      code: "INCLUDED_NOT_APPLICABLE",
      feature: "api_calls",
      rowId: "row_api_calls_included",
    })
  })

  it("counts only a vector's own quantities, whatever a feature is called", () => {
    const store = unpricedStore([
      { id: "constructor:day", feature: "constructor", amount: "5", window: "day" },
    ])
    const usage = usageOf(ONE, { constructor: BigInt(3) * ONE })
    ok(store.run({ type: "authorize", idempotencyKey: "a1", usage }, NOV + 2 * hour))
    expect(
      rejection(store.run({ type: "charge", idempotencyKey: "c1", usage }, NOV + 2 * hour))
    ).toMatchObject({ code: "LIMIT_EXCEEDED", blocked: { limitId: "constructor:day" } })

    const proto = usageOf(ONE, Object.fromEntries([["__proto__", ONE]]))
    ok(store.run({ type: "authorize", idempotencyKey: "a2", usage: proto }, NOV + 2 * hour))
    ok(store.run({ type: "get" }, NOV + 2 * hour))
    expect(Object.keys(store.ledger.held.quantities).sort()).toEqual(["__proto__", "constructor"])
    expect(formatAmount(store.ledger.held.amount)).toBe("2")
  })

  it("replays a late settle that repeats how its hold closed at expiry", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    const placed = (key: string, at: number) => {
      const hold = ok(
        store.run({ type: "authorize", idempotencyKey: key, event: image("1024"), ttlMs: hour }, at)
      )
      if (hold.outcome.type !== "authorize") throw new Error("not a hold")
      return hold.outcome.holdId
    }

    // Billed at expiry: the estimate's event replays, another settle does not.
    const billed = placed("a1", NOV + 2 * hour)
    store.alarm(NOV + 4 * hour)
    expect(store.rows.get(billed)).toMatchObject({ state: { byExpiry: true, priced: {} } })
    const replayed = ok(
      store.run({ type: "settle", holdId: billed, event: image("1024") }, NOV + 5 * hour)
    )
    expect(replayed.outcome).toMatchObject({ type: "settle", replayed: true })
    expect(
      rejection(store.run({ type: "settle", holdId: billed, event: image("512") }, NOV + 5 * hour))
    ).toEqual({ code: "HOLD_CLOSED", holdId: billed, status: "expired" })

    // Unbilled at expiry (its period sealed first): the same event still replays.
    const unbilled = placed("a2", DEC - 30 * minute)
    ok(store.run({ type: "sealStatements", statementKey: "inv_2026-11", at: DEC }, DEC + minute))
    store.alarm(DEC + hour)
    expect(store.rows.get(unbilled)).toMatchObject({
      state: { byExpiry: true, unbilled: { reason: "PERIOD_CLOSED" } },
    })
    const again = ok(
      store.run({ type: "settle", holdId: unbilled, event: image("1024") }, DEC + 2 * hour)
    )
    expect(again.outcome).toMatchObject({ type: "settle", replayed: true })
  })

  it("bills an expiry after its event's features were reordered", () => {
    const features = [tokens, aiRequests]
    const store = pricedStore({ features })
    ok(
      store.run(register(month("llm_tokens", NOV, DEC), month("ai_requests", NOV, DEC)), NOV + hour)
    )
    const event = aiCall("gpt-4.1", { input_tokens: 1_000_000 })
    ok(store.run({ type: "authorize", idempotencyKey: "a1", event, ttlMs: hour }, NOV + 2 * hour))
    ok(store.run(pricedUpsert({ features: [aiRequests, tokens] }), NOV + 2 * hour))
    store.alarm(NOV + 4 * hour)

    expect(store.rows.get("h_1")).toMatchObject({ state: { byExpiry: true, priced: {} } })
    expect(totals(store.statements.get("llm_tokens:inv_2026-11")).amount).toBe("2")
    expect(totals(store.statements.get("ai_requests:inv_2026-11")).quantity).toBe("1")
  })

  it("keeps a closed hold's event for retries, not the lines it reserved on", () => {
    const store = pricedStore({ features: [images] })
    ok(store.run(register(month("images", NOV, DEC)), NOV + hour))
    ok(store.run({ type: "authorize", idempotencyKey: "a1", event: image("1024") }, NOV + hour))
    expect((store.rows.get("h_1") as HoldOperation).estimate?.features[0]?.lines).toHaveLength(1)
    ok(store.run({ type: "settle", holdId: "h_1", event: image("1024") }, NOV + 2 * hour))
    const { estimate } = store.rows.get("h_1") as HoldOperation
    expect(estimate).toMatchObject({ slug: "image.generated", properties: { size: "1024" } })
    expect(estimate?.features[0]?.lines).toEqual([])
  })

  it("creates a priced budget from a keyed verb's ifMissing, which reads its cards", () => {
    const store = new MemoryBudgetStore()
    store.cacheCards(usdCard)
    const upsert = pricedUpsert({ features: [images], statements: "none" })
    if (upsert.type !== "upsert") throw new Error("not an upsert")
    const { key, projectId, unit, config } = upsert
    const ifMissing = { key, projectId, unit, config }
    expect(
      rejection(
        store.run({ type: "lease", leaseKey: "l1", amount: ONE, ttlMs: hour, ifMissing }, NOV)
      )
    ).toEqual({ code: "EVENT_REQUIRED" })
    const charged = ok(
      store.run({ type: "charge", idempotencyKey: "c1", event: image("1024"), ifMissing }, NOV)
    )
    expect(charged.outcome).toMatchObject({ type: "charge", created: { key } })
    expect(lifetime(store)).toEqual({ amount: "0.04", quantities: { images: "1" } })
  })

  it("refuses to register a period into the budget's own perpetual statements", () => {
    const store = pricedStore({ features: [images], statements: "none" })
    const perpetual = { ...month("images", NOV, DEC), periodId: "#budget:images" }
    expect(rejection(store.run(register(perpetual), NOV + hour))).toEqual({
      code: "STATEMENT_CONFLICT",
      periodId: "#budget:images",
    })
  })
})
