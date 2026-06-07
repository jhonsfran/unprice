import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { FetchError, Ok } from "@unprice/error"
import { dinero } from "dinero.js"
import * as currencies from "dinero.js/currencies"
import { describe, expect, it, vi } from "vitest"
import type { LedgerGateway } from "../../ledger"
import { ExplainChargeError, explainCharge } from "./explain-charge"

describe("explainCharge", () => {
  it("explains an invoice line from ledger metadata and rated meter facts", async () => {
    const { db, ledger, analytics } = makeDeps()

    const result = await explainCharge(
      { db, ledger, analytics },
      {
        projectId: "proj_1",
        invoiceId: "inv_1",
        entryId: "entry_1",
        limit: 100,
        offset: 0,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.line.billingPeriodId).toBe("bp_1")
    expect(result.val?.scope.featureSlug).toBe("tokens")
    expect(result.val?.scope.customerEntitlementId).toBe("ce_1")
    expect(result.val?.summary.eventCount).toBe(2)
    expect(result.val?.events).toHaveLength(2)
    expect(result.val?.pagination.hasMore).toBe(false)
    expect(result.val?.answer).toContain("$4.25")
    expect(result.val?.answer).not.toContain("425000000")
    expect(result.val?.answer).not.toContain("entry_1")
    expect(result.val?.answer).not.toContain("inv_1")
    expect(result.val?.answer).not.toContain("onetime:")
    expect(result.val?.pricing).toMatchObject({
      featureType: "usage",
      usageMode: "unit",
      description: "Unit pricing: 0.01 USD per token",
      rows: [{ label: "Unit price", value: "0.01 USD / token" }],
    })
    expect(result.val?.evidence).toContainEqual({ type: "ledger_line", id: "entry_1" })
    expect(result.val?.evidence).toContainEqual({ type: "billing_period", id: "bp_1" })
    expect(result.val?.evidence).toContainEqual({ type: "meter_fact", id: "evt_1" })

    expect(analytics.getExplainChargeSummary).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "tokens",
      period_key: "onetime:1700000000000",
      customer_entitlement_id: "ce_1",
    })
    expect(analytics.getExplainChargeEvents).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "tokens",
      period_key: "onetime:1700000000000",
      customer_entitlement_id: "ce_1",
      limit: 100,
      offset: 0,
    })
  })

  it("explains grouped invoice statement rows", async () => {
    const groupEntryId = "group:bp_1:si_1:subscription:provider:due:collectable"
    const { db, ledger, analytics } = makeDeps({
      summaryRows: [summaryRow({ event_count: 2, total_delta: 999, total_amount: 999 })],
      lines: [
        line({
          entryId: "entry_1",
          quantity: 100,
          amount: dinero({ amount: 250_000_000, currency: currencies.USD, scale: 8 }),
          metadata: {
            kind: "subscription",
            billing_period_id: "bp_1",
            subscription_item_id: "si_1",
          },
        }),
        line({
          entryId: "entry_2",
          quantity: 50,
          amount: dinero({ amount: 175_000_000, currency: currencies.USD, scale: 8 }),
          metadata: {
            kind: "subscription",
            billing_period_id: "bp_1",
            subscription_item_id: "si_1",
          },
        }),
      ],
    })

    const result = await explainCharge(
      { db, ledger, analytics },
      {
        projectId: "proj_1",
        invoiceId: "inv_1",
        entryId: groupEntryId,
        limit: 100,
        offset: 0,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.line.entryId).toBe(groupEntryId)
    expect(result.val?.line.amount).toBe(425_000_000)
    expect(result.val?.summary.totalAmount).toBe(425_000_000)
    expect(result.val?.summary.totalUsage).toBe(150)
    expect(result.val?.answer).toContain("$4.25")
    expect(result.val?.evidence).toContainEqual({ type: "ledger_line", id: "entry_1" })
    expect(result.val?.evidence).toContainEqual({ type: "ledger_line", id: "entry_2" })
    expect(analytics.getExplainChargeSummary).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "tokens",
      period_key: "onetime:1700000000000",
      customer_entitlement_id: "ce_1",
    })
  })

  it("uses the billing window for rated facts when a usage period key cannot be derived", async () => {
    const { db, ledger, analytics } = makeDeps({
      entitlements: [entitlement({ effectiveAt: 1, expiresAt: 2 })],
      lines: [
        line({
          quantity: 517,
          amount: dinero({ amount: 517_000_000, currency: currencies.USD, scale: 8 }),
        }),
      ],
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toBeUndefined()
    expect(result.val?.scope.periodKey).toBe("billing_period:bp_1")
    expect(result.val?.summary).toMatchObject({
      eventCount: 2,
      totalUsage: 517,
      totalAmount: 517_000_000,
      latestAmountAfter: 517_000_000,
    })
    expect(result.val?.events).toHaveLength(2)
    expect(result.val?.answer).toContain("$5.17")
    expect(analytics.getExplainChargeSummary).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "tokens",
      start: 1_700_000_000_000,
      end: 1_702_592_000_000,
      customer_entitlement_id: "ce_1",
    })
    expect(analytics.getExplainChargeEvents).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "tokens",
      start: 1_700_000_000_000,
      end: 1_702_592_000_000,
      customer_entitlement_id: "ce_1",
      limit: 100,
      offset: 0,
    })
  })

  it("uses the persisted usage reset cadence to query rated fact period keys", async () => {
    const cycleStartAt = Date.UTC(2026, 5, 7, 22, 15, 25)
    const cycleEndAt = Date.UTC(2026, 5, 7, 22, 20, 25)
    const entitlementEffectiveAt = Date.UTC(2026, 5, 7, 22, 14, 25, 128)
    const { db, ledger, analytics } = makeDeps({
      billingPeriod: billingPeriod({
        cycleStartAt,
        cycleEndAt,
        subscriptionItem: {
          featurePlanVersion: {
            id: "fpv_1",
            featureType: "usage",
            unitOfMeasure: "events",
            config: {
              usageMode: "unit",
              price: configuredPrice("0.001"),
            },
            billingConfig: {
              name: "every-5-minutes",
              billingInterval: "minute",
              billingIntervalCount: 5,
              billingAnchor: "dayOfCreation",
              planType: "recurring",
            },
            resetConfig: {
              name: "every-5-minutes",
              resetInterval: "minute",
              resetIntervalCount: 5,
              resetAnchor: "dayOfCreation",
              planType: "recurring",
            },
            feature: {
              slug: "events",
            },
          },
        },
      }),
      entitlements: [
        entitlement({
          effectiveAt: entitlementEffectiveAt,
          expiresAt: cycleEndAt,
        }),
      ],
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toBeUndefined()
    expect(result.val?.scope.periodKey).toBe(`minute:${cycleStartAt}`)
    expect(analytics.getExplainChargeSummary).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "events",
      period_key: `minute:${cycleStartAt}`,
      customer_entitlement_id: "ce_1",
    })
    expect(analytics.getExplainChargeEvents).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      feature_slug: "events",
      period_key: `minute:${cycleStartAt}`,
      customer_entitlement_id: "ce_1",
      limit: 100,
      offset: 0,
    })
  })

  it("does not filter Tinybird to one entitlement when multiple entitlements are in scope", async () => {
    const { db, ledger, analytics } = makeDeps({
      entitlements: [entitlement({ id: "ce_1" }), entitlement({ id: "ce_2" })],
      summaryRows: [summaryRow({ event_count: 2, total_delta: 150, total_amount: 425_000_000 })],
      eventRows: [
        eventRow({ event_id: "evt_1", customer_entitlement_id: "ce_1", amount: 250_000_000 }),
        eventRow({
          event_id: "evt_2",
          customer_entitlement_id: "ce_2",
          delta: 50,
          amount: 175_000_000,
          amount_after: 425_000_000,
        }),
      ],
    })

    const result = await explainCharge(
      { db, ledger, analytics },
      {
        projectId: "proj_1",
        invoiceId: "inv_1",
        entryId: "entry_1",
        limit: 100,
        offset: 0,
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val?.scope.customerEntitlementId).toBeNull()
    expect(result.val?.summary.totalAmount).toBe(425_000_000)
    expect(result.val?.events.map((event) => event.customer_entitlement_id)).toEqual([
      "ce_1",
      "ce_2",
    ])
    expect(result.val?.evidence).toContainEqual({ type: "meter_fact", id: "evt_2" })
    expect(analytics.getExplainChargeSummary).toHaveBeenCalledWith(
      expect.not.objectContaining({ customer_entitlement_id: expect.any(String) })
    )
    expect(analytics.getExplainChargeEvents).toHaveBeenCalledWith(
      expect.not.objectContaining({ customer_entitlement_id: expect.any(String) })
    )
  })

  it("explains non-usage invoice lines without deriving a usage period key", async () => {
    const { db, ledger, analytics } = makeDeps({
      billingPeriod: billingPeriod({
        subscriptionItem: {
          featurePlanVersion: {
            id: "fpv_flat",
            featureType: "flat",
            unitOfMeasure: "seats",
            config: {
              price: configuredPrice("2.00"),
            },
            billingConfig: billingConfig(),
            resetConfig: null,
            feature: {
              slug: "seats",
            },
          },
        },
      }),
      lines: [
        line({
          description: "Seats",
          quantity: 3,
          metadata: {
            kind: "subscription",
            billing_period_id: "bp_1",
          },
        }),
      ],
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toBeUndefined()
    expect(result.val?.scope.featureSlug).toBe("seats")
    expect(result.val?.scope.periodKey).toBe("billing_period:bp_1")
    expect(result.val?.summary).toMatchObject({
      eventCount: 0,
      totalUsage: 3,
      totalAmount: 425_000_000,
      latestAmountAfter: 425_000_000,
    })
    expect(result.val?.events).toEqual([])
    expect(result.val?.answer).toContain("$4.25")
    expect(result.val?.answer).not.toContain("425000000")
    expect(result.val?.answer).toContain("no rated meter facts are expected")
    expect(result.val?.pricing).toMatchObject({
      featureType: "flat",
      description: "Fixed price: 2.00 USD",
    })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
    expect(analytics.getExplainChargeEvents).not.toHaveBeenCalled()
  })

  it("returns missing invoice as an expected error", async () => {
    const { db, ledger, analytics } = makeDeps({ invoice: null })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toMatchObject({ code: "INVOICE_NOT_FOUND" })
    expect(ledger.getInvoiceLines).not.toHaveBeenCalled()
  })

  it("returns missing line as an expected error", async () => {
    const { db, ledger, analytics } = makeDeps({ lines: [] })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toMatchObject({ code: "LEDGER_LINE_NOT_FOUND" })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
  })

  it("fails when the ledger line does not carry billing period metadata", async () => {
    const { db, ledger, analytics } = makeDeps({
      lineMetadata: { kind: "subscription" },
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(ExplainChargeError)
    expect(result.err).toMatchObject({ code: "BILLING_PERIOD_METADATA_MISSING" })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
  })

  it("returns missing billing period as an expected error", async () => {
    const { db, ledger, analytics } = makeDeps({ billingPeriod: null })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toMatchObject({ code: "BILLING_PERIOD_NOT_FOUND" })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
  })

  it("rejects a billing period that does not belong to the invoice context", async () => {
    const { db, ledger, analytics } = makeDeps({
      billingPeriod: billingPeriod({ invoiceId: "inv_other" }),
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toMatchObject({ code: "BILLING_PERIOD_CONTEXT_MISMATCH" })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
  })

  it("returns Tinybird failures as fetch errors", async () => {
    const { db, ledger, analytics } = makeDeps({
      summaryError: new Error("tinybird unavailable"),
    })

    const result = await callDefault({ db, ledger, analytics })

    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })

  it("computes hasMore from the summary count instead of exact page size", async () => {
    const { db, ledger, analytics } = makeDeps({
      summaryRows: [summaryRow({ event_count: 2 })],
      eventRows: [eventRow({ event_id: "evt_1" }), eventRow({ event_id: "evt_2" })],
    })

    const exactPage = await explainCharge(
      { db, ledger, analytics },
      {
        projectId: "proj_1",
        invoiceId: "inv_1",
        entryId: "entry_1",
        limit: 2,
        offset: 0,
      }
    )

    expect(exactPage.val?.pagination.hasMore).toBe(false)

    const withMore = makeDeps({
      summaryRows: [summaryRow({ event_count: 3 })],
      eventRows: [eventRow({ event_id: "evt_1" }), eventRow({ event_id: "evt_2" })],
    })
    const nonFinalPage = await explainCharge(withMore, {
      projectId: "proj_1",
      invoiceId: "inv_1",
      entryId: "entry_1",
      limit: 2,
      offset: 0,
    })

    expect(nonFinalPage.val?.pagination.hasMore).toBe(true)
  })
})

async function callDefault({
  db,
  ledger,
  analytics,
}: {
  db: Database
  ledger: LedgerGateway
  analytics: Analytics
}) {
  return explainCharge(
    { db, ledger, analytics },
    {
      projectId: "proj_1",
      invoiceId: "inv_1",
      entryId: "entry_1",
      limit: 100,
      offset: 0,
    }
  )
}

function makeDeps(
  overrides: {
    invoice?: ReturnType<typeof invoice> | null
    billingPeriod?: ReturnType<typeof billingPeriod> | null
    entitlements?: ReturnType<typeof entitlement>[]
    lineMetadata?: Record<string, unknown>
    lines?: Array<ReturnType<typeof line>>
    summaryRows?: Array<ReturnType<typeof summaryRow>>
    eventRows?: Array<ReturnType<typeof eventRow>>
    summaryError?: Error
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
        findMany: vi.fn().mockResolvedValue(overrides.entitlements ?? [entitlement()]),
      },
    },
  } as unknown as Database
  const ledger = {
    getInvoiceLines: vi.fn().mockResolvedValue(
      Ok(
        overrides.lines ?? [
          line({
            metadata: overrides.lineMetadata ?? {
              kind: "subscription",
              billing_period_id: "bp_1",
            },
          }),
        ]
      )
    ),
  } as unknown as LedgerGateway
  const analytics = {
    getExplainChargeSummary: vi.fn().mockImplementation(() => {
      if (overrides.summaryError) {
        return Promise.reject(overrides.summaryError)
      }
      return Promise.resolve({
        data: overrides.summaryRows ?? [summaryRow()],
      })
    }),
    getExplainChargeEvents: vi.fn().mockResolvedValue({
      data: overrides.eventRows ?? [
        eventRow({ event_id: "evt_1", delta: 100, amount: 250_000_000 }),
        eventRow({ event_id: "evt_2", delta: 50, amount: 175_000_000, amount_after: 425_000_000 }),
      ],
    }),
  } as unknown as Analytics

  return { db, ledger, analytics }
}

function invoice(
  overrides: Partial<{
    id: string
    statementKey: string
    customerId: string
    currency: string
  }> = {}
) {
  return {
    id: "inv_1",
    statementKey: "stmt_1",
    customerId: "cus_1",
    currency: "USD",
    ...overrides,
  }
}

function billingPeriod(
  overrides: Partial<{
    id: string
    projectId: string
    customerId: string
    invoiceId: string
    statementKey: string
    subscriptionItemId: string
    cycleStartAt: number
    cycleEndAt: number
    subscriptionItem: {
      featurePlanVersion: {
        id: string
        featureType: string
        unitOfMeasure: string
        config: unknown
        billingConfig: ReturnType<typeof billingConfig>
        resetConfig: null | {
          name: string
          resetInterval: string
          resetIntervalCount: number
          resetAnchor: string
          planType: string
        }
        feature: {
          slug: string
        }
      }
    }
  }> = {}
) {
  return {
    id: "bp_1",
    projectId: "proj_1",
    customerId: "cus_1",
    invoiceId: "inv_1",
    statementKey: "stmt_1",
    subscriptionItemId: "si_1",
    cycleStartAt: 1_700_000_000_000,
    cycleEndAt: 1_702_592_000_000,
    subscriptionItem: {
      featurePlanVersion: {
        id: "fpv_1",
        featureType: "usage",
        unitOfMeasure: "tokens",
        config: {
          usageMode: "unit",
          price: configuredPrice("0.01"),
        },
        billingConfig: billingConfig(),
        resetConfig: null,
        feature: {
          slug: "tokens",
        },
      },
    },
    ...overrides,
  }
}

function billingConfig() {
  return {
    name: "one-time",
    billingInterval: "onetime",
    billingIntervalCount: 1,
    billingAnchor: "dayOfCreation",
    planType: "onetime",
  }
}

function entitlement(
  overrides: Partial<{
    id: string
    effectiveAt: number
    expiresAt: number
  }> = {}
) {
  return {
    id: "ce_1",
    effectiveAt: 1_700_000_000_000,
    expiresAt: 1_702_592_000_000,
    ...overrides,
  }
}

function configuredPrice(displayAmount: string, currency = currencies.USD) {
  const scale = displayAmount.split(".")[1]?.length ?? currency.exponent
  return {
    displayAmount,
    dinero: dinero({
      amount: Math.round(Number(displayAmount) * 10 ** scale),
      currency,
      scale,
    }).toJSON(),
  }
}

function line(
  overrides: Partial<{
    entryId: string
    statementKey: string
    kind: string
    description: string
    quantity: number
    amount: ReturnType<typeof dinero>
    amountDue: number
    amountIncluded: number
    amountPaid: number
    collectable: boolean
    settlementSource: "provider" | "wallet" | "trial"
    settlementStatus: "due" | "paid" | "included"
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
    metadata: {
      kind: "subscription",
      billing_period_id: "bp_1",
    },
    ...overrides,
  }
}

function summaryRow(overrides: Partial<ReturnType<typeof baseSummaryRow>> = {}) {
  return {
    ...baseSummaryRow(),
    ...overrides,
  }
}

function baseSummaryRow() {
  return {
    project_id: "proj_1",
    customer_id: "cus_1",
    feature_slug: "tokens",
    period_key: "onetime:1700000000000",
    currency: "USD",
    amount_scale: 8 as const,
    event_count: 2,
    total_delta: 150,
    total_amount: 425_000_000,
    latest_amount_after: 425_000_000,
    first_event_at: 1_700_000_000_000,
    last_event_at: 1_700_086_400_000,
    multi_component_event_count: 1,
  }
}

function eventRow(overrides: Partial<ReturnType<typeof baseEventRow>> = {}) {
  return {
    ...baseEventRow(),
    ...overrides,
  }
}

function baseEventRow() {
  return {
    event_id: "evt_1",
    idempotency_key: "idem_1",
    customer_entitlement_id: "ce_1",
    grant_id: "grant_1",
    feature_plan_version_id: "fpv_1",
    feature_slug: "tokens",
    period_key: "onetime:1700000000000",
    event_slug: "tokens.used",
    aggregation_method: "sum",
    timestamp: 1_700_000_000_000,
    created_at: 1_700_000_000_100,
    delta: 100,
    value_after: 100,
    amount: 250_000_000,
    amount_after: 250_000_000,
    amount_scale: 8 as const,
    currency: "USD",
    priced_at: 1_700_000_000_100,
    tier_index: 0,
    tier_mode: "graduated" as const,
    pricing_component_count: 1,
    source_type: "api_key" as const,
    source_id: "key_1",
  }
}
