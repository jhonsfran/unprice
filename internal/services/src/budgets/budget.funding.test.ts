import { upsertBudgetInternalInputSchema } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import { CARD_FROM, usdCard } from "../pricing/fixtures"
import type { BudgetCommand, BudgetTransition, FundingResult } from "./index"
import { reserveAmount } from "./index"
import { MemoryBudgetStore } from "./memory-store.fixture"

const hour = 3_600_000
const NOV = CARD_FROM
const DEC = Date.parse("2026-12-01T00:00:00.000Z")
const KEY = "inv_nov"
const image = { slug: "image.generated", properties: { size: "1024" } }
const tokens = { slug: "ai.call", properties: { model: "gpt-4.1", input_tokens: 10_000 } }

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

function pricing(funding?: object, statements: "required" | "none" = "required") {
  return {
    cards: { base: usdCard.card.id },
    features: [
      {
        slug: "images",
        eventSlug: "image.generated",
        dimensions: ["size"],
        meterProperty: null,
        included: null,
        priced: true,
      },
      {
        slug: "llm_tokens",
        eventSlug: "ai.call",
        dimensions: ["model"],
        meterProperty: null,
        included: null,
        priced: true,
      },
    ],
    statements,
    ...(funding && { funding }),
  }
}

/** A prepaid payer with one November statement per feature under KEY; `free` ones are trials. */
function prepaidStore(free: readonly string[] = []) {
  const store = new MemoryBudgetStore()
  store.cacheCards(usdCard)
  const parsed = upsertBudgetInternalInputSchema.parse({
    key: "unprice:customer:cus_acme",
    unit: "USD",
    limits: [],
    pricing: pricing({ mode: "prepaid", customerId: "cus_acme" }),
  })
  ok(store.run({ type: "upsert", projectId: "proj_1", mayLoosen: true, ...parsed }, NOV + hour))
  const statements = ["images", "llm_tokens"].map((featureSlug) => ({
    periodId: `${featureSlug}:nov`,
    statementKey: KEY,
    featureSlug,
    start: NOV,
    end: DEC,
    ...(free.includes(featureSlug) && { free: true }),
  }))
  ok(store.run({ type: "registerStatements", statements }, NOV + hour))
  return store
}

const charge = (key: string, event: typeof image | typeof tokens = image): BudgetCommand => ({
  type: "charge",
  idempotencyKey: key,
  event,
})
const fund = (required: number): BudgetCommand => ({
  type: "fund",
  statementKey: KEY,
  required: BigInt(required),
})
const apply = (seq: number, result: FundingResult): BudgetCommand => ({
  type: "applyFunding",
  statementKey: KEY,
  seq,
  result,
})
const reserved = (granted: number): FundingResult => ({
  kind: "reserved",
  reservationId: "res_1",
  granted: BigInt(granted),
})

