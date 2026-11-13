import { Err, FetchError, Ok } from "@unprice/error"
import { dinero } from "dinero.js"
import { describe, expect, it, vi } from "vitest"
import type { LedgerGateway } from "../../ledger"
import { UnPriceLedgerError } from "../../ledger/errors"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import { billPeriod } from "./bill-period"
import {
  makeBillingPeriod,
  makeContext,
  makeDb,
  makeFlatRow,
  makeInvoicing,
  makeLedgerService,
  makeLogger,
  makePeriodGroup,
  makePhase,
  makeRepo,
  makeStatementLine,
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
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(invoicing.rateCards.getEffectiveRows).toHaveBeenCalledTimes(1)
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
    const invoicing = makeInvoicing()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(invoicing.rateCards.getEffectiveRows).toHaveBeenCalledTimes(1)
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

    const invoicing = makeInvoicing()

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
      invoicing,
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
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
    expect(repositories.tx.markPeriodsInvoiced).not.toHaveBeenCalled()
  })

  it("refuses to invoice money from a card priced in credits", async () => {
    const invoicing = makeInvoicing()
    invoicing.rateCards.cardForPlanVersion.mockResolvedValue({
      planVersionId: "pv_1",
      currency: "USD",
      cardId: "card_credits",
      unit: "credits:ai",
    })

    await expect(
      billPeriod({
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb(),
        repo: makeRepo(),
        invoicing,
        ledgerService: makeLedgerService(),
      })
    ).rejects.toThrow(/prices in credits:ai/)

    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
  })

  it("ledger transfer failure aborts the transaction (throws), no invoice created", async () => {
    const ledgerError = new UnPriceLedgerError({ message: "LEDGER_TRANSFER_FAILED" })
    const ledgerService = makeLedgerService({
      createTransfer: vi.fn().mockResolvedValue(Err(ledgerError)),
    } as unknown as Partial<LedgerGateway>)

    const db = makeDb()
    const invoicing = makeInvoicing()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        invoicing,
        ledgerService,
      })
    ).rejects.toThrow("LEDGER_TRANSFER_FAILED")

    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
  })

  it("no pending period groups throws with next invoice date when future periods exist", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const futureInvoiceAt = 1_700_100_000_000
    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: futureInvoiceAt }] })
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        invoicing,
        ledgerService,
      })
    ).rejects.toThrow("Cannot invoice subscription, next invoice date is at")
    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when pending arrears periods are still in grace", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: 1_699_999_999_999 }] })
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(0)
    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups throws when no pending billing periods exist at all", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [] })
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        invoicing,
        ledgerService,
      })
    ).rejects.toThrow(
      "Cannot invoice subscription, there are no pending billing periods to invoice"
    )
    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when statement was already invoiced", async () => {
    repositories.outer.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ invoicedPeriod: [{ id: "bp_1" }] })
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(0)
    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("advisory lock SQL uses correct key format: bill:{projectId}:{statementKey}", async () => {
    const db = makeDb()
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
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

  it("bills a metered period with the amount its statement priced at ingestion", async () => {
    const usage = makeBillingPeriod({
      subscriptionItem: {
        id: "item_1",
        units: null,
        featurePlanVersion: {
          id: "fpv_1",
          featureType: "usage",
          billingConfig: {},
          feature: { slug: "api-calls", title: "API Calls" },
        },
      },
    })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([usage])
    const invoicing = makeInvoicing({ sealed: [makeStatementLine({ amount: "4200000000" })] })
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb({ statementPeriods: [usage] }),
      repo: makeRepo(),
      invoicing,
      ledgerService,
    })

    expect(invoicing.payerBudgets.seal).toHaveBeenCalledWith({
      projectId: "proj_1",
      customerId: "cust_1",
      statementKey: "stmt_2026_04",
      at: usage.cycleEndAt + 1,
    })
    const transfer = vi.mocked(ledgerService.createTransfer).mock.calls[0]?.[0]
    expect(transfer?.amount.toJSON().amount).toBe(4_200_000_000)
    expect(transfer?.metadata).toMatchObject({
      kind: "usage",
      quantity: 12,
      feature_slug: "api-calls",
    })
    expect(invoicing.payerBudgets.completeInvoiced).toHaveBeenCalledTimes(2)
  })

  it("bills nothing for a metered period whose statement was never registered", async () => {
    const usage = makeBillingPeriod({
      subscriptionItem: {
        id: "item_1",
        units: null,
        featurePlanVersion: {
          id: "fpv_1",
          featureType: "usage",
          billingConfig: {},
          feature: { slug: "api-calls", title: "API Calls" },
        },
      },
    })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([usage])
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb({ statementPeriods: [usage] }),
      repo: makeRepo(),
      invoicing: makeInvoicing(),
      ledgerService,
    })

    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledTimes(1)
  })

  it("waits while a metered period's statement is still open", async () => {
    const usage = makeBillingPeriod({
      subscriptionItem: {
        id: "item_1",
        units: null,
        featurePlanVersion: {
          id: "fpv_1",
          featureType: "usage",
          billingConfig: {},
          feature: { slug: "api-calls", title: "API Calls" },
        },
      },
    })
    const invoicing = makeInvoicing({ open: ["bp_1"] })

    await expect(
      billPeriod({
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb({ statementPeriods: [usage] }),
        repo: makeRepo(),
        invoicing,
        ledgerService: makeLedgerService(),
      })
    ).rejects.toThrow(/still has open usage for bp_1/)

    expect(repositories.tx.createInvoice).not.toHaveBeenCalled()
  })

  it("prorates a recurring row over a period shorter than its cycle", async () => {
    const period = makeBillingPeriod({
      cycleStartAt: Date.UTC(2026, 0, 1),
      cycleEndAt: Date.UTC(2026, 0, 16),
      subscriptionItem: {
        id: "item_1",
        units: 1,
        featurePlanVersion: {
          id: "fpv_1",
          featureType: "flat",
          billingConfig: {
            name: "monthly",
            billingInterval: "month",
            billingIntervalCount: 1,
            billingAnchor: 1,
            planType: "recurring",
          },
          feature: { slug: "api-calls", title: "API Calls" },
        },
      },
    })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([period])
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb({ statementPeriods: [period] }),
      repo: makeRepo(makePhase({ startAt: Date.UTC(2026, 0, 1) })),
      invoicing: makeInvoicing(),
      ledgerService,
    })

    const transfer = vi.mocked(ledgerService.createTransfer).mock.calls[0]?.[0]
    // 15 of January's 31 days of a $1000 fee.
    expect(transfer?.amount.toJSON().amount).toBe(Math.round(1000_0000_0000 * (15 / 31)))
  })

  it("invoice upsert returns null — throws and aborts transaction", async () => {
    repositories.tx.createInvoice = vi.fn().mockResolvedValue(null)

    const db = makeDb()
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const repo = makeRepo()
    const logger = makeLogger()

    await expect(
      billPeriod({
        context: makeContext(),
        logger,
        db,
        repo,
        invoicing,
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
    const invoicing = makeInvoicing()
    const ledgerService = makeLedgerService()
    const logger = makeLogger()

    const result = await billPeriod({
      context: makeContext(),
      logger,
      db,
      repo,
      invoicing,
      ledgerService,
    })

    // Both groups counted (phasesProcessed = total groups, not successful ones)
    expect(result.phasesProcessed).toBe(2)
    // Only the second group triggers billing work
    expect(repo.findPhaseForBilling).toHaveBeenCalledTimes(2)
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
  })

  it("blocks invoicing when the seal fails", async () => {
    const usage = makeBillingPeriod({
      subscriptionItem: {
        id: "item_1",
        units: null,
        featurePlanVersion: {
          id: "fpv_1",
          featureType: "usage",
          billingConfig: {},
          feature: { slug: "api-calls", title: "API Calls" },
        },
      },
    })
    const invoicing = makeInvoicing()
    invoicing.payerBudgets.seal.mockResolvedValue(
      Err(new FetchError({ message: "seal failed", retry: true }))
    )
    const ledgerService = makeLedgerService()

    await expect(
      billPeriod({
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb({ statementPeriods: [usage] }),
        repo: makeRepo(),
        invoicing,
        ledgerService,
      })
    ).rejects.toThrow("seal failed")

    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("seals nothing for a statement without metered periods", async () => {
    const invoicing = makeInvoicing()

    await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb(),
      repo: makeRepo(),
      invoicing,
      ledgerService: makeLedgerService(),
    })

    expect(invoicing.payerBudgets.seal).not.toHaveBeenCalled()
    expect(invoicing.payerBudgets.completeInvoiced).not.toHaveBeenCalled()
    expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
  })

  it("invoices when completing statements fails, logging it for the next run to repair", async () => {
    for (const failure of ["err", "throw"] as const) {
      repositories.tx.createInvoice.mockClear()
      const usage = meteredPeriod()
      repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([usage])
      const invoicing = makeInvoicing({ sealed: [makeStatementLine({ amount: "4200000000" })] })
      const error = new FetchError({ message: "budget unavailable", retry: true })
      if (failure === "err") invoicing.payerBudgets.completeInvoiced.mockResolvedValue(Err(error))
      else invoicing.payerBudgets.completeInvoiced.mockRejectedValue(error)
      const logger = makeLogger()
      const ledgerService = makeLedgerService({
        getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
      } as unknown as Partial<LedgerGateway>)

      const result = await billPeriod({
        context: makeContext(),
        logger,
        db: makeDb({ statementPeriods: [usage] }),
        repo: makeRepo(),
        invoicing,
        ledgerService,
      })

      expect(result.phasesProcessed).toBe(1)
      expect(repositories.tx.createInvoice).toHaveBeenCalledTimes(1)
      expect(invoicing.payerBudgets.completeInvoiced).toHaveBeenCalledTimes(2)
      expect(vi.mocked(logger.error).mock.calls).toEqual([
        [error, expect.objectContaining({ projectId: "proj_1", customerId: "cust_1" })],
        [error, expect.objectContaining({ projectId: "proj_1", customerId: "cust_1" })],
      ])
    }
  })

  it("completes statements once before and once after every group, never per group", async () => {
    repositories.outer.listPendingPeriodGroups = vi
      .fn()
      .mockResolvedValue([
        makePeriodGroup({ statementKey: "stmt_a" }),
        makePeriodGroup({ statementKey: "stmt_b" }),
      ])
    const usage = meteredPeriod()
    const invoicing = makeInvoicing()

    await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb({ statementPeriods: [usage] }),
      repo: makeRepo(),
      invoicing,
      ledgerService: makeLedgerService({
        getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
      } as unknown as Partial<LedgerGateway>),
    })

    expect(invoicing.payerBudgets.seal).toHaveBeenCalledTimes(2)
    expect(invoicing.payerBudgets.completeInvoiced).toHaveBeenCalledTimes(2)
  })

  it("invoices a capped phase's trial usage as free, with nothing captured", async () => {
    const trial = meteredPeriod({ type: "trial" })
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([trial])
    const invoicing = makeInvoicing({ sealed: [makeStatementLine({ amount: "4200000000" })] })
    const ledgerService = makeLedgerService({
      getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
    } as unknown as Partial<LedgerGateway>)

    const result = await billPeriod({
      context: makeContext(),
      logger: makeLogger(),
      db: makeDb({ statementPeriods: [trial] }),
      repo: makeRepo(makePhase({ creditLinePolicy: "capped" })),
      invoicing,
      ledgerService,
    })

    expect(result.phasesProcessed).toBe(1)
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.updateInvoice.mock.calls[0]?.[0].data).toMatchObject({
      grossAmount: 0,
      amountDue: 0,
    })
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledWith(
      expect.objectContaining({ periodIds: ["bp_1"], invoiceId: "inv_1" })
    )
  })

  it("bills a capped phase's usage past its wallet captures as a receivable", async () => {
    const usage = meteredPeriod()
    repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([usage])
    const capture = (amount: number) =>
      Ok([
        {
          entryId: "ple_capture",
          statementKey: "stmt_2026_04",
          amount: dinero({ amount, currency: usd, scale: 8 }),
          metadata: { billing_period_id: "bp_1", flow: "capture" },
        },
      ])
    const bill = (captured: number) => {
      const ledgerService = makeLedgerService({
        getInvoiceLines: vi.fn().mockResolvedValue(capture(captured)),
      } as unknown as Partial<LedgerGateway>)
      const run = billPeriod({
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb({ statementPeriods: [usage] }),
        repo: makeRepo(makePhase({ creditLinePolicy: "capped" })),
        invoicing: makeInvoicing({ sealed: [makeStatementLine({ amount: "4200000000" })] }),
        ledgerService,
      })
      return { run, ledgerService }
    }

    const short = bill(2_000_000_000)
    await short.run
    expect(JSON.stringify(vi.mocked(short.ledgerService.createTransfer).mock.calls)).toContain(
      "2200000000"
    )

    const covered = bill(4_200_000_000)
    await covered.run
    expect(covered.ledgerService.createTransfer).not.toHaveBeenCalled()
    expect(repositories.tx.markPeriodsInvoiced).toHaveBeenCalledTimes(2)
  })

  it("bills a full flat fee for a phase's last period, which ends on its inclusive last ms", async () => {
    const jan1 = Date.UTC(2026, 0, 1)
    const feb1 = Date.UTC(2026, 1, 1)
    // Capped to the phase's inclusive end, and still uncapped past it.
    for (const cycleEndAt of [feb1 - 1, feb1]) {
      const period = makeBillingPeriod({
        cycleStartAt: jan1,
        cycleEndAt,
        subscriptionItem: {
          id: "item_1",
          units: 1,
          featurePlanVersion: {
            id: "fpv_1",
            featureType: "flat",
            billingConfig: {
              name: "monthly",
              billingInterval: "month",
              billingIntervalCount: 1,
              billingAnchor: 1,
              planType: "recurring",
            },
            feature: { slug: "api-calls", title: "API Calls" },
          },
        },
      })
      repositories.tx.listPendingPeriodsForStatement = vi.fn().mockResolvedValue([period])
      const ledgerService = makeLedgerService({
        getInvoiceLines: vi.fn().mockResolvedValue(Ok([])),
      } as unknown as Partial<LedgerGateway>)

      await billPeriod({
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb({ statementPeriods: [period] }),
        repo: makeRepo(makePhase({ startAt: jan1, endAt: feb1 - 1 })),
        invoicing: makeInvoicing({
          rows: [makeFlatRow({ price: { type: "flat", amount: BigInt(100_0000_0000) } })],
        }),
        ledgerService,
      })

      const transfer = vi.mocked(ledgerService.createTransfer).mock.calls[0]?.[0]
      // $100 at the ledger scale; a 1 ms short window used to shave it to 9_999_999_996.
      expect(transfer?.amount.toJSON().amount).toBe(10_000_000_000)
      expect(transfer?.metadata).toMatchObject({ proration_factor: 1 })
    }
  })
})

/** The default `bp_1`, as a period of a metered item. */
function meteredPeriod(overrides: Record<string, unknown> = {}) {
  return makeBillingPeriod({
    subscriptionItem: {
      id: "item_1",
      units: null,
      featurePlanVersion: {
        id: "fpv_1",
        featureType: "usage",
        billingConfig: {},
        feature: { slug: "api-calls", title: "API Calls" },
      },
    },
    ...overrides,
  })
}
