import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Cache } from "../cache"
import type { CustomerService } from "../customers/service"
import type { GrantsManager } from "../entitlements"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import type { RatingService } from "../rating/service"
import type { WalletService } from "../wallet"
import { UnPriceBillingError } from "./errors"
import { BillingService } from "./service"

// --- Mocks ---

const capPendingPeriodsAtPhaseEndMock = vi.fn().mockResolvedValue(undefined)
const listInvoicedPeriodsExceedingPhaseEndMock = vi.fn().mockResolvedValue([])
const getLastPeriodForItemMock = vi.fn().mockResolvedValue(null)
const createPeriodsBatchMock = vi.fn().mockResolvedValue(undefined)
const shortenBillingPeriodMock = vi.fn().mockResolvedValue(undefined)

vi.mock("./repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => ({
    capPendingPeriodsAtPhaseEnd: capPendingPeriodsAtPhaseEndMock,
    listInvoicedPeriodsExceedingPhaseEnd: listInvoicedPeriodsExceedingPhaseEndMock,
    getLastPeriodForItem: getLastPeriodForItemMock,
    createPeriodsBatch: createPeriodsBatchMock,
    shortenBillingPeriod: shortenBillingPeriodMock,
  })),
}))

// --- Helpers ---

const NOW = new Date("2026-03-15T00:00:00Z").getTime()
const PHASE_START = new Date("2026-03-01T00:00:00Z").getTime()
const PHASE_END = new Date("2026-04-01T00:00:00Z").getTime()

type GenerateBillingPeriodsPayload = {
  subscriptionId: string
  projectId: string
  now: number
  db?: Database
  dryRun?: boolean
}

type GenerateBillingPeriodsResult = {
  phasesProcessed: number
  cyclesCreated: number
}

type BillingServiceGenerateAccess = {
  _generateBillingPeriods: (
    payload: GenerateBillingPeriodsPayload
  ) => Promise<Result<GenerateBillingPeriodsResult, UnPriceBillingError>>
}

type MockDb = Database & {
  transaction: ReturnType<typeof vi.fn>
}

type MockLedgerGateway = LedgerGateway & {
  getInvoiceLines: ReturnType<typeof vi.fn>
}

function generateBillingPeriods(billing: BillingService, payload: GenerateBillingPeriodsPayload) {
  return (billing as unknown as BillingServiceGenerateAccess)._generateBillingPeriods(payload)
}

function makeItem(id = "item_1") {
  return {
    id,
    featurePlanVersion: {
      featureType: "flat",
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        planType: "recurring",
      },
    },
  }
}

function makePhase(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    startAt: PHASE_START,
    endAt: null,
    trialEndsAt: null,
    billingAnchor: PHASE_START,
    paymentProvider: "sandbox",
    planVersion: {
      whenToBill: "pay_in_advance",
      currency: "USD",
      collectionMethod: "charge_automatically",
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        planType: "recurring",
      },
    },
    subscription: {
      customerId: "cust_1",
    },
    items: [makeItem()],
    ...overrides,
  }
}

function makeDb(phases: unknown[] = []): MockDb {
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(transaction) // tx is the same mock so DrizzleBillingRepository uses it
  })

  const db = {
    transaction,
    query: {
      subscriptionPhases: {
        findMany: vi.fn().mockResolvedValue(phases),
      },
    },
  } as unknown as Database

  return db as MockDb
}

function makeLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

function makeWalletService() {
  return {
    adjust: vi.fn().mockResolvedValue(Ok(undefined)),
  } as unknown as WalletService
}

function makeLedgerService(): MockLedgerGateway {
  return {
    getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
  } as unknown as MockLedgerGateway
}

function makeBillingService(opts: { phases?: unknown[]; walletService?: WalletService } = {}) {
  const db = makeDb(opts.phases ?? [])
  const logger = makeLogger()
  const walletService = opts.walletService ?? makeWalletService()
  const ledgerService = makeLedgerService()

  const billing = new BillingService({
    db,
    logger,
    analytics: {} as Analytics,
    waitUntil: (p: Promise<unknown>) => {
      void p
    },
    cache: {} as Cache,
    metrics: {} as Metrics,
    customerService: {} as CustomerService,
    grantsManager: {} as GrantsManager,
    ratingService: {} as RatingService,
    ledgerService,
    walletService,
  })

  return { billing, db, logger, walletService, ledgerService }
}

// --- Tests ---

