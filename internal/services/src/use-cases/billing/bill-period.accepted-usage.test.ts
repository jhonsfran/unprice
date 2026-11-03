import { Err, FetchError, Ok } from "@unprice/error"
import { dinero } from "dinero.js"
import { describe, expect, it, vi } from "vitest"
import { applyInputSchema } from "../../../../../apps/api/src/ingestion/entitlements/contracts"
import { createApplyInput } from "../../../../../apps/api/src/ingestion/entitlements/entitlement-window-test-fixtures"
import { InMemoryEntitlementWindowStore } from "../../../../../apps/api/src/ingestion/entitlements/testing/in-memory-store"
import { createEntitlementWindowProcessorHarness } from "../../../../../apps/api/src/ingestion/entitlements/testing/processor-contract"
import type { LedgerGateway } from "../../ledger"
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

async function createCase(
  options: {
    periodType?: "normal" | "trial"
    failCompletion?: boolean
    funding?: { policy: "capped" | "uncapped"; status: "paid" | "due" | "included"; amount: number }
  } = {}
) {
  const periodType = options.periodType ?? "normal"
  const failCompletion = options.failCompletion ?? false
  const phasePolicy = options.funding?.policy ?? "uncapped"
  const captureStatus = options.funding?.status ?? null
  const initialCapture = options.funding?.amount ?? 0
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
  repositories.tx.listPendingPeriodsForStatement.mockResolvedValue([period])
  const state = {
    invoiced: false,
    completionFailed: false,
    postedAmount: 0,
    capturedAmount: initialCapture,
  }
  repositories.outer.listPendingPeriodGroups.mockImplementation(async () =>
    state.invoiced ? [] : [makePeriodGroup()]
  )
  repositories.tx.listPendingPeriodGroups = repositories.outer.listPendingPeriodGroups
  repositories.tx.markPeriodsInvoiced.mockImplementation(async () => {
    state.invoiced = true
  })
  const ratingService = makeRatingService(Ok([]))
  const ledgerService = makeLedgerService({
    createTransfer: vi.fn(async (input) => {
      state.postedAmount += input.amount.toJSON().amount
      return Ok({ transferId: "xfer_1" })
    }),
    getInvoiceLines: vi.fn(async () =>
      Ok(
        [
          ...(state.capturedAmount === 0
            ? []
            : [{ amount: state.capturedAmount, flow: "capture", status: captureStatus }]),
          ...(state.postedAmount === 0
            ? []
            : [{ amount: state.postedAmount, flow: "subscription", status: "due" }]),
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
    registeredAt: eventAt,
  }
  await harness.processor.registerBillingPeriods([registration])
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
        snapshots: await harness.processor.sealBillingPeriods([registration]),
        flushed: 0,
        skipped: 0,
      })
    ),
    completeForInvoicing: vi.fn(async () => {
      if (state.invoiced) {
        if (failCompletion && !state.completionFailed) {
          state.completionFailed = true
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

  return { args, harness, period, state }
}

type UsageCase = Awaited<ReturnType<typeof createCase>>

function makeReportingVisible(fixture: UsageCase) {
  vi.mocked(fixture.args.ratingService.rateBillingPeriod).mockResolvedValue(
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
        cycleStartAt: fixture.period.cycleStartAt,
        cycleEndAt: fixture.period.cycleEndAt,
        included: 0,
        limit: Number.POSITIVE_INFINITY,
        isTrial: false,
      },
    ])
  )
}

function expectCompletedInvoice(fixture: UsageCase, amount: number) {
  expect(fixture.state.postedAmount + fixture.state.capturedAmount).toBe(amount)
  expect(repositories.tx.updateInvoice.mock.calls[0]?.[0].data.grossAmount).toBe(amount)
  expect(fixture.state.invoiced).toBe(true)
  expect(fixture.harness.store.readBillingUsageSnapshot("bp_1")?.state).toBe("completed")
}

describe("billing accepted durable usage", () => {
  it.each([
    ["normal", 1_000_000_000],
    ["trial", 0],
  ] as const)(
    "invoices a %s period despite delayed reporting",
    async (periodType, expectedAmount) => {
      const fixture = await createCase({ periodType })
      await billPeriod(fixture.args)
      makeReportingVisible(fixture)
      await billPeriod(fixture.args)
      expectCompletedInvoice(fixture, expectedAmount)
    }
  )

  it("retries completion after the invoice commits without posting again", async () => {
    const fixture = await createCase({ failCompletion: true })
    await expect(billPeriod(fixture.args)).rejects.toThrow("completion acknowledgement unavailable")
    expect(fixture.state.invoiced).toBe(true)
    expect(fixture.harness.store.readBillingUsageSnapshot("bp_1")?.state).toBe("sealed")
    makeReportingVisible(fixture)
    await billPeriod(fixture.args)
    expectCompletedInvoice(fixture, 1_000_000_000)
    expect(fixture.args.ledgerService.createTransfer).toHaveBeenCalledTimes(1)
  })

  it("keeps a capped period pending until its full accepted amount is captured", async () => {
    const fixture = await createCase({
      funding: { policy: "capped", status: "due", amount: 600_000_000 },
    })
    await expect(billPeriod(fixture.args)).rejects.toThrow(
      "wallet captures do not match its sealed usage amount"
    )
    expect(fixture.state.invoiced).toBe(false)
    expect(fixture.state.postedAmount).toBe(0)
    fixture.state.capturedAmount = 1_000_000_000
    await billPeriod(fixture.args)
    makeReportingVisible(fixture)
    await billPeriod(fixture.args)
    expectCompletedInvoice(fixture, 1_000_000_000)
  })

  it.each([
    ["paid", 400_000_000, 600_000_000, 0],
    ["due", 1_000_000_000, 0, 0],
    ["included", 400_000_000, 0, 600_000_000],
  ] as const)(
    "bills the uncaptured remainder after %s funding",
    async (status, amountDue, amountPaid, amountIncluded) => {
      const fixture = await createCase({
        funding: { policy: "uncapped", status, amount: 600_000_000 },
      })
      await billPeriod(fixture.args)
      makeReportingVisible(fixture)
      await billPeriod(fixture.args)
      expectCompletedInvoice(fixture, 1_000_000_000)
      expect(fixture.state.postedAmount).toBe(400_000_000)
      expect(repositories.tx.updateInvoice.mock.calls[0]?.[0].data).toMatchObject({
        amountDue,
        amountPaid,
        amountIncluded,
      })
    }
  )

  it("refuses captured money above the accepted amount", async () => {
    const fixture = await createCase({
      funding: { policy: "uncapped", status: "due", amount: 1_100_000_000 },
    })
    await expect(billPeriod(fixture.args)).rejects.toThrow(
      "wallet captures do not match its sealed usage amount"
    )
    expect(fixture.state.invoiced).toBe(false)
    expect(fixture.state.postedAmount).toBe(0)
    expect(fixture.harness.store.readBillingUsageSnapshot("bp_1")).toMatchObject({
      state: "sealed",
      amount: 1_000_000_000,
    })
  })
})
