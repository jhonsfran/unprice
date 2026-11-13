import { FetchError, Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { journalAnalytics } from "../../analytics/journal.fixture"
import {
  type GetUsageDashboardInput,
  getUsageDashboard,
  hasUsageDashboardEvidence,
} from "./get-usage-dashboard"

const now = Date.parse("2026-06-13T09:30:00.000Z")
const last24hQueryStart = Date.parse("2026-06-12T09:00:00.000Z")

describe("getUsageDashboard", () => {
  it("distinguishes provisional empty results from usage evidence", () => {
    expect(
      hasUsageDashboardEvidence({
        summary: { featureCount: 0, totalLatestUsage: 0, spending: [] },
        features: [],
        timeseries: [],
        topConsumers: [],
        freshness: { generatedAt: now, dataFrom: last24hQueryStart, dataTo: now },
      })
    ).toBe(false)
  })

  it("folds journal rows into feature totals, per-bucket series, and a summary", async () => {
    const { budgetJournal, queries } = journalAnalytics(() => [
      {
        bucket: "2026-06-13T07:00:00Z",
        feature_slug: "tokens",
        unit: "money:EUR",
        events: "3",
        quantity: "1500.00000000",
        amount: "0.75000000",
      },
      {
        bucket: "2026-06-13T07:00:00Z",
        feature_slug: "calls",
        unit: "money:EUR",
        events: 2,
        quantity: "2.00000000",
        amount: "-0.10000000",
      },
      {
        bucket: "2026-06-13T09:00:00Z",
        feature_slug: "tokens",
        unit: "money:EUR",
        events: 1,
        quantity: "500.00000000",
        amount: "0.25000000",
      },
    ])

    const result = await getUsageDashboard(
      { budgetJournal, customers: fakeCustomers(), now: () => now },
      input({ customerId: "cus_1" })
    )

    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain("budget_key = 'unprice:customer:cus_1'")
    expect(queries[0]).toContain("date_trunc('hour', timestamp)")
    expect(queries[0]).toContain("timestamp >= '2026-06-12T09:00:00.000Z'")
    expect(result.val?.features).toEqual([
      {
        featureSlug: "tokens",
        usage: 2000,
        spending: [{ amount: "1", currency: "EUR", displayAmount: expect.any(String) }],
      },
      {
        featureSlug: "calls",
        usage: 2,
        spending: [{ amount: "-0.1", currency: "EUR", displayAmount: expect.any(String) }],
      },
    ])
    expect(
      result.val?.timeseries.map(({ date, featureSlug, usage }) => [date, featureSlug, usage])
    ).toEqual([
      [Date.parse("2026-06-13T07:00:00Z"), "calls", 2],
      [Date.parse("2026-06-13T07:00:00Z"), "tokens", 1500],
      [Date.parse("2026-06-13T09:00:00Z"), "calls", 0],
      [Date.parse("2026-06-13T09:00:00Z"), "tokens", 500],
    ])
    expect(result.val?.summary).toMatchObject({
      featureCount: 2,
      totalLatestUsage: 2002,
      spending: [{ amount: "0.9", currency: "EUR" }],
    })
    expect(result.val?.topConsumers).toEqual([])
    expect(result.val?.freshness).toEqual({
      generatedAt: now,
      dataFrom: last24hQueryStart,
      dataTo: now,
    })
    expect(result.val?.warnings).toBeUndefined()
  })

  it("warns when events fed more features than the query reads", async () => {
    const { budgetJournal } = journalAnalytics(() => [
      {
        bucket: "2026-06-13T07:00:00Z",
        feature_slug: null,
        unit: "money:USD",
        events: 4,
        quantity: null,
        amount: null,
      },
    ])
    const result = await getUsageDashboard(
      { budgetJournal, customers: fakeCustomers(), now: () => now },
      input({ customerId: "cus_1" })
    )
    expect(result.val?.features).toEqual([])
    expect(result.val?.warnings).toEqual([
      "4 events fed more than 8 features; their other features are not shown.",
    ])
  })

  it("keeps currencies separate for one feature in summaries and time buckets", async () => {
    const { budgetJournal } = journalAnalytics(() => [
      {
        bucket: "2026-06-13T07:00:00Z",
        feature_slug: "tokens",
        unit: "money:EUR",
        events: 1,
        quantity: "10",
        amount: "1",
      },
      {
        bucket: "2026-06-13T07:00:00Z",
        feature_slug: "tokens",
        unit: "money:USD",
        events: 1,
        quantity: "20",
        amount: "2",
      },
      {
        bucket: "2026-06-13T09:00:00Z",
        feature_slug: "tokens",
        unit: "money:EUR",
        events: 1,
        quantity: "30",
        amount: "3",
      },
    ])
    const result = await getUsageDashboard(
      { budgetJournal, customers: fakeCustomers(), now: () => now },
      input()
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.features).toMatchObject([
      {
        featureSlug: "tokens",
        usage: 60,
        spending: [
          { amount: "4", currency: "EUR" },
          { amount: "2", currency: "USD" },
        ],
      },
    ])
    expect(result.val?.summary).toMatchObject({
      featureCount: 1,
      totalLatestUsage: 60,
      spending: [
        { amount: "4", currency: "EUR" },
        { amount: "2", currency: "USD" },
      ],
    })
    expect(result.val?.timeseries).toMatchObject([
      {
        usage: 30,
        spending: [
          { amount: "1", currency: "EUR" },
          { amount: "2", currency: "USD" },
        ],
      },
      { usage: 30, spending: [{ amount: "3", currency: "EUR" }] },
    ])
  })

  it("keeps every currency when a top consumer used different payer units", async () => {
    const { budgetJournal } = journalAnalytics((sql) =>
      sql.includes("amount_total")
        ? [
            { budget_key: "unprice:customer:cus_1", unit: "money:USD", events: 5, amount: "7" },
            { budget_key: "unprice:customer:cus_1", unit: "money:EUR", events: 2, amount: "3" },
          ]
        : []
    )
    const result = await getUsageDashboard(
      {
        budgetJournal,
        customers: fakeCustomers([{ id: "cus_1", email: "a@example.com", name: "A" }]),
        now: () => now,
      },
      input({ customerId: undefined })
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.topConsumers).toHaveLength(1)
    expect(result.val?.topConsumers[0]).toMatchObject({ customerId: "cus_1", totalUsage: 7 })
    expect(result.val?.topConsumers[0]?.displaySpending).toBe("3,00\u00a0€ + $7.00")
  })

  it("ranks the project's top payers and resolves them to customers", async () => {
    const { budgetJournal, queries } = journalAnalytics((sql) =>
      sql.includes("amount_total")
        ? [
            {
              budget_key: "unprice:customer:cus_2",
              unit: "money:USD",
              events: "7",
              amount: "12.50000000",
            },
            {
              budget_key: "unprice:customer:cus_gone",
              unit: "money:USD",
              events: "1",
              amount: "1.00000000",
            },
          ]
        : []
    )
    const result = await getUsageDashboard(
      {
        budgetJournal,
        customers: fakeCustomers([{ id: "cus_2", email: "b@example.com", name: "B" }]),
        now: () => now,
      },
      input({ customerId: undefined, range: "30d" })
    )

    expect(queries[0]).toContain("starts_with(budget_key, 'unprice:customer:')")
    expect(queries[0]).toContain("date_trunc('day', timestamp)")
    expect(queries[1]).toContain("LIMIT 10")
    expect(result.val?.topConsumers).toEqual([
      {
        customerId: "cus_2",
        email: "b@example.com",
        name: "B",
        totalUsage: 7,
        displaySpending: expect.stringContaining("12.50"),
      },
    ])
  })

  it("returns the journal's failure", async () => {
    const { budgetJournal } = journalAnalytics(() => new Error("basin down"))
    const result = await getUsageDashboard(
      { budgetJournal, customers: fakeCustomers(), now: () => now },
      input({ customerId: "cus_1" })
    )
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toContain("basin down")
  })
})

function input(overrides: Partial<GetUsageDashboardInput> = {}): GetUsageDashboardInput {
  return {
    projectId: "proj_1",
    customerId: "cus_1",
    range: "24h",
    topConsumersLimit: 10,
    ...overrides,
  }
}

function fakeCustomers(customerRows: Array<{ id: string; email: string; name: string }> = []) {
  return { findManyByIds: vi.fn(async () => Ok(customerRows)) }
}