describe("BillingService._generateBillingPeriods", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns phasesProcessed=0 and cyclesCreated=0 when no phases found", async () => {
    const { billing } = makeBillingService({ phases: [] })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(result.val).toEqual({ phasesProcessed: 0, cyclesCreated: 0 })
    expect(createPeriodsBatchMock).not.toHaveBeenCalled()
  })

  it("creates billing periods for a single phase with one item", async () => {
    const phase = makePhase()
    const { billing } = makeBillingService({ phases: [phase] })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(result.err).toBeUndefined()
    expect(result.val!.phasesProcessed).toBe(1)
    expect(result.val!.cyclesCreated).toBeGreaterThanOrEqual(1)
    expect(createPeriodsBatchMock).toHaveBeenCalled()
  })

  it("creates billing periods for multiple items in a phase", async () => {
    const phase = makePhase({ items: [makeItem("item_1"), makeItem("item_2")] })
    const { billing } = makeBillingService({ phases: [phase] })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(result.val!.phasesProcessed).toBe(1)
    // Should have been called for each item
    expect(createPeriodsBatchMock).toHaveBeenCalledTimes(2)
  })

  it("calls capPendingPeriodsAtPhaseEnd when phase has endAt", async () => {
    const phase = makePhase({ endAt: PHASE_END })
    const { billing } = makeBillingService({ phases: [phase] })

    await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(capPendingPeriodsAtPhaseEndMock).toHaveBeenCalledWith({
      phaseId: "phase_1",
      phaseEndAt: PHASE_END,
      whenToBill: "pay_in_advance",
    })
  })

  it("computes prorated refund and shortens period when invoiced periods exceed phase end", async () => {
    const invoicedPeriod = {
      id: "bp_1",
      cycleStartAt: PHASE_START,
      cycleEndAt: PHASE_END + 86400000, // exceeds phase end by 1 day
    }
    listInvoicedPeriodsExceedingPhaseEndMock.mockResolvedValueOnce([invoicedPeriod])

    const walletService = makeWalletService()
    const phase = makePhase({ endAt: PHASE_END })
    const { billing, ledgerService } = makeBillingService({
      phases: [phase],
      walletService,
    })

    // Mock the ledger to return lines with an amount so refund > 0
    ledgerService.getInvoiceLines.mockResolvedValue(
      Ok([
        {
          entryId: "ple_1",
          statementKey: "stmt_1",
          kind: "subscription",
          description: "test",
          quantity: 1,
          amount: 5000,
          currency: "USD",
          createdAt: new Date(),
          metadata: { billing_period_id: "bp_1" },
        },
      ])
    )

    await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(listInvoicedPeriodsExceedingPhaseEndMock).toHaveBeenCalledWith({
      phaseId: "phase_1",
      phaseEndAt: PHASE_END,
    })
    expect(shortenBillingPeriodMock).toHaveBeenCalledWith({
      periodId: "bp_1",
      cycleEndAt: PHASE_END,
    })
  })

  it("dryRun=true skips DB writes but still counts cycles", async () => {
    const phase = makePhase()
    const { billing } = makeBillingService({ phases: [phase] })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
      dryRun: true,
    })

    expect(result.val!.cyclesCreated).toBeGreaterThanOrEqual(1)
    expect(createPeriodsBatchMock).not.toHaveBeenCalled()
    expect(capPendingPeriodsAtPhaseEndMock).not.toHaveBeenCalled()
  })

  it("uses lastForItem.cycleEndAt as cursor start when last period exists", async () => {
    const lastPeriodEnd = new Date("2026-03-10T00:00:00Z").getTime()
    getLastPeriodForItemMock.mockResolvedValueOnce({ cycleEndAt: lastPeriodEnd })

    const phase = makePhase()
    const { billing } = makeBillingService({ phases: [phase] })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(result.val!.phasesProcessed).toBe(1)
    expect(getLastPeriodForItemMock).toHaveBeenCalledWith({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      subscriptionPhaseId: "phase_1",
      subscriptionItemId: "item_1",
    })
  })

  it("returns Err with billing error when transaction throws", async () => {
    const phase = makePhase()
    const { billing, db } = makeBillingService({ phases: [phase] })

    // Override transaction to throw
    db.transaction.mockImplementationOnce(async () => {
      throw new Error("connection lost")
    })

    const result = await generateBillingPeriods(billing, {
      subscriptionId: "sub_1",
      projectId: "proj_1",
      now: NOW,
    })

    expect(result.err).toBeInstanceOf(UnPriceBillingError)
    expect(result.err!.message).toBe("connection lost")
  })
})