describe("a prepaid budget lends only what the wallet reserved", () => {
  it("admits trial usage without funds, and still asks funds for billed usage", () => {
    const store = prepaidStore(["images"])

    ok(store.run(charge("c1"), NOV + 2 * hour))
    expect(rejection(store.run(charge("c2", tokens), NOV + 2 * hour))).toMatchObject({
      code: "FUNDING_REQUIRED",
    })
  })

  it("refuses a charge with FUNDING_REQUIRED and writes nothing", () => {
    const store = prepaidStore()
    const writes = store.writes

    const refused = store.run(charge("c1"), NOV + 2 * hour)

    expect(rejection(refused)).toEqual({
      code: "FUNDING_REQUIRED",
      needs: [{ statementKey: KEY, required: BigInt(4_000_000), available: BigInt(0) }],
    })
    expect(store.writes).toBe(writes)
    expect(store.funding.size).toBe(0)
  })

  it("persists one reserve intent and answers it unchanged until the wallet's result lands", () => {
    const store = prepaidStore()

    const first = ok(store.run(fund(4_000_000), NOV + 2 * hour))
    const writes = store.writes
    const again = ok(store.run(fund(9_000_000), NOV + 3 * hour))

    const work = {
      statementKey: KEY,
      customerId: "cus_acme",
      currency: "USD",
      reservationId: null,
      intent: {
        kind: "reserve",
        seq: 1,
        amount: BigInt(104_000_000),
        at: NOV + 2 * hour,
        periodStart: NOV,
        periodEnd: DEC,
      },
    }
    expect(first.outcome).toEqual({ type: "fund", funding: [work] })
    expect(again.outcome).toEqual({ type: "fund", funding: [work] })
    expect(store.writes).toBe(writes)
  })

  it("applies the grant once, replays it, and refuses a seq that is not pending", () => {
    const store = prepaidStore()
    ok(store.run(fund(4_000_000), NOV + 2 * hour))

    const applied = ok(store.run(apply(1, reserved(104_000_000)), NOV + 2 * hour))
    const replayed = ok(store.run(apply(1, reserved(104_000_000)), NOV + 3 * hour))
    const ahead = store.run(apply(3, reserved(1)), NOV + 3 * hour)
    const charged = ok(store.run(charge("c1"), NOV + 4 * hour))

    expect(applied.outcome).toEqual({ type: "applyFunding", funding: [], replayed: false })
    expect(replayed.outcome).toEqual({ type: "applyFunding", funding: [], replayed: true })
    expect(rejection(ahead)).toEqual({
      code: "FUNDING_SEQ_CONFLICT",
      statementKey: KEY,
      seq: 1,
      requested: 3,
    })
    expect(charged.outcome).toMatchObject({ type: "charge", replayed: false })
    expect(store.funding.get(KEY)).toEqual({
      statementKey: KEY,
      customerId: "cus_acme",
      reservationId: "res_1",
      allocated: BigInt(104_000_000),
      consumed: BigInt(4_000_000),
      seq: 1,
      pending: null,
      state: "open",
      closedAt: null,
      captured: BigInt(0),
    })
  })

  it("counts an open hold against the allocation, so two holds never share one runway", () => {
    const store = prepaidStore()
    ok(store.run(fund(4_000_000), NOV + 2 * hour))
    ok(store.run(apply(1, reserved(6_000_000)), NOV + 2 * hour))

    ok(store.run({ type: "authorize", idempotencyKey: "a1", event: image }, NOV + 3 * hour))
    const second = store.run(
      { type: "authorize", idempotencyKey: "a2", event: image },
      NOV + 3 * hour
    )

    expect(rejection(second)).toEqual({
      code: "FUNDING_REQUIRED",
      needs: [{ statementKey: KEY, required: BigInt(4_000_000), available: BigInt(2_000_000) }],
    })
  })

  it("lets recorded usage overdraw, and captures at most the allocation at seal", () => {
    const store = prepaidStore()
    ok(store.run(fund(4_000_000), NOV + 2 * hour))
    ok(store.run(apply(1, reserved(10_000_000)), NOV + 2 * hour))
    ok(store.run(charge("c1"), NOV + 3 * hour))
    const recorded = {
      type: "record",
      idempotencyKey: "r1",
      event: tokens,
      occurredAt: NOV + 3 * hour,
    }
    ok(store.run(recorded as BudgetCommand, NOV + 3 * hour))
    ok(store.run({ ...recorded, idempotencyKey: "r2" } as BudgetCommand, NOV + 3 * hour))

    const funding = store.funding.get(KEY)
    const sealed = ok(store.run({ type: "sealStatements", statementKey: KEY, at: DEC }, DEC + hour))
    const closed = ok(store.run(apply(2, { kind: "closed" }), DEC + 2 * hour))

    expect(funding?.consumed).toBe(BigInt(4_000_000 + 2 * 2_000_000))
    expect(sealed.outcome).toMatchObject({
      type: "sealStatements",
      funding: [
        {
          reservationId: "res_1",
          intent: {
            kind: "close",
            seq: 2,
            captures: [
              { periodId: "images:nov", amount: BigInt(4_000_000) },
              { periodId: "llm_tokens:nov", amount: BigInt(4_000_000) },
            ],
          },
        },
      ],
    })
    expect(closed.outcome).toEqual({ type: "applyFunding", funding: [], replayed: false })
    expect(store.funding.get(KEY)).toMatchObject({
      state: "closed",
      captured: BigInt(8_000_000),
      consumed: BigInt(8_000_000),
      allocated: BigInt(10_000_000),
    })
  })

  it("releases a free (trial) statement's usage at close and captures only billed statements", () => {
    const store = prepaidStore(["images"])
    ok(store.run(fund(4_000_000), NOV + 2 * hour))
    ok(store.run(apply(1, reserved(10_000_000)), NOV + 2 * hour))
    ok(store.run(charge("c1"), NOV + 3 * hour))
    ok(store.run(charge("c2", tokens), NOV + 3 * hour))

    const unwaived = store.run(
      {
        type: "registerStatements",
        statements: [
          {
            periodId: "images:nov",
            statementKey: KEY,
            featureSlug: "images",
            start: NOV,
            end: DEC,
          },
        ],
      },
      NOV + 4 * hour
    )
    const sealed = ok(store.run({ type: "sealStatements", statementKey: KEY, at: DEC }, DEC + hour))
    ok(store.run(apply(2, { kind: "closed" }), DEC + 2 * hour))

    expect(rejection(unwaived)).toEqual({ code: "STATEMENT_CONFLICT", periodId: "images:nov" })
    expect(sealed.outcome).toMatchObject({
      type: "sealStatements",
      funding: [
        {
          reservationId: "res_1",
          intent: {
            kind: "close",
            seq: 2,
            captures: [{ periodId: "llm_tokens:nov", amount: BigInt(2_000_000) }],
          },
        },
      ],
    })
    expect(store.statements.get("images:nov")).toMatchObject({
      free: true,
      state: "sealed",
      amount: BigInt(4_000_000),
    })
    expect(store.funding.get(KEY)).toMatchObject({
      state: "closed",
      captured: BigInt(2_000_000),
      // The free statement's 4_000_000 never consumed the allocation.
      consumed: BigInt(2_000_000),
      allocated: BigInt(10_000_000),
    })
  })

  it("closes at once when the reserve lands after every statement of its key sealed", () => {
    const store = prepaidStore()
    ok(store.run(fund(4_000_000), NOV + 2 * hour))
    const sealed = ok(store.run({ type: "sealStatements", statementKey: KEY, at: DEC }, DEC + hour))

    const applied = ok(store.run(apply(1, reserved(104_000_000)), DEC + 2 * hour))

    expect(sealed.outcome).toMatchObject({ funding: [{ intent: { kind: "reserve", seq: 1 } }] })
    expect(applied.outcome).toMatchObject({
      funding: [{ reservationId: "res_1", intent: { kind: "close", seq: 2, captures: [] } }],
    })
  })

  it("refuses a closed key's funding and leaves a key without a reservation alone at seal", () => {
    const store = prepaidStore()
    const sealed = ok(store.run({ type: "sealStatements", statementKey: KEY, at: DEC }, DEC + hour))
    const funded = ok(store.run(fund(4_000_000), DEC + 2 * hour))

    expect(sealed.outcome).toMatchObject({ funding: [] })
    expect(funded.outcome).toEqual({ type: "fund", funding: [] })
    expect(store.funding.size).toBe(0)
  })
})

describe("funding configuration", () => {
  const parse = (unit: string, statements: "required" | "none") =>
    upsertBudgetInternalInputSchema.safeParse({
      key: "unprice:customer:cus_acme",
      unit,
      limits: [],
      pricing: pricing({ mode: "prepaid", customerId: "cus_acme" }, statements),
    })

  it("takes a prepaid budget only in a wallet currency with registered statements", () => {
    expect(parse("USD", "required").success).toBe(true)
    expect(parse("credits:ai", "required").error?.issues.map((i) => i.message)).toEqual([
      "a prepaid budget's unit must be a wallet currency",
    ])
    expect(parse("USD", "none").error?.issues.map((i) => i.message)).toEqual([
      "a prepaid budget needs registered statements",
    ])
  })

  it("sizes a reserve as the shortfall plus runway", () => {
    expect(reserveAmount(BigInt(4_000_000), BigInt(0))).toBe(BigInt(104_000_000))
    expect(reserveAmount(BigInt(4_000_000), BigInt(-1_000_000))).toBe(BigInt(104_000_000))
    expect(reserveAmount(BigInt(5_000_000_000), BigInt(0))).toBe(BigInt(5_000_000_000))
  })
})
