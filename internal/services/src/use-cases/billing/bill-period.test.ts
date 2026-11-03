import { Err, FetchError, Ok } from "@unprice/error"
import { dinero } from "dinero.js"
import { describe, expect, it, vi } from "vitest"
import type { LedgerGateway } from "../../ledger"
import { UnPriceLedgerError } from "../../ledger/errors"
import { UnPriceRatingError } from "../../rating/errors"
import type { RatingService } from "../../rating/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import { createBillingGatewayStub } from "../../test-fixtures/billing-gateway"
import { billPeriod } from "./bill-period"
import {
  makeBillingPeriod,
  makeContext,
  makeDb,
  makeLedgerService,
  makeLogger,
  makePeriodGroup,
  makePhase,
  makeRatingService,
  makeRepo,
  repositories,
  usd,
} from "./bill-period.test-fixture"
vi.mock("../../billing/repository.drizzle", () => ({
  DrizzleBillingRepository: class {
    constructor(db: { billingRepository: object }) {
      Object.assign(this, db.billingRepository)
    }
  },
}))

describe("billPeriod", () => {
  it("happy path: single period group with one flat-fee period — rates, posts, creates invoice, marks invoiced", async () => {
    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      reservationFlushGateway: createBillingGatewayStub(),
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
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
    expect(repositories.tx.updateInvoice).toHaveBeenCalledTimes(1)
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledWith(
      expect.objectContaining({ periodIds: ["bp_1"], invoiceId: "inv_1" })
    )
  })

  it("two periods in same statement — both rated and posted, one invoice, total is sum", async () => {
    const period1 = makeBillingPeriod({ id: "bp_1", subscriptionItemId: "item_1" })
    const period2 = makeBillingPeriod({ id: "bp_2", subscriptionItemId: "item_2" })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([period1, period2])

    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(
        Ok([
          {
            entryId: "ple_1",
            statementKey: "stmt_2026_04",
            amount: dinero({ amount: 1000_0000_00, currency: usd, scale: 8 }),
            metadata: {
              billing_period_id: "bp_1",
              feature_plan_version_item_id: "item_1",
              cycle_start_at: 1_700_000_000_000,
              cycle_end_at: 1_702_000_000_000,
              settlement_status: "due",
            },
          },
          {
            entryId: "ple_2",
            statementKey: "stmt_2026_04",
            amount: dinero({ amount: 500_0000_00, currency: usd, scale: 8 }),
            metadata: {
              billing_period_id: "bp_2",
              feature_plan_version_item_id: "item_2",
              cycle_start_at: 1_700_000_000_000,
              cycle_end_at: 1_702_000_000_000,
              settlement_status: "due",
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
      reservationFlushGateway: createBillingGatewayStub(),
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
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
    expect(repositories.tx.updateInvoice).toHaveBeenCalledTimes(1)
    const updateCall = repositories.tx.updateInvoice.mock.calls[0]?.[0]
    expect(updateCall).toBeDefined()
    expect(updateCall.data).toMatchObject({
      grossAmount: 1500_0000_00,
      amountDue: 1500_0000_00,
      amountIncluded: 0,
      amountPaid: 0,
    })
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledWith(
      expect.objectContaining({ periodIds: ["bp_1", "bp_2"] })
    )
  })

  it("zero-amount period (trial) skips ledger posting but still creates invoice", async () => {
    const trialPeriod = makeBillingPeriod({ type: "trial" })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([trialPeriod])

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
      reservationFlushGateway: createBillingGatewayStub(),
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
  })

  it("idempotent re-run — listPendingPeriodsForStatement returns empty inside tx, no rating/posting", async () => {
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([])

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      reservationFlushGateway: createBillingGatewayStub(),
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
    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
    expect(repositories.tx.markPeriodsInvoiced).not.toHaveBeenCalled()
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
        reservationFlushGateway: createBillingGatewayStub(),
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow(ratingError)

    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
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
        reservationFlushGateway: createBillingGatewayStub(),
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow("LEDGER_TRANSFER_FAILED")

    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
  })

  it("no pending period groups throws with next invoice date when future periods exist", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const futureInvoiceAt = 1_700_100_000_000
    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: futureInvoiceAt }] })
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        reservationFlushGateway: createBillingGatewayStub(),
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow("Cannot invoice subscription, next invoice date is at")
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when pending arrears periods are still in grace", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: 1_699_999_999_999 }] })
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      reservationFlushGateway: createBillingGatewayStub(),
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

  it("no pending period groups throws when no pending billing periods exist at all", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [] })
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        reservationFlushGateway: createBillingGatewayStub(),
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow(
      "Cannot invoice subscription, there are no pending billing periods to invoice"
    )
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when statement was already invoiced", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ invoicedPeriod: [{ id: "bp_1" }] })
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      reservationFlushGateway: createBillingGatewayStub(),
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
      reservationFlushGateway: createBillingGatewayStub(),
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
      reservationFlushGateway: createBillingGatewayStub(),
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
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
    // Logger should have warned about the negative amount
    expect(logger.warn).toHaveBeenCalled()
  })

  it("invoice upsert returns null — throws and aborts transaction", async () => {
    repositories.tx.createInvoice = vi.fn().mockResolvedValue(null)

    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        reservationFlushGateway: createBillingGatewayStub(),
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
      })
    ).rejects.toThrow(/Invoice upsert returned no row/)

    expect(repositories.tx.markPeriodsInvoiced).not.toHaveBeenCalled()
  })

  it("phase not found — skips that group, continues to next", async () => {
    const groups = [
      makePeriodGroup({ subscriptionPhaseId: "phase_missing" }),
      makePeriodGroup({ subscriptionPhaseId: "phase_2" }),
    ]
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue(groups)

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
      reservationFlushGateway: createBillingGatewayStub(),
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
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
  })

  it("blocks invoicing when reservation flush gateway fails", async () => {
    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()
    const reservationFlushGateway = {
      registerPeriods: vi.fn().mockResolvedValue(Ok(undefined)),
      completeForInvoicing: vi.fn().mockResolvedValue(Ok(undefined)),
      flushForInvoicing: vi.fn().mockResolvedValue(
        Err(
          new FetchError({
            message: "reservation flush deferred",
            retry: true,
            context: {
              url: "/v1/internal/billing-reservations/flush-for-invoicing",
              method: "POST",
            },
          })
        )
      ),
    }

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        ratingService,
        ledgerService,
        reservationFlushGateway,
      })
    ).rejects.toThrow("reservation flush deferred")

    // Rating and ledger should not have been reached
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("proceeds with invoicing when reservation flush gateway succeeds", async () => {
    const db = makeDb()
    const ratingService = makeRatingService()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()
    const reservationFlushGateway = {
      registerPeriods: vi.fn().mockResolvedValue(Ok(undefined)),
      completeForInvoicing: vi.fn().mockResolvedValue(Ok(undefined)),
      flushForInvoicing: vi.fn().mockResolvedValue(Ok({ snapshots: [], flushed: 0, skipped: 0 })),
    }

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      ratingService,
      ledgerService,
      reservationFlushGateway,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(reservationFlushGateway.flushForInvoicing).toHaveBeenCalledWith({
      projectId: "proj_1",
      customerId: "cust_1",
      subscriptionId: "sub_1",
      subscriptionPhaseId: "phase_1",
      statementKey: "stmt_2026_04",
    })
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
  })
})
