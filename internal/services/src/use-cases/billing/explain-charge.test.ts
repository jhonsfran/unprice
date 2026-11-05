import type { Database } from "@unprice/db"
import { type RateCard, rateRowSchema } from "@unprice/db/validators"
import { FetchError, Ok } from "@unprice/error"
import { dinero } from "dinero.js"
import * as currencies from "dinero.js/currencies"
import { describe, expect, it, vi } from "vitest"
import { journalAnalytics } from "../../analytics/journal.fixture"
import type { LedgerGateway } from "../../ledger"
import { ExplainChargeError, type ExplainChargeInput, explainCharge } from "./explain-charge"

const now = 1_702_600_000_000

/** A journaled record as the budget exported it: amounts as decimal strings. */
function journalRow(opts: {
  key: string
  at: number
  quantity: string
  amount: string
  periodId?: string
  lines?: number
}) {
  const data = {
    kind: "record",
    id: `o:${opts.key}`,
    idempotencyKey: opts.key,
    usage: { amount: opts.amount, quantities: { tokens: opts.quantity } },
    createdAt: opts.at + 5,
    crossed: [],
    priced: pricedEvent(opts),
  }
  return {
    operation_id: `o:hash_${opts.key}`,
    timestamp: new Date(opts.at + 5).toISOString(),
    data: JSON.stringify(data),
  }
}

/** A settled hold as the budget exported it: its priced event on the state, not on the row. */
function settledHoldRow(opts: { key: string; at: number; quantity: string; amount: string }) {
  const data = {
    kind: "hold",
    id: "h_7",
    idempotencyKey: opts.key,
    reserved: { amount: "10", quantities: {} },
    ttlMs: null,
    createdAt: opts.at,
    expiresAt: opts.at + 60_000,
    state: {
      status: "settled",
      closedAt: opts.at + 30_000,
      actual: { amount: opts.amount, quantities: { tokens: opts.quantity } },
      crossed: [],
      priced: pricedEvent(opts),
    },
  }
  return {
    operation_id: "h_7",
    timestamp: new Date(opts.at + 30_000).toISOString(),
    data: JSON.stringify(data),
  }
}

function pricedEvent(opts: {
  at: number
  quantity: string
  amount: string
  periodId?: string
  lines?: number
}) {
  return {
    slug: "tokens.used",
    properties: { tokens: Number(opts.quantity) },
    at: opts.at,
    features: [
      {
        featureSlug: "tokens",
        periodId: opts.periodId ?? "tokens:bp_1",
        late: false,
        cardId: "card_1",
        rowId: "row_1",
        lines: Array.from({ length: opts.lines ?? 1 }, () => ({
          positionKey: '["tokens","",null]',
          property: null,
          before: "0",
          after: opts.quantity,
          amount: opts.amount,
          cost: null,
        })),
        meterQuantity: opts.quantity,
        amount: opts.amount,
        cost: null,
      },
    ],
  }
}

/** Basin's answer: the page for the events query, `total` for the count query. */
function statementJournal(page: unknown[], total: number | string = page.length) {
  return (sql: string) =>
    sql.endsWith("SELECT COUNT(*) AS events\nFROM statement") ? [{ events: total }] : page
}

const defaultJournal = [
  journalRow({ key: "evt_2", at: 1_700_086_400_000, quantity: "50", amount: "1.75", lines: 2 }),
  journalRow({ key: "evt_1", at: 1_700_000_000_000, quantity: "100", amount: "2.5" }),
]

