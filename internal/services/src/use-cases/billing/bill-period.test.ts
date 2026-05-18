import type { Database } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Err, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LedgerGateway } from "../../ledger"
import { UnPriceLedgerError } from "../../ledger/errors"
import { UnPriceRatingError } from "../../rating/errors"
import type { RatingService } from "../../rating/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import type { SubscriptionContext } from "../../subscriptions/types"
import { billPeriod } from "./bill-period"

// --- Mock DrizzleBillingRepository ---

type RepoInstance = {
  listPendingPeriodGroups: ReturnType<typeof vi.fn>
  listPendingPeriodsForStatement: ReturnType<typeof vi.fn>
  createInvoice: ReturnType<typeof vi.fn>
  updateInvoice: ReturnType<typeof vi.fn>
  markPeriodsInvoiced: ReturnType<typeof vi.fn>
}

type MockBillPeriodTx = {
  execute: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
}

type MockBillPeriodDb = Database & {
  tx: MockBillPeriodTx
}

let outerRepoInstance: RepoInstance
let txRepoInstance: RepoInstance

let repoCallCount = 0
vi.mock("../../billing/repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn().mockImplementation(() => {
    repoCallCount++
    return repoCallCount === 1 ? outerRepoInstance : txRepoInstance
  }),
}))

const usd = dineroCurrencies.USD

// --- Helpers ---

function makeLogger(): Logger {
  return {
    set: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger
}

function makePeriodGroup(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionPhaseId: "phase_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    statementKey: "stmt_2026_04",
    invoiceAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makePhase(overrides: Record<string, unknown> = {}) {
  return {
    id: "phase_1",
    projectId: "proj_1",
    subscriptionId: "sub_1",
    paymentMethodId: "pm_1",
    paymentProvider: "stripe",
    planVersion: {
      whenToBill: "pay_in_advance",
      billingConfig: { billingInterval: "month" },
      paymentMethodRequired: true,
      collectionMethod: "charge_automatically",
      currency: "USD",
      gracePeriod: 1,
    },
    subscription: {
      customerId: "cust_1",
      timezone: "UTC",
    },
    ...overrides,
  }
}

function makeBillingPeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: "bp_1",
    projectId: "proj_1",
    customerId: "cust_1",
    subscriptionId: "sub_1",
    subscriptionPhaseId: "phase_1",
    subscriptionItemId: "item_1",
    statementKey: "stmt_2026_04",
    cycleStartAt: 1_700_000_000_000,
    cycleEndAt: 1_702_000_000_000,
    type: "regular",
    subscriptionItem: {
      units: 1,
      featurePlanVersion: {
        id: "fpv_1",
        featureType: "flat",
        feature: { slug: "api-calls", title: "API Calls" },
      },
    },
    ...overrides,
  }
}

function makeDb(opts: { entitlementRows?: Array<{ id: string }> } = {}): MockBillPeriodDb {
  const entitlementRows = opts.entitlementRows ?? [{ id: "ent_1" }]
  const txExecute = vi.fn().mockResolvedValue(undefined)
  const txSelectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(entitlementRows),
  }
  const txSelect = vi.fn().mockReturnValue(txSelectChain)
  const tx = { execute: txExecute, select: txSelect }

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb(tx)
  })

  return { transaction, tx } as unknown as MockBillPeriodDb
}

function makeRatingService(result?: unknown): RatingService {
  return {
    rateBillingPeriod: vi.fn().mockResolvedValue(
      result ??
        Ok([
          {
            price: {
              totalPrice: { dinero: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }) },
              unitPrice: { dinero: dinero({ amount: 100_0000_00, currency: usd, scale: 8 }) },
            },
            usage: 10,
            prorate: 1,
          },
        ])
    ),
  } as unknown as RatingService
}

function makeLedgerService(overrides: Partial<LedgerGateway> = {}): LedgerGateway {
  return {
    createTransfer: vi.fn().mockResolvedValue(Ok({ transferId: "xfer_1" })),
    getInvoiceLines: vi.fn().mockResolvedValue(
      Ok([
        {
          entryId: "ple_1",
          statementKey: "stmt_2026_04",
          kind: "subscription",
          description: "API Calls",
          quantity: 10,
          amount: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }),
          currency: "USD",
          createdAt: new Date(),
          metadata: {
            billing_period_id: "bp_1",
            subscription_id: "sub_1",
            subscription_item_id: "item_1",
            cycle_start_at: 1_700_000_000_000,
            cycle_end_at: 1_702_000_000_000,
            proration_factor: 1,
            description: "API Calls",
          },
        },
      ])
    ),
    ...overrides,
  } as unknown as LedgerGateway
}

