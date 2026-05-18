import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import type { BillingConfig } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
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

// Mock calculateProration so we can control proration factors deterministically
const calculateProrationMock = vi.hoisted(() => vi.fn())

vi.mock("@unprice/db/validators", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@unprice/db/validators")>()
  return {
    ...actual,
    calculateProration: calculateProrationMock,
  }
})

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

/** Build a tx mock with query.invoices.findFirst */
function makeTxMock(invoiceResult?: Record<string, unknown>) {
  return {
    query: {
      invoices: {
        findFirst: vi.fn().mockResolvedValue(invoiceResult ?? undefined),
      },
    },
  } as unknown as Database
}

function makeBillingService() {
  const logger = makeLogger()

  const billing = new BillingService({
    db: {} as Database,
    logger,
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

  return { billing, logger }
}

function basePeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp_1",
    projectId: "proj_1",
    invoiceId: "inv_1",
    cycleStartAt: 1000,
    cycleEndAt: 2000,
    ...overrides,
  }
}

const BASE_BILLING_CONFIG: BillingConfig = {
  name: "monthly",
  billingInterval: "month",
  billingIntervalCount: 1,
  billingAnchor: "dayOfCreation",
  planType: "recurring",
}

const BASE_INPUT_EXTRAS = {
  phaseStartAt: 1000,
  billingAnchor: 1,
  billingConfig: BASE_BILLING_CONFIG,
}

type ComputeProratedRefundInput = {
  period: {
    id: string
    projectId: string
    invoiceId: string | null
    cycleStartAt: number
    cycleEndAt: number
  }
  phaseEndAt: number
  phaseStartAt: number
  billingAnchor: number
  billingConfig: BillingConfig
}

type BillingServiceProrationAccess = {
  computeProratedRefundAmount: (tx: Database, input: ComputeProratedRefundInput) => Promise<number>
}

function computeProratedRefundAmount(
  billing: BillingService,
  tx: Database,
  input: ComputeProratedRefundInput
) {
  return (billing as unknown as BillingServiceProrationAccess).computeProratedRefundAmount(
    tx,
    input
  )
}

/** Helper to build a Dinero-like amount mock with toJSON */
function dineroAmount(amount: number) {
  return {
    toJSON: () => ({ amount, currency: { code: "USD" }, scale: 2 }),
  }
}

describe("BillingService.computeProratedRefundAmount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 0 when period has no invoiceId", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock()

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod({ invoiceId: null }),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
    // Should not even query the DB
    expect(tx.query.invoices.findFirst).not.toHaveBeenCalled()
  })

  it("returns 0 when invoice is not found", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock(undefined) // findFirst returns undefined

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })

  it("returns 0 when invoice is not paid (draft)", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "draft", statementKey: "stmt_1" })

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })

  it("returns 0 when invoice is unpaid", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "unpaid", statementKey: "stmt_1" })

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })

  it("returns 0 when newFactor >= oldFactor (no shortening)", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "paid", statementKey: "stmt_1" })

    // Both proration calls return same factor — no shortening
    calculateProrationMock.mockReturnValue({ prorationFactor: 1.0 })

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 2000,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })

  it("computes ~50% refund for half-period cancellation", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "paid", statementKey: "stmt_1" })
    const paidAmount = 100_000_000 // $100 in minor units

    // Original period: full factor 1.0, shortened: 0.5
    calculateProrationMock
      .mockReturnValueOnce({ prorationFactor: 1.0 }) // original
      .mockReturnValueOnce({ prorationFactor: 0.5 }) // new (shortened)

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([{ amount: dineroAmount(paidAmount), metadata: { billing_period_id: "bp_1" } }])
    )

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    // unearnedFraction = 1 - 0.5/1.0 = 0.5
    // refund = floor(100_000_000 * 0.5) = 50_000_000
    expect(result).toBe(50_000_000)
  })

  it("returns 0 when ledger lines return an error (graceful fallback)", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "paid", statementKey: "stmt_1" })

    calculateProrationMock
      .mockReturnValueOnce({ prorationFactor: 1.0 })
      .mockReturnValueOnce({ prorationFactor: 0.5 })

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Err(new UnPriceLedgerError({ message: "LEDGER_GET_ENTRIES_FAILED" }))
    )

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })

  it("returns 0 when paid amount sums to zero", async () => {
    const { billing } = makeBillingService()
    const tx = makeTxMock({ status: "paid", statementKey: "stmt_1" })

    calculateProrationMock
      .mockReturnValueOnce({ prorationFactor: 1.0 })
      .mockReturnValueOnce({ prorationFactor: 0.5 })

    ledgerMock.getInvoiceLines.mockResolvedValue(
      Ok([{ amount: dineroAmount(0), metadata: { billing_period_id: "bp_1" } }])
    )

    const result = await computeProratedRefundAmount(billing, tx, {
      period: basePeriod(),
      phaseEndAt: 1500,
      ...BASE_INPUT_EXTRAS,
    })

    expect(result).toBe(0)
  })
})