describe("explainCharge", () => {
  it("explains a metered line from its billed statement and the journal's events", async () => {
    const { db, ledger } = makeDeps({ lineMetadata: { ...usageMetadata(), cost_usd: 120_000_000 } })
    const { analytics, queries } = journalAnalytics(statementJournal(defaultJournal))

    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )

    expect(queries).toHaveLength(2)
    for (const sql of queries) {
      expect(sql).toContain("AND budget_key = 'unprice:customer:cus_1'")
      expect(sql).toContain("AND kind IN ('charge', 'record', 'hold')")
      expect(sql).toContain("json_get_str(features, 0, 'periodId') = 'tokens:bp_1'")
      expect(sql).toContain("AND timestamp >= '2023-11-14T22:13:20.000Z'")
    }
    expect(result.err).toBeUndefined()
    expect(result.val?.scope).toMatchObject({
      featureSlug: "tokens",
      periodKey: "tokens:bp_1",
      customerEntitlementId: "ce_1",
    })
    expect(result.val?.summary).toEqual({
      eventCount: 2,
      totalUsage: 150,
      totalAmount: 425_000_000,
      latestAmountAfter: 425_000_000,
      costUsd: 120_000_000,
      currency: "USD",
      amountScale: 8,
      firstEventAt: 1_700_000_000_000,
      lastEventAt: 1_700_086_400_000,
      multiComponentEventCount: 1,
    })
    expect(result.val?.events[1]).toEqual({
      event_id: "evt_1",
      idempotency_key: "evt_1",
      customer_entitlement_id: "ce_1",
      grant_id: "",
      feature_plan_version_id: "fpv_1",
      feature_slug: "tokens",
      period_key: "tokens:bp_1",
      event_slug: "tokens.used",
      aggregation_method: "sum",
      timestamp: 1_700_000_000_000,
      created_at: 1_700_000_000_005,
      delta: 100,
      value_after: 100,
      amount: 250_000_000,
      amount_after: 250_000_000,
      amount_scale: 8,
      currency: "USD",
      priced_at: 1_700_000_000_000,
      tier_index: null,
      pricing_component_count: 1,
      source_type: "api_key",
      source_id: "o:hash_evt_1",
    })
    expect(result.val?.pagination.hasMore).toBe(false)
    expect(result.val?.answer).toContain("$4.25")
    expect(result.val?.evidence).toContainEqual({ type: "ledger_line", id: "entry_1" })
    expect(result.val?.evidence).toContainEqual({ type: "billing_period", id: "bp_1" })
    expect(result.val?.evidence).toContainEqual({ type: "meter_fact", id: "evt_1" })
  })

  it("sums grouped invoice rows into one line", async () => {
    const groupEntryId = "group:bp_1:si_1:subscription:provider:due:collectable"
    const metadata = { ...usageMetadata(), subscription_item_id: "si_1" }
    const { db, ledger } = makeDeps({
      lines: [
        line({
          entryId: "entry_1",
          quantity: 100,
          amount: dinero({ amount: 250_000_000, currency: currencies.USD, scale: 8 }),
          metadata,
        }),
        line({
          entryId: "entry_2",
          quantity: 50,
          amount: dinero({ amount: 175_000_000, currency: currencies.USD, scale: 8 }),
          metadata,
        }),
      ],
    })
    const { analytics } = journalAnalytics(statementJournal(defaultJournal))

    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input({ entryId: groupEntryId })
    )

    expect(result.val?.line.amount).toBe(425_000_000)
    expect(result.val?.summary.totalUsage).toBe(150)
    expect(result.val?.evidence).toContainEqual({ type: "ledger_line", id: "entry_2" })
  })

  it("skips journal rows that do not carry the statement's feature", async () => {
    const { db, ledger } = makeDeps()
    const { analytics } = journalAnalytics(
      statementJournal([
        journalRow({
          key: "evt_x",
          at: 1,
          quantity: "1",
          amount: "1",
          periodId: "tokens:bp_other",
        }),
      ])
    )
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.val?.events).toEqual([])
  })

  it("explains a settled hold from the priced event on its state", async () => {
    const { db, ledger } = makeDeps()
    const { analytics } = journalAnalytics(
      statementJournal([
        settledHoldRow({ key: "run_1", at: 1_700_050_000_000, quantity: "40", amount: "0.4" }),
      ])
    )
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.val?.summary.eventCount).toBe(1)
    expect(result.val?.events).toEqual([
      {
        event_id: "run_1",
        idempotency_key: "run_1",
        customer_entitlement_id: "ce_1",
        grant_id: "",
        feature_plan_version_id: "fpv_1",
        feature_slug: "tokens",
        period_key: "tokens:bp_1",
        event_slug: "tokens.used",
        aggregation_method: "sum",
        timestamp: 1_700_050_000_000,
        created_at: 1_700_050_000_000,
        delta: 40,
        value_after: 40,
        amount: 40_000_000,
        amount_after: 40_000_000,
        amount_scale: 8,
        currency: "USD",
        priced_at: 1_700_050_000_000,
        tier_index: null,
        pricing_component_count: 1,
        source_type: "api_key",
        source_id: "h_7",
      },
    ])
  })

  it("skips a journal row whose data is not valid JSON", async () => {
    const { db, ledger } = makeDeps()
    const [good] = defaultJournal
    const { analytics } = journalAnalytics(
      statementJournal(
        [{ operation_id: "o:broken", timestamp: good?.timestamp, data: "{not json" }, good],
        2
      )
    )
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.err).toBeUndefined()
    expect(result.val?.events.map((event) => event.event_id)).toEqual(["evt_2"])
  })

  it("reports more pages from the journal's count", async () => {
    const { db, ledger } = makeDeps()
    const { analytics } = journalAnalytics(statementJournal(defaultJournal, "3"))
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input({ limit: 2 })
    )
    expect(result.val?.summary.eventCount).toBe(3)
    expect(result.val?.pagination.hasMore).toBe(true)
  })

  it("keeps the count on a page past the last event", async () => {
    const { db, ledger } = makeDeps()
    const { analytics, queries } = journalAnalytics(statementJournal([], 3))
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input({ limit: 2, offset: 4 })
    )
    expect(queries[0]).toContain("LIMIT 2\nOFFSET 4")
    expect(result.val?.events).toEqual([])
    expect(result.val?.summary.eventCount).toBe(3)
    expect(result.val?.pagination).toEqual({ limit: 2, offset: 4, hasMore: false })
  })

  it("summarizes the feature's price from the plan version's rate card", async () => {
    const { db, ledger } = makeDeps()
    const { analytics } = journalAnalytics(statementJournal(defaultJournal))
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.val?.pricing).toEqual({
      featureType: "usage",
      usageMode: "unit",
      unitOfMeasure: "token",
      description: "Rate card price: $0.01 / token",
      rows: [{ label: "Default (from 1970-01-01T00:00:00.000Z)", value: "$0.01 / token" }],
    })
  })

  it("explains a non-metered line without reading the journal", async () => {
    const { db, ledger } = makeDeps({
      billingPeriod: billingPeriod({
        featurePlanVersion: {
          id: "fpv_flat",
          featureType: "flat",
          unitOfMeasure: "seats",
          planVersionId: "pv_1",
          config: {},
          resetConfig: null,
          feature: { slug: "seats" },
        },
      }),
      lines: [line({ quantity: 3 })],
    })
    const { analytics, queries } = journalAnalytics(() => [])

    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )

    expect(queries).toEqual([])
    expect(result.val?.scope.periodKey).toBe("billing_period:bp_1")
    expect(result.val?.summary).toMatchObject({ eventCount: 0, totalUsage: 3, costUsd: null })
    expect(result.val?.answer).toContain("no rated meter facts are expected")
  })

  it("returns the journal's failure", async () => {
    const { db, ledger } = makeDeps()
    const { analytics } = journalAnalytics(() => new Error("basin down"))
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.err).toBeInstanceOf(FetchError)
  })

  it.each([
    [{ invoice: null }, "INVOICE_NOT_FOUND"],
    [{ lines: [] }, "LEDGER_LINE_NOT_FOUND"],
    [{ lineMetadata: { kind: "subscription" } }, "BILLING_PERIOD_METADATA_MISSING"],
    [{ billingPeriod: null }, "BILLING_PERIOD_NOT_FOUND"],
    [
      { billingPeriod: billingPeriod({ invoiceId: "inv_other" }) },
      "BILLING_PERIOD_CONTEXT_MISMATCH",
    ],
  ] as const)("returns %o as %s before reading the journal", async (overrides, code) => {
    const { db, ledger } = makeDeps(overrides)
    const { analytics, queries } = journalAnalytics(() => [])
    const result = await explainCharge(
      { db, ledger, analytics, rateCards, now: () => now },
      input()
    )
    expect(result.err).toBeInstanceOf(ExplainChargeError)
    expect(result.err).toMatchObject({ code })
    expect(queries).toEqual([])
  })
})

