import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  ReferenceBillingModel,
  type ReferenceUsageEvent,
  calculateReferenceProration,
} from "./reference-model"

const propertyRuns = Number.parseInt(process.env.UNPRICE_PROPERTY_RUNS ?? "75", 10)
const propertySeed = process.env.UNPRICE_PROPERTY_SEED
  ? Number.parseInt(process.env.UNPRICE_PROPERTY_SEED, 10)
  : undefined

const periodStart = Date.parse("2026-01-01T00:00:00.000Z")
const periodEnd = Date.parse("2026-02-01T00:00:00.000Z")
const oneDayMs = 24 * 60 * 60 * 1000
const eventTimestampArbitrary = fc.integer({
  min: periodStart - oneDayMs,
  max: periodEnd + oneDayMs,
})

function assertProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IProperty<Ts>,
  examples?: Ts[]
) {
  fc.assert(property, {
    examples,
    numRuns: propertyRuns,
    seed: propertySeed,
  })
}

function createUsageModel(input: {
  flatAmountCents: number
  includedUnits: number
  unitPriceCents: number
}) {
  const model = new ReferenceBillingModel()
  model.addCustomer({ id: "cus_test", currency: "EUR" })
  model.addPlan({
    id: "plan_test",
    currency: "EUR",
    whenToBill: "pay_in_arrear",
    features: [
      { id: "feat_access", slug: "access-pro", kind: "flat", amountCents: input.flatAmountCents },
      {
        id: "feat_events",
        slug: "events",
        kind: "usage",
        includedUnits: input.includedUnits,
        unitPriceCents: input.unitPriceCents,
      },
    ],
  })
  model.addSubscription({
    id: "sub_test",
    customerId: "cus_test",
    planId: "plan_test",
    startsAt: periodStart,
  })
  model.createBillingPeriod({
    subscriptionId: "sub_test",
    customerId: "cus_test",
    planId: "plan_test",
    periodStart,
    periodEnd,
  })
  return model
}

function usageEvent(input: {
  id: string
  occurredAt: number
  quantity: number
}): ReferenceUsageEvent {
  return {
    id: input.id,
    customerId: "cus_test",
    subscriptionId: "sub_test",
    featureSlug: "events",
    quantity: input.quantity,
    occurredAt: input.occurredAt,
  }
}

