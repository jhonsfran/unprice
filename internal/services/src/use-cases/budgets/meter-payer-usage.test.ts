import { budgetJournalRowSchema } from "@unprice/lakehouse"
import { describe, expect, it } from "vitest"
import { type PayerUsageResult, meterPayerUsage } from "./meter-payer-usage"
import { NOV, PROJECT_ID, image, payerHarness } from "./payer-budget.fixture"

const DAY = 86_400_000
const receivedAt = NOV + 3_600_000

const charged = (customerId: string, idempotencyKey: string, size: string) => ({
  projectId: PROJECT_ID,
  customerId,
  idempotencyKey,
  ...image(size),
})

const recorded = (
  customerId: string,
  idempotencyKey: string,
  size: string,
  occurredAt: number
) => ({
  ...charged(customerId, idempotencyKey, size),
  occurredAt,
})

/** The budget's answer to an event that reached it. */
function decided(answer: PayerUsageResult | undefined) {
  if (!answer || !("result" in answer)) throw new Error("the event was not decided")
  return answer.result
}

/** Each event's key and outcome: ok, the rejection code, or UNAVAILABLE. */
const outcomes = (results: PayerUsageResult[]) =>
  results.map((answer) => [
    answer.event.idempotencyKey,
    "unavailable" in answer ? "UNAVAILABLE" : (answer.result.err?.code ?? "ok"),
  ])