function input(overrides: Partial<ExplainChargeInput> = {}): ExplainChargeInput {
  return {
    projectId: "proj_1",
    invoiceId: "inv_1",
    entryId: "entry_1",
    limit: 100,
    offset: 0,
    ...overrides,
  }
}

function usageMetadata() {
  return { kind: "subscription", billing_period_id: "bp_1" }
}

function makeDeps(
  overrides: {
    invoice?: ReturnType<typeof invoice> | null
    billingPeriod?: ReturnType<typeof billingPeriod> | null
    lineMetadata?: Record<string, unknown>
    lines?: ReadonlyArray<ReturnType<typeof line>>
  } = {}
) {
  const db = {
    query: {
      invoices: {
        findFirst: vi
          .fn()
          .mockResolvedValue(overrides.invoice === undefined ? invoice() : overrides.invoice),
      },
      billingPeriods: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            overrides.billingPeriod === undefined ? billingPeriod() : overrides.billingPeriod
          ),
      },
      customerEntitlements: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "ce_1", effectiveAt: 1_700_000_000_000, expiresAt: 1_702_592_000_000 },
          ]),
      },
    },
  } as unknown as Database
  const ledger = {
    getInvoiceLines: vi
      .fn()
      .mockResolvedValue(
        Ok(overrides.lines ?? [line({ metadata: overrides.lineMetadata ?? usageMetadata() })])
      ),
  } as unknown as LedgerGateway
  return { db, ledger }
}

