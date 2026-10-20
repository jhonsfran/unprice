import { describe, expect, it } from "vitest"
import { formatBudgetAmount, formatCountdown, subtractAmount, sumAmounts } from "./budget-format"
import { describeOperation } from "./budget-operations"

describe("budget amounts", () => {
  it("formats money with two decimals and other units as stored", () => {
    expect([
      formatBudgetAmount("2000.5", "money:USD"),
      formatBudgetAmount("2000", "units:tokens"),
      formatBudgetAmount("-1234.125", "money:EUR"),
    ]).toEqual(["2,000.50", "2,000", "-1,234.125"])
  })

  it("adds and subtracts decimals exactly", () => {
    expect([sumAmounts(["0.1", "0.2", "5"]), subtractAmount("3", "3.5"), sumAmounts([])]).toEqual([
      "5.3",
      "-0.5",
      "0",
    ])
  })

  it("counts down in the two largest units", () => {
    expect([formatCountdown(7_500_000), formatCountdown(190_000), formatCountdown(0)]).toEqual([
      "2h 05m",
      "3m 10s",
      "now",
    ])
  })
})

describe("describeOperation", () => {
  const hold = {
    kind: "hold" as const,
    id: "h_4790",
    idempotencyKey: "job-991",
    amount: "3",
    ttlMs: 60_000,
    createdAt: 1_000,
    expiresAt: 61_000,
  }

  it("reads an expired settle as charged in full and a normal one against its hold", () => {
    const expired = describeOperation(
      {
        ...hold,
        state: { status: "settled", closedAt: 61_000, actual: "3", crossed: [], byExpiry: true },
      },
      "money:USD"
    )
    const settled = describeOperation(
      { ...hold, state: { status: "settled", closedAt: 9_000, actual: "0.31", crossed: [] } },
      "money:USD"
    )

    expect([expired, settled]).toEqual([
      { kind: "settle", id: "h_4790", detail: "3.00 (expired, charged in full)", at: 61_000 },
      { kind: "settle", id: "h_4790", detail: "0.31 of 3.00 held", at: 9_000 },
    ])
  })

  it("shows what an open lease has left and names a record by its idempotency key", () => {
    const lease = describeOperation(
      {
        kind: "lease",
        id: "l_7",
        leaseKey: "agent-7",
        requested: "3",
        ttlMs: 60_000,
        createdAt: 2_000,
        granted: "3",
        captured: "2",
        last: null,
        expiresAt: 62_000,
        state: { status: "open" },
      },
      "money:USD"
    )
    const record = describeOperation(
      {
        kind: "record",
        id: "r_1",
        idempotencyKey: "evt_77",
        amount: "1200",
        createdAt: 3_000,
        crossed: [],
      },
      "units:tokens"
    )

    expect([lease, record]).toEqual([
      { kind: "lease", id: "agent-7", detail: "1.00 left of 3.00", at: 2_000 },
      { kind: "record", id: "evt_77", detail: "1,200", at: 3_000 },
    ])
  })
})