describe("ReferenceBillingModel properties", () => {
  it("accepts usage at most once per event id and only inside the active period", () => {
    const eventArbitrary = fc.record({
      id: fc.integer({ min: 1, max: 8 }).map((id) => `evt_${id}`),
      occurredAt: eventTimestampArbitrary,
      quantity: fc.integer({ min: 0, max: 10_000 }),
    })

    assertProperty(
      fc.property(fc.array(eventArbitrary, { maxLength: 40 }), (events) => {
        const model = createUsageModel({
          flatAmountCents: 9900,
          includedUnits: 1000,
          unitPriceCents: 2,
        })

        for (const event of events) {
          model.meterUsage(usageEvent(event))
        }

        const accepted = model.getAcceptedUsageEvents()
        const acceptedIds = accepted.map((event) => event.id)
        expect(new Set(acceptedIds).size).toBe(acceptedIds.length)
        expect(
          accepted.every((event) => periodStart <= event.occurredAt && event.occurredAt < periodEnd)
        ).toBe(true)

        const expectedUsage = accepted.reduce((sum, event) => sum + event.quantity, 0)
        expect(model.getMeteringState().acceptedUsageByFeature.events ?? 0).toBe(expectedUsage)
      }),
      [[[{ id: "evt_1", occurredAt: periodEnd, quantity: 1 }]]]
    )
  })

  it("computes invoices from accepted usage and remains idempotent on rerun", () => {
    const inputArbitrary = fc.record({
      flatAmountCents: fc.integer({ min: 0, max: 50_000 }),
      includedUnits: fc.integer({ min: 0, max: 5_000 }),
      unitPriceCents: fc.integer({ min: 0, max: 100 }),
      events: fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 12 }).map((id) => `evt_${id}`),
          occurredAt: eventTimestampArbitrary,
          quantity: fc.integer({ min: 0, max: 2_000 }),
        }),
        { maxLength: 50 }
      ),
    })

    assertProperty(
      fc.property(inputArbitrary, (input) => {
        const model = createUsageModel(input)

        for (const event of input.events) {
          model.meterUsage(usageEvent(event))
        }

        const invoice = model.billPeriod({ subscriptionId: "sub_test", periodStart, periodEnd })
        const invoiceAgain = model.billPeriod({
          subscriptionId: "sub_test",
          periodStart,
          periodEnd,
        })

        const acceptedUsage = model
          .getAcceptedUsageEvents()
          .reduce((sum, event) => sum + event.quantity, 0)
        const expectedUsageAmount =
          Math.max(0, acceptedUsage - input.includedUnits) * input.unitPriceCents
        const expectedFlatAmount = input.flatAmountCents > 0 ? input.flatAmountCents : 0

        expect(invoiceAgain).toBe(invoice)
        expect(model.getInvoices()).toHaveLength(1)
        expect(invoice.totalCents).toBe(expectedFlatAmount + expectedUsageAmount)
        expect(invoice.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(
          invoice.totalCents
        )
        expect(
          model.getLedgerMovements().reduce((sum, movement) => sum + movement.amountCents, 0)
        ).toBe(invoice.lines.reduce((sum, line) => sum + Math.max(0, line.amountCents), 0))
      }),
      [
        [
          {
            flatAmountCents: 9900,
            includedUnits: 1000,
            unitPriceCents: 2,
            events: [{ id: "evt_1", occurredAt: periodStart, quantity: 1200 }],
          },
        ],
      ]
    )
  })

  it("conserves wallet grant value across reservation, consumption, and release", () => {
    const inputArbitrary = fc
      .array(fc.integer({ min: 1, max: 50_000 }), {
        minLength: 1,
        maxLength: 6,
      })
      .chain((grantAmounts) => {
        const totalGrantAmount = grantAmounts.reduce((sum, amount) => sum + amount, 0)
        return fc.record({
          grantAmounts: fc.constant(grantAmounts),
          reserveAmount: fc.integer({ min: 1, max: totalGrantAmount }),
        })
      })
      .chain((input) =>
        fc
          .integer({ min: 0, max: input.reserveAmount })
          .map((consumeAmount) => ({ ...input, consumeAmount }))
      )

    assertProperty(
      fc.property(inputArbitrary, (input) => {
        const model = new ReferenceBillingModel()
        model.addCustomer({ id: "cus_test", currency: "EUR" })

        for (const [index, amountCents] of input.grantAmounts.entries()) {
          model.createCredit({
            id: `wcr_${index}`,
            customerId: "cus_test",
            currency: "EUR",
            amountCents,
            source: "credit_line",
          })
        }

        const reservation = model.reserveWallet({
          id: "res_test",
          customerId: "cus_test",
          currency: "EUR",
          amountCents: input.reserveAmount,
        })
        expect(reservation.status).toBe("reserved")

        if (input.consumeAmount > 0) {
          model.consumeWalletReservation({
            reservationId: "res_test",
            amountCents: input.consumeAmount,
          })
        }
        const releaseAmount = input.reserveAmount - input.consumeAmount
        if (releaseAmount > 0) {
          model.releaseWalletReservation({ reservationId: "res_test", amountCents: releaseAmount })
        }

        const totalGranted = input.grantAmounts.reduce((sum, amount) => sum + amount, 0)
        const wallet = model.getWalletState("cus_test", "EUR")
        expect(wallet.availableCents + wallet.reservedCents + wallet.consumedCents).toBe(
          totalGranted
        )
        expect(wallet.reservedCents).toBe(0)
        expect(wallet.consumedCents).toBe(input.consumeAmount)
        model.assertLedgerConservation()
      }),
      [
        [
          {
            grantAmounts: [10_000],
            reserveAmount: 3000,
            consumeAmount: 1200,
          },
        ],
      ]
    )
  })

  it("keeps proration bounded and internally balanced across supported granularities", () => {
    const inputArbitrary = fc.record({
      oldAmountCents: fc.integer({ min: 0, max: 1_000_000 }),
      newAmountCents: fc.integer({ min: 0, max: 1_000_000 }),
      changeAt: fc.integer({ min: periodStart - oneDayMs, max: periodEnd + oneDayMs }),
      granularity: fc.constantFrom("day", "week", "month", "year", "minute" as const),
    })

    assertProperty(
      fc.property(inputArbitrary, (input) => {
        const result = calculateReferenceProration({
          ...input,
          periodStart,
          periodEnd,
        })

        expect(result.oldCreditCents).toBeGreaterThanOrEqual(0)
        expect(result.newChargeCents).toBeGreaterThanOrEqual(0)
        expect(result.oldCreditCents).toBeLessThanOrEqual(input.oldAmountCents)
        expect(result.newChargeCents).toBeLessThanOrEqual(input.newAmountCents)
        expect(result.netProrationCents).toBe(result.newChargeCents - result.oldCreditCents)
        expect(result.remaining).toBeGreaterThanOrEqual(0)
        expect(result.remaining).toBeLessThanOrEqual(result.total)
      }),
      [
        [
          {
            oldAmountCents: 3100,
            newAmountCents: 6200,
            changeAt: Date.parse("2026-01-16T00:00:00.000Z"),
            granularity: "month",
          },
        ],
      ]
    )
  })
})