function invoice() {
  return { id: "inv_1", statementKey: "stmt_1", customerId: "cus_1", currency: "USD" }
}

function billingPeriod(
  overrides: Partial<{
    invoiceId: string
    featurePlanVersion: {
      id: string
      featureType: string
      unitOfMeasure: string
      planVersionId: string
      config: { usageMode?: string }
      resetConfig: null
      feature: { slug: string }
    }
  }> = {}
) {
  return {
    id: "bp_1",
    projectId: "proj_1",
    customerId: "cus_1",
    invoiceId: overrides.invoiceId ?? "inv_1",
    statementKey: "stmt_1",
    subscriptionItemId: "si_1",
    cycleStartAt: 1_700_000_000_000,
    cycleEndAt: 1_702_592_000_000,
    invoiceAt: 1_702_592_000_000,
    type: "normal" as const,
    subscriptionItem: {
      units: null,
      featurePlanVersion: overrides.featurePlanVersion ?? {
        id: "fpv_1",
        featureType: "usage",
        unitOfMeasure: "tokens",
        planVersionId: "pv_1",
        config: { usageMode: "unit" },
        resetConfig: null,
        feature: { slug: "tokens" },
      },
    },
  }
}

/** The plan version's USD card: tokens at $0.01 each, seats at a flat $2. */
const rateCards = {
  pricingForPlanVersions: vi.fn(async () => {
    const row = (featureSlug: string, price: unknown) =>
      rateRowSchema.parse({
        id: `rr_${featureSlug}`,
        rateCardId: "rc_1",
        featureSlug,
        match: {},
        price,
        cost: null,
        effectiveFrom: 0,
        effectiveTo: null,
        source: "manual",
        sourceRef: null,
      })
    return new Map([
      [
        "pv_1",
        [
          {
            currency: "USD" as const,
            card: {} as RateCard,
            rows: [
              row("tokens", {
                type: "unit",
                components: [{ property: null, rate: "0.01", per: 1 }],
              }),
              row("seats", { type: "flat", amount: "2" }),
            ],
          },
        ],
      ],
    ])
  }),
}

function line(
  overrides: Partial<{
    entryId: string
    quantity: number
    amount: ReturnType<typeof dinero>
    metadata: Record<string, unknown>
  }> = {}
) {
  return {
    entryId: "entry_1",
    statementKey: "stmt_1",
    kind: "subscription",
    description: "Tokens",
    quantity: 150,
    amount: dinero({ amount: 425_000_000, currency: currencies.USD, scale: 8 }),
    amountDue: 425_000_000,
    amountIncluded: 0,
    amountPaid: 0,
    collectable: true,
    settlementSource: "provider" as const,
    settlementStatus: "due" as const,
    walletCreditId: null,
    walletCreditSource: null,
    walletId: null,
    currency: "USD",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: usageMetadata(),
    ...overrides,
  }
}