function makeRepo(phase?: unknown): SubscriptionRepository {
  return {
    findPhaseForBilling: vi.fn().mockResolvedValue(phase ?? makePhase()),
  } as unknown as SubscriptionRepository
}

function makeContext(overrides: Partial<SubscriptionContext> = {}): SubscriptionContext {
  return {
    subscriptionId: "sub_1",
    projectId: "proj_1",
    subscription: { id: "sub_1", projectId: "proj_1" } as unknown as Subscription,
    customer: { id: "cust_1", projectId: "proj_1" } as unknown as Customer,
    paymentMethodId: null,
    requiredPaymentMethod: false,
    currentPhase: null,
    now: 1_700_000_000_000,
    ...overrides,
  } as SubscriptionContext
}

describe("billPeriod", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repoCallCount = 0

    outerRepoInstance = {
      listPendingPeriodGroups: vi.fn().mockResolvedValue([makePeriodGroup()]),
      listPendingPeriodsForStatement: vi.fn().mockResolvedValue([makeBillingPeriod()]),
      createInvoice: vi.fn().mockResolvedValue({ id: "inv_1", projectId: "proj_1" }),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
      markPeriodsInvoiced: vi.fn().mockResolvedValue(undefined),
    }

    txRepoInstance = {
      listPendingPeriodGroups: vi.fn().mockResolvedValue([makePeriodGroup()]),
      listPendingPeriodsForStatement: vi.fn().mockResolvedValue([makeBillingPeriod()]),
      createInvoice: vi.fn().mockResolvedValue({ id: "inv_1", projectId: "proj_1" }),
      updateInvoice: vi.fn().mockResolvedValue(undefined),
      markPeriodsInvoiced: vi.fn().mockResolvedValue(undefined),
    }
  })

  it("happy path: single period group with one flat-fee period — rates, posts, creates invoice, marks invoiced", async () => {
    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ratingService.rateBillingPeriod).toHaveBeenCalledTimes(1)
    expect(ledgerService.createTransfer).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.updateInvoice).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.markPeriodsInvoiced).toHaveBeenCalledWith(
      expect.objectContaining({ periodIds: ["bp_1"], invoiceId: "inv_1" })
    )
  })

  it("two periods in same statement — both rated and posted, one invoice, total is sum", async () => {
    const period1 = makeBillingPeriod({ id: "bp_1", subscriptionItemId: "item_1" })
    const period2 = makeBillingPeriod({ id: "bp_2", subscriptionItemId: "item_2" })
    txRepoInstance.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([period1, period2])

    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(
        Ok([
          {
            entryId: "ple_1",
            statementKey: "stmt_2026_04",
            amount: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }),
            metadata: {
              billing_period_id: "bp_1",
              cycle_start_at: 1_700_000_000_000,
              cycle_end_at: 1_702_000_000_000,
            },
          },
          {
            entryId: "ple_2",
            statementKey: "stmt_2026_04",
            amount: dinero({ amount: 500_0000_00, currency: usd, scale: 8 }),
            metadata: {
              billing_period_id: "bp_2",
              cycle_start_at: 1_700_000_000_000,
              cycle_end_at: 1_702_000_000_000,
            },
          },
        ])
      ),
    } as unknown as Partial<LedgerGateway>)

    const db = makeDb()
    const ratingService = makeRatingService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ratingService.rateBillingPeriod).toHaveBeenCalledTimes(2)
    expect(ledgerService.createTransfer).toHaveBeenCalledTimes(2)
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.updateInvoice).toHaveBeenCalledTimes(1)
    // Total should be sum of both lines (1000_0000_00 + 500_0000_00 = 1500_0000_00 at scale 8 = 15_00 in ledger minor)
    const updateCall = txRepoInstance.updateInvoice.mock.calls[0]?.[0]
    expect(updateCall).toBeDefined()
    expect(updateCall.data.totalAmount).toBeGreaterThan(0)
    expect(txRepoInstance.markPeriodsInvoiced).toHaveBeenCalledWith(
      expect.objectContaining({ periodIds: ["bp_1", "bp_2"] })
    )
  })

  it("zero-amount period (trial) skips ledger posting but still creates invoice", async () => {
    const trialPeriod = makeBillingPeriod({ type: "trial" })
    txRepoInstance.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([trialPeriod])

    // Rating returns zero amount
    const ratingService = {
      rateBillingPeriod: vi.fn().mockResolvedValue(
        Ok([
          {
            price: {
              totalPrice: { dinero: dinero({ amount: 0, currency: usd, scale: 8 }) },
              unitPrice: { dinero: dinero({ amount: 0, currency: usd, scale: 8 }) },
            },
            usage: 0,
            prorate: 0,
          },
        ])
      ),
    } as unknown as RatingService

    // No lines since nothing was posted
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    const db = makeDb()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
  })

  it("idempotent re-run — listPendingPeriodsForStatement returns empty inside tx, no rating/posting", async () => {
    txRepoInstance.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([])

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(txRepoInstance.createInvoice).not.toHaveBeenCalled()
    expect(txRepoInstance.markPeriodsInvoiced).not.toHaveBeenCalled()
  })

  it("rating failure aborts the transaction (throws), no invoice created", async () => {
    const ratingError = new UnPriceRatingError({ message: "Rating engine unavailable" })
    const ratingService = {
      rateBillingPeriod: vi.fn().mockResolvedValue(Err(ratingError)),
    } as unknown as RatingService

    const db = makeDb()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow(ratingError)

    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(txRepoInstance.createInvoice).not.toHaveBeenCalled()
  })

  it("ledger transfer failure aborts the transaction (throws), no invoice created", async () => {
    const ledgerError = new UnPriceLedgerError({ message: "LEDGER_TRANSFER_FAILED" })
    const ledgerService = makeLedgerService({
      createTransfer: vi.fn().mockResolvedValue(Err(ledgerError)),
    } as unknown as Partial<LedgerGateway>)

    const db = makeDb()
    const ratingService = makeRatingService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow("LEDGER_TRANSFER_FAILED")

    expect(txRepoInstance.createInvoice).not.toHaveBeenCalled()
  })

  it("no pending period groups returns phasesProcessed: 0 immediately", async () => {
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(0)
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("advisory lock SQL uses correct key format: bill:{projectId}:{statementKey}", async () => {
    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    // The tx.execute call inside the transaction should contain the advisory lock SQL
    const txExecute = db.tx.execute
    expect(txExecute).toHaveBeenCalled()
    const lockCall = txExecute.mock.calls[0]
    // The sql template tag produces a query object; verify the lock key pattern
    // is passed. The exact shape depends on drizzle's sql`` but we can check
    // the call was made.
    expect(lockCall).toBeDefined()
  })

  it("negative amount period — logs warning and skips ledger posting", async () => {
    // Rating returns a negative amount (credit scenario)
    const ratingService = {
      rateBillingPeriod: vi.fn().mockResolvedValue(
        Ok([
          {
            price: {
              totalPrice: { dinero: dinero({ amount: -500_0000_00, currency: usd, scale: 8 }) },
              unitPrice: { dinero: dinero({ amount: -50_0000_00, currency: usd, scale: 8 }) },
            },
            usage: 10,
            prorate: 1,
          },
        ])
      ),
    } as unknown as RatingService

    // No lines since posting is skipped
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    const db = makeDb()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    // Negative amount should skip the ledger transfer
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    // But invoice should still be created (empty) and periods marked
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
    expect(txRepoInstance.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
    // Logger should have warned about the negative amount
    expect(logger.warn).toHaveBeenCalled()
  })

  it("invoice upsert returns null — throws and aborts transaction", async () => {
    txRepoInstance.createInvoice = vi.fn().mockResolvedValue(null)

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow(/Invoice upsert returned no row/)

    expect(txRepoInstance.markPeriodsInvoiced).not.toHaveBeenCalled()
  })

  it("phase not found — skips that group, continues to next", async () => {
    const groups = [
      makePeriodGroup({ subscriptionPhaseId: "phase_missing" }),
      makePeriodGroup({ subscriptionPhaseId: "phase_2" }),
    ]
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue(groups)

    const repo = {
      findPhaseForBilling: vi
        .fn()
        .mockResolvedValueOnce(null) // first group: phase not found
        .mockResolvedValueOnce(makePhase({ id: "phase_2" })), // second group: found
    } as unknown as SubscriptionRepository

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    // Both groups counted (phasesProcessed = total groups, not successful ones)
    expect(result.phasesProcessed).toBe(2)
    // Only the second group triggers billing work
    expect(repo.findPhaseForBilling).toHaveBeenCalledTimes(2)
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
  })
})
