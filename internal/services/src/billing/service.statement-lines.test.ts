import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import { UnPriceLedgerError } from "../ledger/errors"
import type { Metrics } from "../metrics"
import type { RatingService } from "../rating/service"
import type { SubscriptionMachine } from "../subscriptions/machine"
import type { WalletService } from "../wallet"
import { BillingService } from "./service"

const machineMocks = vi.hoisted(() => ({
  reportInvoiceSuccess: vi.fn(),
  reportPaymentFailure: vi.fn(),
}))

vi.mock("../subscriptions/withLockedMachine", () => ({
  withLockedMachine: vi.fn(async (args: { run: (m: SubscriptionMachine) => Promise<unknown> }) => {
    return args.run(machineMocks as unknown as SubscriptionMachine)
  }),
}))

vi.mock("./repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => ({})),
}))

const usd = dineroCurrencies.USD

const ledgerMock = vi.hoisted(() => ({
  getInvoiceLines: vi.fn(),
}))

function makeLogger() {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

function makeDbWithPeriods(periods: unknown[] = []) {
  return {
    query: {
      billingPeriods: {
        findMany: vi.fn().mockResolvedValue(periods),
      },
    },
  } as unknown as Database
}

function makeBillingService(db: Database) {
  return new BillingService({
    db,
    logger: makeLogger(),
    analytics: {} as Analytics,
    waitUntil: (p) => p,
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService: {} as CustomerService,
    grantsManager: {} as GrantsManager,
    ratingService: {} as RatingService,
    ledgerService: ledgerMock as unknown as LedgerGateway,
    walletService: {} as WalletService,
  })
}

function makeLedgerLine(overrides: Record<string, unknown> = {}) {
  return {
    entryId: "ple_1",
    statementKey: "stmt_2026_04",
    kind: "subscription",
    description: "API Calls",
    quantity: 10,
    amount: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }),
    amountDue: 1000_0000_00,
    amountIncluded: 0,
    amountPaid: 0,
    collectable: true,
    settlementSource: "provider",
    settlementStatus: "due",
    walletCreditId: null,
    walletCreditSource: null,
    walletId: null,
    currency: "USD",
    createdAt: new Date("2026-04-01T00:00:00Z"),
    metadata: {
      billing_period_id: "bp_1",
      subscription_id: "sub_1",
    },
    ...overrides,
  }
}

function makePeriodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp_1",
    statementKey: "stmt_2026_04",
    type: "normal",
    invoiceAt: 1_700_000_000_000,
    cycleStartAt: 1_700_000_000_000,
    subscriptionItem: {
      id: "item_1",
      units: 10,
      featurePlanVersion: {
        featureType: "flat",
        feature: { title: "API Calls", slug: "api-calls" },
      },
    },
    ...overrides,
  }
}