describe("meterPayerUsage", () => {
  it("records usage into the customer's payer budget and prices it at ingestion", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")

    const [result] = await meterPayerUsage(h.deps, {
      verb: "record",
      receivedAt,
      events: [recorded("cus_a", "e1", "1024", NOV + 1_000)],
    })

    expect(decided(result).val).toMatchObject({
      type: "record",
      usage: { amount: BigInt(4_000_000) },
      replayed: false,
      crossed: [],
    })
    expect(h.calls.at(-1)).toEqual({
      address: { projectId: PROJECT_ID, key: "unprice:customer:cus_a" },
      type: "record",
    })
    expect(
      h
        .storeOf({ projectId: PROJECT_ID, key: "unprice:customer:cus_a" })
        .statements.get("images:bp_nov")
    ).toMatchObject({ amount: BigInt(4_000_000), events: 1 })
  })

  it("replays an idempotent repeat with the first answer and counts it once", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")
    const input = {
      verb: "record" as const,
      receivedAt,
      events: [recorded("cus_a", "e1", "512", NOV + 1_000)],
    }

    await meterPayerUsage(h.deps, input)
    const [again] = await meterPayerUsage(h.deps, input)

    expect(decided(again).val).toMatchObject({
      usage: { amount: BigInt(1_800_000) },
      replayed: true,
    })
    expect(
      h
        .storeOf({ projectId: PROJECT_ID, key: "unprice:customer:cus_a" })
        .statements.get("images:bp_nov")
    ).toMatchObject({ amount: BigInt(1_800_000), events: 1 })
  })

  it("refuses unpriced, unknown, too-late, and budget-less events and journals each refusal", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")
    h.clock.now = NOV + 2 * DAY

    const results = await meterPayerUsage(h.deps, {
      verb: "record",
      receivedAt: NOV + 2 * DAY,
      events: [
        recorded("cus_a", "priced", "1024", NOV + 2 * DAY - 1_000),
        recorded("cus_a", "unpriced", "2048", NOV + 2 * DAY - 1_000),
        { ...recorded("cus_a", "unknown", "1024", NOV + 2 * DAY - 1_000), eventSlug: "chat.sent" },
        recorded("cus_a", "late", "1024", NOV + 1_000),
        recorded("cus_nobody", "orphan", "1024", NOV + 2 * DAY - 1_000),
      ],
    })
    await h.flush()

    expect(outcomes(results)).toEqual([
      ["priced", "ok"],
      ["unpriced", "NOT_PRICED"],
      ["unknown", "UNKNOWN_EVENT"],
      ["late", "TOO_LATE"],
      ["orphan", "BUDGET_NOT_FOUND"],
    ])
    expect(h.journaled.map((row) => budgetJournalRowSchema.parse(row))).toHaveLength(4)
    expect(h.journaled[0]).toEqual({
      schema_version: 1,
      project_id: PROJECT_ID,
      budget_key: "unprice:customer:cus_a",
      seq: 0,
      operation_id: "r:unpriced",
      kind: "record",
      status: "rejected",
      timestamp: new Date(NOV + 2 * DAY).toISOString(),
      data: {
        customerId: "cus_a",
        idempotencyKey: "unpriced",
        event: { slug: "image.generated", properties: { size: "2048" } },
        occurredAt: NOV + 2 * DAY - 1_000,
        rejection: expect.objectContaining({ code: "NOT_PRICED" }),
      },
    })
    expect(h.journaled.map((row) => row.budget_key)).toEqual([
      "unprice:customer:cus_a",
      "unprice:customer:cus_a",
      "unprice:customer:cus_a",
      "unprice:customer:cus_nobody",
    ])
  })

  it("charges synchronously and denies past a hard quantity limit with LIMIT_EXCEEDED", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a", { imagesLimit: 2 })

    const results = await meterPayerUsage(h.deps, {
      verb: "charge",
      receivedAt,
      events: ["c1", "c2", "c3"].map((key) => charged("cus_a", key, "1024")),
    })
    await h.flush()

    expect(outcomes(results)).toEqual([
      ["c1", "ok"],
      ["c2", "ok"],
      ["c3", "LIMIT_EXCEEDED"],
    ])
    expect(h.journaled.map((row) => [row.operation_id, row.kind])).toEqual([["r:c3", "charge"]])
  })

  it("denies a prepaid charge the wallet cannot fund with WALLET_EMPTY", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a", { prepaid: true })

    const [result] = await meterPayerUsage(h.deps, {
      verb: "charge",
      receivedAt,
      events: [charged("cus_a", "c1", "1024")],
    })

    expect(decided(result).err?.rejection).toEqual({
      code: "WALLET_EMPTY",
      statementKey: "inv_nov",
      required: BigInt(4_000_000),
      available: BigInt(0),
    })
  })

  it("leaves a charge and the customer's later ones undecided while the wallet refuses", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a", { prepaid: true })
    h.wallet.balance = BigInt(1_000_000_000)
    h.wallet.refuseWith = "WALLET_RESERVATION_ALREADY_RECONCILED"

    const results = await meterPayerUsage(h.deps, {
      verb: "charge",
      receivedAt,
      events: [charged("cus_a", "c1", "1024"), charged("cus_a", "c2", "1024")],
    })
    await h.flush()

    expect(outcomes(results)).toEqual([
      ["c1", "UNAVAILABLE"],
      ["c2", "UNAVAILABLE"],
    ])
    expect(h.journaled).toEqual([])
    expect(h.wallet.calls).toHaveLength(1)
  })

  it("answers a mixed batch of 100 in request order, each customer's events in sequence", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")
    await h.createPayer("cus_b")
    const events = Array.from({ length: 100 }, (_, n) =>
      // Five unpriced events per customer: n = 4, 24, ... (cus_a) and n = 9, 29, ... (cus_b).
      recorded(
        n % 2 === 0 ? "cus_a" : "cus_b",
        `e${n}`,
        n % 20 === 4 || n % 20 === 9 ? "2048" : "512",
        NOV + n
      )
    )

    const results = await meterPayerUsage(h.deps, { verb: "record", receivedAt, events })
    await h.flush()

    expect(results.map(({ event }) => event.idempotencyKey)).toEqual(
      events.map((e) => e.idempotencyKey)
    )
    expect(outcomes(results).filter(([, outcome]) => outcome === "NOT_PRICED")).toHaveLength(10)
    expect(h.journaled).toHaveLength(10)
    for (const customer of ["cus_a", "cus_b"]) {
      expect(
        h
          .storeOf({ projectId: PROJECT_ID, key: `unprice:customer:${customer}` })
          .statements.get("images:bp_nov")
      ).toMatchObject({ events: 45, amount: BigInt(45 * 1_800_000) })
    }
  })

  it("only logs refusals when no journal stream is bound", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")

    await meterPayerUsage(
      { ...h.deps, journal: null },
      { verb: "record", receivedAt, events: [recorded("cus_a", "e1", "2048", NOV + 1_000)] }
    )

    expect(h.journaled).toEqual([])
    expect(h.logged).toEqual([
      {
        level: "warn",
        message: "refused usage events were not journaled: no budget journal stream is bound",
        fields: { rejected: 1 },
      },
    ])
  })

  it("answers UNAVAILABLE for a customer whose budget is unreachable and decides the rest", async () => {
    const h = payerHarness()
    await h.createPayer("cus_a")
    await h.createPayer("cus_b")
    // cus_b's budget takes one event, then its transport fails.
    let reached = 0
    const budgets = {
      ...h.budgets,
      execute: ((address, request) => {
        if (address.key === "unprice:customer:cus_b" && ++reached > 1) {
          return Promise.reject(new Error("Network connection lost."))
        }
        return h.budgets.execute(address, request)
      }) satisfies typeof h.budgets.execute,
    }

    const results = await meterPayerUsage(
      { ...h.deps, budgets },
      {
        verb: "record",
        receivedAt,
        events: [
          recorded("cus_b", "b1", "512", NOV + 1),
          recorded("cus_a", "a1", "512", NOV + 2),
          recorded("cus_b", "b2", "512", NOV + 3),
          recorded("cus_a", "a2", "2048", NOV + 4),
          recorded("cus_b", "b3", "512", NOV + 5),
        ],
      }
    )
    await h.flush()

    expect(outcomes(results)).toEqual([
      ["b1", "ok"],
      ["a1", "ok"],
      ["b2", "UNAVAILABLE"],
      ["a2", "NOT_PRICED"],
      ["b3", "UNAVAILABLE"],
    ])
    // The transport failure is logged, never journaled; the budget's refusal still is.
    expect(h.journaled.map((row) => row.operation_id)).toEqual(["r:a2"])
    expect(h.logged).toEqual([
      {
        level: "error",
        message: new Error("Network connection lost."),
        fields: {
          context: "payer budget unreachable: usage events left undecided",
          project_id: PROJECT_ID,
          customer_id: "cus_b",
          undecided: 2,
        },
      },
    ])
    expect(
      h
        .storeOf({ projectId: PROJECT_ID, key: "unprice:customer:cus_b" })
        .statements.get("images:bp_nov")
    ).toMatchObject({ amount: BigInt(1_800_000), events: 1 })
  })
})
