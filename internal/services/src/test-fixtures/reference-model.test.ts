import { describe, expect, it } from "vitest"
import { ReferenceBillingModel, calculateReferenceProration } from "./reference-model"

const periodStart = Date.parse("2026-01-01T00:00:00.000Z")
const periodEnd = Date.parse("2026-02-01T00:00:00.000Z")

function createModel() {
  const model = new ReferenceBillingModel()
  model.addCustomer({ id: "cus_test", currency: "EUR" })
  model.addPlan({
    id: "plan_test",
    currency: "EUR",
    whenToBill: "pay_in_arrear",
    features: [
      { id: "feat_access", slug: "access-pro", kind: "flat", amountCents: 9900 },
      {
        id: "feat_events",
        slug: "events",
        kind: "usage",
        includedUnits: 1000,
        unitPriceCents: 2,
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

describe("ReferenceBillingModel", () => {
  it("deduplicates accepted usage and applies period-end invoice math", () => {
    const model = createModel()
    const usage = {
      id: "evt_1",
      customerId: "cus_test",
      subscriptionId: "sub_test",
      featureSlug: "events",
      quantity: 1200,
      occurredAt: Date.parse("2026-01-15T12:00:00.000Z"),
    }

    expect(model.meterUsage(usage).status).toBe("accepted")
    expect(model.meterUsage(usage).status).toBe("duplicate")
    expect(
      model.meterUsage({
        ...usage,
        id: "evt_period_end",
        occurredAt: periodEnd,
      })
    ).toEqual({ status: "rejected", reason: "OUTSIDE_BILLING_PERIOD" })

    const invoice = model.billPeriod({ subscriptionId: "sub_test", periodStart, periodEnd })

    expect(invoice.totalCents).toBe(10_300)
    expect(invoice.lines).toEqual([
      expect.objectContaining({
        amountCents: 9900,
        featureSlug: "access-pro",
        kind: "flat",
      }),
      expect.objectContaining({
        amountCents: 400,
        featureSlug: "events",
        kind: "usage",
        quantity: 200,
      }),
    ])
    expect(model.getAcceptedUsageEvents()).toHaveLength(1)
    expect(model.getMeteringState()).toMatchObject({
      acceptedEventIds: ["evt_1"],
      acceptedUsageByFeature: { events: 1200 },
      rejectedEvents: [{ eventId: "evt_period_end", reason: "OUTSIDE_BILLING_PERIOD" }],
    })
  })

  it("is idempotent when billing the same period twice", () => {
    const model = createModel()

    const first = model.billPeriod({ subscriptionId: "sub_test", periodStart, periodEnd })
    const second = model.billPeriod({ subscriptionId: "sub_test", periodStart, periodEnd })

    expect(second).toBe(first)
    expect(model.getInvoices()).toHaveLength(1)
    expect(model.getLedgerMovements()).toHaveLength(1)
  })

  it("computes day-granularity prorations deterministically", () => {
    const result = calculateReferenceProration({
      oldAmountCents: 3100,
      newAmountCents: 6200,
      periodStart,
      periodEnd,
      changeAt: Date.parse("2026-01-16T18:30:00.000Z"),
      granularity: "month",
    })

    expect(result).toMatchObject({
      oldCreditCents: 1600,
      newChargeCents: 3200,
      netProrationCents: 1600,
    })
  })

  it("preserves wallet grant, reservation, and consumption totals", () => {
    const model = createModel()
    model.createCredit({
      id: "wcr_1",
      customerId: "cus_test",
      currency: "EUR",
      amountCents: 10_000,
      source: "credit_line",
    })

    const reservation = model.reserveWallet({
      id: "res_1",
      customerId: "cus_test",
      currency: "EUR",
      amountCents: 3000,
    })
    expect(reservation.status).toBe("reserved")

    model.consumeWalletReservation({ reservationId: "res_1", amountCents: 1200 })
    model.releaseWalletReservation({ reservationId: "res_1" })

    expect(model.getWalletState("cus_test")).toEqual({
      availableCents: 8800,
      consumedCents: 1200,
      reservedCents: 0,
    })
    model.assertLedgerConservation()
  })

  it("tracks subscription phases for lifecycle commands", () => {
    const model = createModel()
    model.addPlan({
      id: "plan_pro",
      currency: "EUR",
      whenToBill: "pay_in_arrear",
      features: [{ id: "feat_pro_access", slug: "access-pro", kind: "flat", amountCents: 19_900 }],
    })

    model.changeSubscriptionPlan({
      subscriptionId: "sub_test",
      planId: "plan_pro",
      effectiveAt: Date.parse("2026-01-16T00:00:00.000Z"),
    })

    expect(model.getSubscriptionPhases("sub_test")).toEqual([
      expect.objectContaining({
        id: "phase_sub_test_initial",
        endsAt: Date.parse("2026-01-16T00:00:00.000Z"),
        planId: "plan_test",
      }),
      expect.objectContaining({
        planId: "plan_pro",
        startsAt: Date.parse("2026-01-16T00:00:00.000Z"),
      }),
    ])
  })
})