describe("BillingService.getInvoiceStatementLines", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("happy path: projects ledger lines into statement line format", async () => {
    const db = makeDbWithPeriods([makePeriodRow()])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(Ok([makeLedgerLine()]))

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    const lines = result.val!
    // The ledger line should be projected
    expect(lines.length).toBe(1)
    expect(lines[0]!.entryId).toBe("ple_1")
    expect(lines[0]!.kind).toBe("subscription")
    expect(lines[0]!.description).toBe("API Calls")
    expect(lines[0]!.quantity).toBe(10)
    // Amount should be converted via toLedgerMinor
    expect(typeof lines[0]!.amount).toBe("number")
    expect(lines[0]!.amount).toBeGreaterThan(0)
  })

  it("groups repeated ledger capture lines by billing period and item", async () => {
    const db = makeDbWithPeriods([makePeriodRow()])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([
        makeLedgerLine({
          entryId: "ple_1",
          amount: dinero({ amount: 400_0000_00, currency: usd, scale: 8 }),
          amountDue: 400_0000_00,
          metadata: {
            billing_period_id: "bp_1",
            feature_plan_version_item_id: "item_1",
          },
        }),
        makeLedgerLine({
          entryId: "ple_2",
          amount: dinero({ amount: 600_0000_00, currency: usd, scale: 8 }),
          amountDue: 600_0000_00,
          createdAt: new Date("2026-04-01T00:01:00Z"),
          metadata: {
            billing_period_id: "bp_1",
            feature_plan_version_item_id: "item_1",
          },
        }),
      ])
    )

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toHaveLength(1)
    expect(result.val?.[0]).toMatchObject({
      amount: 1000_0000_00,
      amountDue: 1000_0000_00,
      entryId: "group:bp_1:item_1:subscription:provider:due:collectable",
    })
  })

  it("uses the ledger-projected feature slug as the description", async () => {
    const db = makeDbWithPeriods([
      makePeriodRow({
        id: "bp_usage",
        subscriptionItem: {
          id: "item_usage",
          units: null,
          featurePlanVersion: {
            featureType: "usage",
            feature: { title: "Events", slug: "events" },
          },
        },
      }),
    ])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([
        makeLedgerLine({
          description: "events",
          kind: "usage",
          quantity: 12,
          metadata: {
            billing_period_id: "bp_usage",
            feature_plan_version_item_id: "item_usage",
            feature_slug: "events",
            flow: "capture",
          },
        }),
      ])
    )

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    expect(result.val?.[0]).toMatchObject({
      description: "events",
      quantity: 12,
    })
  })

  it("synthesizes zero-amount lines for periods without ledger entries", async () => {
    // Period bp_2 has no ledger entry — should get a zero line
    const db = makeDbWithPeriods([
      makePeriodRow({ id: "bp_1" }),
      makePeriodRow({
        id: "bp_2",
        subscriptionItem: {
          id: "item_2",
          units: 5,
          featurePlanVersion: {
            featureType: "flat",
            feature: { title: "Storage", slug: "storage" },
          },
        },
      }),
    ])
    const billing = makeBillingService(db)

    // Only bp_1 has ledger lines
    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([makeLedgerLine({ metadata: { billing_period_id: "bp_1" } })])
    )

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    const lines = result.val!
    // 1 projected ledger line + 1 zero line for bp_2
    expect(lines.length).toBe(2)

    const zeroLine = lines.find((l) => l.entryId === "billing-period:bp_2")
    expect(zeroLine).toBeDefined()
    expect(zeroLine!.amount).toBe(0)
    expect(zeroLine!.description).toBe("Storage")
    expect(zeroLine!.quantity).toBe(5)
  })

  it("trial periods get kind 'trial' in zero lines", async () => {
    const db = makeDbWithPeriods([makePeriodRow({ id: "bp_trial", type: "trial" })])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(Ok([]))

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    const lines = result.val!
    expect(lines.length).toBe(1)
    expect(lines[0]!.kind).toBe("trial")
    expect(lines[0]!.amount).toBe(0)
  })

  it("returns Err when ledger service fails", async () => {
    const db = makeDbWithPeriods([])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    )

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeDefined()
    expect(result.err!.message).toContain("LEDGER_GET_ENTRIES_FAILED")
  })

  it("returns empty array when no ledger lines and no periods", async () => {
    const db = makeDbWithPeriods([])
    const billing = makeBillingService(db)

    ledgerMock.getInvoiceLines.mockResolvedValue(Ok([]))

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toEqual([])
  })

  it("projected lines come before zero lines", async () => {
    const db = makeDbWithPeriods([makePeriodRow({ id: "bp_1" }), makePeriodRow({ id: "bp_2" })])
    const billing = makeBillingService(db)

    // Only bp_1 has a ledger line
    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([makeLedgerLine({ metadata: { billing_period_id: "bp_1" } })])
    )

    const result = await billing.getInvoiceStatementLines({
      projectId: "proj_1",
      invoiceId: "inv_1",
      statementKey: "stmt_2026_04",
      currency: "USD",
    })

    const lines = result.val!
    expect(lines.length).toBe(2)
    // Projected ledger lines first, zero lines second
    expect(lines[0]!.entryId).toBe("ple_1")
    expect(lines[1]!.entryId).toBe("billing-period:bp_2")
  })
})
