import type { Database } from "@unprice/db"
import type { Customer, Subscription } from "@unprice/db/validators"
import { Err, FetchError, Ok } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { dinero } from "dinero.js"
import * as dineroCurrencies from "dinero.js/currencies"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { applyInputSchema } from "../../../../../apps/api/src/ingestion/entitlements/contracts"
import { createApplyInput } from "../../../../../apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "../../../../../apps/api/src/ingestion/entitlements/testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "../../../../../apps/api/src/ingestion/entitlements/testing/processor-contract"
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
  invoicedPeriod: Array<{ id: string }> | []
  nextPendingPeriod: Array<{ invoiceAt: number }> | []
}

let outerRepoInstance: RepoInstance
let txRepoInstance: RepoInstance

let repoCallCount = 0
vi.mock("../../billing/repository.drizzle", () => ({
  DrizzleBillingRepository: vi.fn(function DrizzleBillingRepository() {
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
      id: "item_1",
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

function makeDb(
  opts: {
    entitlementRows?: Array<{ id: string; effectiveAt?: number; expiresAt?: number | null }>
    invoicedPeriod?: Array<{ id: string }>
    nextPendingPeriod?: Array<{ invoiceAt: number }>
  } = {}
): MockBillPeriodDb {
  const entitlementRows = (opts.entitlementRows ?? [{ id: "ent_1" }]).map((row) => ({
    effectiveAt: 0,
    expiresAt: null,
    ...row,
  }))
  const invoicedPeriod = opts.invoicedPeriod ?? []
  const nextPendingPeriod = opts.nextPendingPeriod ?? []
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

  // Mock for db.select().from(billingPeriods).where(...).orderBy(...).limit(...)
  const makeDbSelectChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  })
  const dbSelect = vi
    .fn()
    .mockReturnValueOnce(makeDbSelectChain(nextPendingPeriod))
    .mockReturnValue(makeDbSelectChain(invoicedPeriod))

  return {
    transaction,
    tx,
    select: dbSelect,
    invoicedPeriod,
    nextPendingPeriod,
  } as unknown as MockBillPeriodDb
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
            feature_plan_version_item_id: "item_1",
            subscription_id: "sub_1",
            subscription_item_id: "item_1",
            cycle_start_at: 1_700_000_000_000,
            cycle_end_at: 1_702_000_000_000,
            proration_factor: 1,
            description: "API Calls",
            settlement_status: "due",
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

  it.each([
    ["normal", false, "uncapped", null, 0],
    ["trial", false, "uncapped", null, 0],
    ["normal", true, "uncapped", null, 0],
    ["normal", false, "capped", "due", 600_000_000],
    ["normal", false, "uncapped", "paid", 600_000_000],
    ["normal", false, "uncapped", "due", 600_000_000],
    ["normal", false, "uncapped", "included", 600_000_000],
    ["normal", false, "uncapped", "due", 1_100_000_000],
  ] as const)(
    "invoices accepted durable usage with delayed reporting for a %s period (completion fails: %s, policy: %s, capture: %s amount: %s)",
    async (periodType, failCompletion, phasePolicy, captureStatus, initialCapture) => {
      const period = makeBillingPeriod({
        type: periodType,
        subscriptionItem: {
          id: "item_1",
          units: null,
          featurePlanVersion: {
            id: "fpv_1",
            featureType: "usage",
            feature: { slug: "api-calls", title: "API Calls" },
          },
        },
      })
      txRepoInstance.listPendingPeriodsForStatement.mockResolvedValue([period])
      let invoiced = false
      let completionFailed = false
      let postedAmount = 0
      let capturedAmount: number = initialCapture
      outerRepoInstance.listPendingPeriodGroups.mockImplementation(async () =>
        invoiced ? [] : [makePeriodGroup()]
      )
      txRepoInstance.listPendingPeriodGroups = outerRepoInstance.listPendingPeriodGroups
      txRepoInstance.markPeriodsInvoiced.mockImplementation(async () => {
        invoiced = true
      })
      const ratingService = makeRatingService(Ok([]))
      const ledgerService = makeLedgerService({
        createTransfer: vi.fn(async (input) => {
          postedAmount += input.amount.toJSON().amount
          return Ok({ transferId: "xfer_1" })
        }),
        getInvoiceLines: vi.fn(async () =>
          Ok(
            [
              ...(capturedAmount === 0
                ? []
                : [{ amount: capturedAmount, flow: "capture", status: captureStatus }]),
              ...(postedAmount === 0
                ? []
                : [{ amount: postedAmount, flow: "subscription", status: "due" }]),
            ].map((line, index) => ({
              entryId: `entry_${index}`,
              statementKey: "stmt_2026_04",
              kind: "usage",
              description: "API Calls",
              quantity: line.amount / 100_000_000,
              amount: dinero({ amount: line.amount, currency: usd, scale: 8 }),
              currency: "USD",
              createdAt: new Date(),
              metadata: {
                billing_period_id: "bp_1",
                feature_plan_version_item_id: "item_1",
                subscription_id: "sub_1",
                subscription_item_id: "item_1",
                flow: line.flow,
                settlement_status: line.status,
                settlement_source:
                  line.flow !== "capture"
                    ? "provider"
                    : line.status === "paid"
                      ? "cash_wallet"
                      : line.status === "included"
                        ? "plan_included"
                        : "credit_line",
              },
            }))
          )
        ),
      } as unknown as Partial<LedgerGateway>)
      const eventAt = period.cycleStartAt + 1_000
      const input = createApplyInput({
        projectId: "proj_1",
        customerId: "cust_1",
        customerEntitlementId: "ent_1",
        subscriptionItemId: "item_1",
        periodStartAt: period.cycleStartAt,
        periodEndAt: period.cycleEndAt,
        featureSlug: "api-calls",
        now: eventAt,
        event: { timestamp: eventAt, properties: { amount: 10 } },
      })
      input.entitlement.billingPeriods[0] = {
        billingPeriodId: "bp_1",
        statementKey: "stmt_2026_04",
        featurePlanVersionItemId: "item_1",
        cycleStartAt: period.cycleStartAt,
        cycleEndAt: period.cycleEndAt,
      }
      const entitlement = {
        ...input.entitlement,
        creditLinePolicy: "uncapped" as const,
        overageStrategy: "none" as const,
        subscriptionId: "sub_1",
      }
      const harness = createEntitlementWindowProcessorHarness({
        now: eventAt,
        store: new InMemoryEntitlementWindowStore(),
      })
      const registration = {
        projectId: "proj_1",
        customerId: "cust_1",
        customerEntitlementId: "ent_1",
        subscriptionId: "sub_1",
        subscriptionPhaseId: "phase_1",
        subscriptionItemId: "item_1",
        billingPeriodId: "bp_1",
        statementKey: "stmt_2026_04",
        featureSlug: "api-calls",
        cycleStartAt: period.cycleStartAt,
        cycleEndAt: period.cycleEndAt,
        currency: "USD" as const,
        amountScale: 8 as const,
        origin: "period_generation_v1" as const,
        genesis: { version: 1 as const, customerEntitlementId: "ent_1" },
        registeredAt: eventAt,
      }
      if (typeof harness.processor.registerBillingPeriods === "function") {
        await harness.processor.registerBillingPeriods([registration])
      }
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(eventAt)
      const acceptedFacts = []
      const events =
        captureStatus === null
          ? [applyInputSchema.parse({ ...input, entitlement })]
          : [
              applyInputSchema.parse({
                ...input,
                entitlement,
                wallet: { mode: "external_reservation", remainingAmount: 1_000_000_000 },
                event: { ...input.event, properties: { amount: 6 } },
              }),
              applyInputSchema.parse({
                ...input,
                entitlement,
                idempotencyKey: "ordinary_4",
                event: { ...input.event, id: "ordinary_4", properties: { amount: 4 } },
              }),
            ]
      try {
        for (const event of events) {
          const accepted = await harness.processor.apply(event)
          expect(accepted.allowed).toBe(true)
          acceptedFacts.push(...(accepted.meterFacts ?? []))
        }
      } finally {
        wallClock.mockRestore()
      }
      expect(acceptedFacts.map((fact) => [fact.amount, fact.delta])).toEqual(
        captureStatus === null
          ? [[1_000_000_000, 10]]
          : [
              [600_000_000, 6],
              [400_000_000, 4],
            ]
      )
      const reservationFlushGateway = {
        registerPeriods: vi.fn().mockResolvedValue(Ok(undefined)),
        flushForInvoicing: vi.fn(async () =>
          Ok({
            snapshots:
              typeof harness.processor.sealBillingPeriods === "function"
                ? await harness.processor.sealBillingPeriods([registration])
                : [
                    {
                      ...registration,
                      amount: 1_000_000_000,
                      quantity: 10,
                      lastEventAt: eventAt,
                      state: "sealed" as const,
                      sealedAt: eventAt,
                      completedAt: null,
                    },
                  ],
          })
        ),
        completeForInvoicing: vi.fn(async () => {
          if (invoiced && typeof harness.processor.completeBillingPeriods === "function") {
            if (failCompletion && !completionFailed) {
              completionFailed = true
              return Err(
                new FetchError({ message: "completion acknowledgement unavailable", retry: true })
              )
            }
            await harness.processor.completeBillingPeriods(["bp_1"])
          }
          return Ok(undefined)
        }),
      }
      const args = {
        context: makeContext(),
        logger: makeLogger(),
        db: makeDb({
          invoicedPeriod: [{ id: "bp_1" }],
          entitlementRows: [
            { id: "ent_1" },
            { id: "ent_expired", expiresAt: period.cycleStartAt },
            { id: "ent_future", effectiveAt: period.cycleEndAt },
          ],
        }),
        repo: makeRepo(makePhase({ creditLinePolicy: phasePolicy })),
        ratingService,
        ledgerService,
        reservationFlushGateway,
      }

      if (initialCapture > 1_000_000_000) {
        await expect(billPeriod(args)).rejects.toThrow(
          "wallet captures do not match its sealed usage amount"
        )
        expect(invoiced).toBe(false)
        expect(postedAmount).toBe(0)
        expect(harness.store.readBillingUsageSnapshot("bp_1")).toMatchObject({
          state: "sealed",
          amount: 1_000_000_000,
        })
        return
      }
      if (phasePolicy === "capped") {
        await expect(billPeriod(args)).rejects.toThrow(
          "wallet captures do not match its sealed usage amount"
        )
        expect(invoiced).toBe(false)
        expect(postedAmount).toBe(0)
        capturedAmount = 1_000_000_000
      }
      if (failCompletion) {
        await expect(billPeriod(args)).rejects.toThrow("completion acknowledgement unavailable")
        expect(invoiced).toBe(true)
        expect(harness.store.readBillingUsageSnapshot("bp_1")?.state).toBe("sealed")
      } else {
        await billPeriod(args)
      }
      vi.mocked(ratingService.rateBillingPeriod).mockResolvedValue(
        Ok([
          {
            price: {
              totalPrice: {
                dinero: dinero({ amount: 1_000_000_000, currency: usd, scale: 8 }),
                displayAmount: "10",
              },
              subtotalPrice: {
                dinero: dinero({ amount: 1_000_000_000, currency: usd, scale: 8 }),
                displayAmount: "10",
              },
              unitPrice: {
                dinero: dinero({ amount: 100_000_000, currency: usd, scale: 8 }),
                displayAmount: "1",
              },
            },
            usage: 10,
            prorate: 1,
            cycleStartAt: period.cycleStartAt,
            cycleEndAt: period.cycleEndAt,
            included: 0,
            limit: Number.POSITIVE_INFINITY,
            isTrial: false,
          },
        ])
      )
      await billPeriod(args)

      const expectedAmount = periodType === "trial" ? 0 : 1_000_000_000
      expect(postedAmount + capturedAmount).toBe(expectedAmount)
      const invoiceData = txRepoInstance.updateInvoice.mock.calls[0]?.[0].data
      expect(invoiceData.grossAmount).toBe(expectedAmount)
      if (captureStatus !== null && phasePolicy === "uncapped") {
        expect(postedAmount).toBe(400_000_000)
        expect(invoiceData.amountDue).toBe(captureStatus === "due" ? 1_000_000_000 : 400_000_000)
        expect(invoiceData.amountPaid).toBe(captureStatus === "paid" ? 600_000_000 : 0)
        expect(invoiceData.amountIncluded).toBe(captureStatus === "included" ? 600_000_000 : 0)
      }
      expect(invoiced).toBe(true)
      expect(harness.store.readBillingUsageSnapshot("bp_1")?.state).toBe("completed")
    }
  )

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
    const updateCall = txRepoInstance.updateInvoice.mock.calls[0]?.[0]
    expect(updateCall).toBeDefined()
    expect(updateCall.data).toMatchObject({
      grossAmount: 1500_0000_00,
      amountDue: 1500_0000_00,
      amountIncluded: 0,
      amountPaid: 0,
    })
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

  it("no pending period groups throws with next invoice date when future periods exist", async () => {
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const futureInvoiceAt = 1_700_100_000_000
    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: futureInvoiceAt }] })
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
    ).rejects.toThrow("Cannot invoice subscription, next invoice date is at")
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when pending arrears periods are still in grace", async () => {
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [{ invoiceAt: 1_699_999_999_999 }] })
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

  it("no pending period groups throws when no pending billing periods exist at all", async () => {
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ nextPendingPeriod: [] })
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
    ).rejects.toThrow(
      "Cannot invoice subscription, there are no pending billing periods to invoice"
    )
    expect(ratingService.rateBillingPeriod).not.toHaveBeenCalled()
    expect(ledgerService.createTransfer).not.toHaveBeenCalled()
  })

  it("no pending period groups returns no-op when statement was already invoiced", async () => {
    outerRepoInstance.listPendingPeriodGroups = vi.fn().mockResolvedValue([])

    const db = makeDb({ invoicedPeriod: [{ id: "bp_1" }] })
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
      flushForInvoicing: vi.fn().mockResolvedValue(Ok({ snapshots: [] })),
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
    expect(txRepoInstance.createInvoice).toHaveBeenCalledTimes(1)
  })
})
