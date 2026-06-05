import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok } from "@unprice/error"
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

  it("fails when the ledger line does not carry billing period metadata", async () => {
    const { db, ledger, analytics } = makeDeps({
      lineMetadata: { kind: "subscription" },
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

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(ExplainChargeError)
    expect(result.err).toMatchObject({ code: "BILLING_PERIOD_METADATA_MISSING" })
    expect(analytics.getExplainChargeSummary).not.toHaveBeenCalled()
  })
})

function makeDeps(
  overrides: {
    lineMetadata?: Record<string, unknown>
  } = {}
) {
  const invoice = {
    id: "inv_1",
    statementKey: "stmt_1",
    customerId: "cus_1",
    currency: "USD",
  }
  const billingPeriod = {
    id: "bp_1",
    projectId: "proj_1",
    customerId: "cus_1",
    subscriptionItemId: "si_1",
    cycleStartAt: 1_700_000_000_000,
    cycleEndAt: 1_702_592_000_000,
    subscriptionItem: {
      featurePlanVersion: {
        id: "fpv_1",
        resetConfig: null,
        feature: {
          slug: "tokens",
        },
      },
    },
  }
  const customerEntitlement = {
    id: "ce_1",
    effectiveAt: 1_700_000_000_000,
    expiresAt: 1_702_592_000_000,
  }
  const db = {
    query: {
      invoices: {
        findFirst: vi.fn().mockResolvedValue(invoice),
      },
      billingPeriods: {
        findFirst: vi.fn().mockResolvedValue(billingPeriod),
      },
      customerEntitlements: {
        findFirst: vi.fn().mockResolvedValue(customerEntitlement),
      },
    },
  } as unknown as Database
  const ledger = {
    getInvoiceLines: vi.fn().mockResolvedValue(
      Ok([
        {
          entryId: "entry_1",
          statementKey: "stmt_1",
          kind: "subscription",
          description: "Tokens",
          quantity: 150,
          amount: dinero({ amount: 425_000_000, currency: currencies.USD, scale: 8 }),
          currency: "USD",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: overrides.lineMetadata ?? {
            kind: "subscription",
            billing_period_id: "bp_1",
          },
        },
      ])
    ),
  } as unknown as LedgerGateway
  const analytics = {
    getExplainChargeSummary: vi.fn().mockResolvedValue({
      data: [
        {
          project_id: "proj_1",
          customer_id: "cus_1",
          feature_slug: "tokens",
          period_key: "onetime:1700000000000",
          currency: "USD",
          amount_scale: 8,
          event_count: 2,
          total_delta: 150,
          total_amount: 425_000_000,
          latest_amount_after: 425_000_000,
          first_event_at: 1_700_000_000_000,
          last_event_at: 1_700_086_400_000,
          multi_component_event_count: 1,
        },
      ],
    }),
    getExplainChargeEvents: vi.fn().mockResolvedValue({
      data: [
        makeEvent({ event_id: "evt_1", delta: 100, amount: 250_000_000 }),
        makeEvent({ event_id: "evt_2", delta: 50, amount: 175_000_000, amount_after: 425_000_000 }),
      ],
    }),
  } as unknown as Analytics

  return { db, ledger, analytics }
}

function makeEvent(overrides: Partial<ReturnType<typeof baseEvent>> = {}) {
  return {
    ...baseEvent(),
    ...overrides,
  }
}

function baseEvent() {
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
