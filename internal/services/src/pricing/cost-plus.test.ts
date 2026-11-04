import { type RateRow, modelCostSchema } from "@unprice/db/validators"
import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import { type CostPlusDraft, type ProposedRow, costPlusRevision } from "./cost-plus"
import { CARD_FROM, creditsCostPlusCard, modelCosts, usdCard, usdCostPlusCard } from "./fixtures"

const at = CARD_FROM + 1_000
const costs = [modelCosts.gpt41, modelCosts.claudeSonnet4]

function rates(row: ProposedRow): string[] {
  return row.price.components.map(
    (component) => `${component.property}=${formatAmount(component.rate)}/${component.per}`
  )
}

function summary(draft: CostPlusDraft) {
  return draft.changes.map((change) => ({
    type: change.type,
    match: change.proposed.match,
    rates: rates(change.proposed),
    components:
      change.type === "changed"
        ? change.components.map((c) => [
            c.property,
            c.before ? formatAmount(c.before.rate) : null,
            c.after ? formatAmount(c.after.rate) : null,
          ])
        : [],
  }))
}

function asRow(proposed: ProposedRow, id: string): RateRow {
  return {
    ...proposed,
    id,
    rateCardId: usdCostPlusCard.id,
    effectiveFrom: CARD_FROM,
    effectiveTo: null,
  }
}

describe("costPlusRevision", () => {
  it("proposes cost times 1.3 rounded up to a cent, diffed against the current rows", () => {
    const draft = costPlusRevision(usdCostPlusCard, costs, usdCard.rows, at)

    expect(summary(draft)).toEqual([
      {
        type: "changed",
        match: { model: "claude-sonnet-4" },
        rates: [
          "input_tokens=3.9/1000000",
          "cached_input_tokens=0.39/1000000",
          "output_tokens=19.5/1000000",
          "cache_write_tokens=4.88/1000000",
        ],
        components: [
          ["input_tokens", "3", "3.9"],
          ["cached_input_tokens", "0.3", "0.39"],
          ["output_tokens", "15", "19.5"],
          ["cache_write_tokens", "3.75", "4.88"],
        ],
      },
      {
        type: "changed",
        match: { model: "gpt-4.1" },
        rates: [
          "input_tokens=2.6/1000000",
          "cached_input_tokens=0.65/1000000",
          "output_tokens=10.4/1000000",
        ],
        components: [
          ["input_tokens", "2", "2.6"],
          ["cached_input_tokens", "0.5", "0.65"],
          ["output_tokens", "8", "10.4"],
        ],
      },
    ])
    const claude = draft.changes[0]?.proposed
    expect(claude?.cost.components.map((c) => formatAmount(c.rate))).toEqual([
      "3",
      "0.3",
      "15",
      "3.75",
    ])
    expect(claude?.sourceRef).toBe("snap_2026_11_01")
    expect(claude?.source).toBe("catalog")
  })

  it("prices a credits card in credits, rounded up to whole credits", () => {
    const draft = costPlusRevision(creditsCostPlusCard, costs, [], at)
    expect(summary(draft)).toEqual([
      {
        type: "added",
        match: { model: "claude-sonnet-4" },
        rates: [
          "input_tokens=390/1000000",
          "cached_input_tokens=39/1000000",
          "output_tokens=1950/1000000",
          "cache_write_tokens=488/1000000",
        ],
        components: [],
      },
      {
        type: "added",
        match: { model: "gpt-4.1" },
        rates: [
          "input_tokens=260/1000000",
          "cached_input_tokens=65/1000000",
          "output_tokens=1040/1000000",
        ],
        components: [],
      },
    ])
  })

  it("reports a row already at the proposed price and cost as unchanged", () => {
    const first = costPlusRevision(usdCostPlusCard, costs, [], at)
    const current = first.changes.map((change, index) => asRow(change.proposed, `row_${index}`))
    const second = costPlusRevision(usdCostPlusCard, costs, current, at)
    expect(second.changes.map((change) => change.type)).toEqual(["unchanged", "unchanged"])
  })

  it("reports a cost-only change as changed with no price component", () => {
    const first = costPlusRevision(usdCostPlusCard, [modelCosts.gpt41], [], at)
    const proposed = first.changes[0]?.proposed
    if (!proposed) throw new Error("no proposal")
    const staleCost = {
      components: [{ property: "input_tokens", rate: BigInt(1), per: 1_000_000 }],
    }
    const current = { ...asRow(proposed, "row_gpt"), cost: staleCost }
    const draft = costPlusRevision(usdCostPlusCard, [modelCosts.gpt41], [current], at)
    expect(summary(draft).map((change) => [change.type, change.components])).toEqual([
      ["changed", []],
    ])
  })

  it("diffs against the open row a publish replaces, even one scheduled after `at`", () => {
    const [gpt] = costPlusRevision(usdCostPlusCard, [modelCosts.gpt41], [], at).changes
    if (!gpt) throw new Error("no proposal")
    const scheduledFrom = at + 60_000
    const catalog = { ...asRow(gpt.proposed, "row_catalog"), effectiveTo: scheduledFrom }
    const manual: RateRow = {
      ...asRow(gpt.proposed, "row_manual"),
      price: {
        type: "unit",
        components: [{ property: "input_tokens", rate: BigInt(900_000_000), per: 1_000_000 }],
      },
      source: "manual",
      sourceRef: null,
      effectiveFrom: scheduledFrom,
    }

    const draft = costPlusRevision(usdCostPlusCard, [modelCosts.gpt41], [catalog, manual], at)

    expect(
      draft.changes.map((change) => [
        change.type,
        change.type === "added" ? null : change.current.id,
      ])
    ).toEqual([["changed", "row_manual"]])
  })

  it("orders its changes by match, whatever order the costs arrive in", () => {
    const forward = costPlusRevision(usdCostPlusCard, costs, [], at)
    const reversed = costPlusRevision(usdCostPlusCard, [...costs].reverse(), [], at)

    expect(forward.changes.map((change) => change.proposed.match.model)).toEqual([
      "claude-sonnet-4",
      "gpt-4.1",
    ])
    expect(reversed).toEqual(forward)
  })

  it("prefers a manual cost and ignores costs not yet effective", () => {
    const manual = modelCostSchema.parse({
      provider: "openai",
      model: "gpt-4.1",
      components: { input: "1.00" },
      effectiveFrom: CARD_FROM - 1_000,
      source: "manual",
      sourceRef: "user_42",
    })
    const future = modelCostSchema.parse({
      provider: "openai",
      model: "o3",
      components: { input: "2.00" },
      effectiveFrom: at + 1,
      source: "modelsdev",
      sourceRef: "snap_next",
    })
    const draft = costPlusRevision(usdCostPlusCard, [modelCosts.gpt41, manual, future], [], at)
    expect(summary(draft).map((change) => change.rates)).toEqual([["input_tokens=1.3/1000000"]])
  })
})
