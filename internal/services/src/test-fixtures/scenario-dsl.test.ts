import { describe, expect, it } from "vitest"
import { assertLedgerInvariants, assertMeteringInvariants, scenario } from "./scenario-dsl"

const periodStart = Date.parse("2026-01-01T00:00:00.000Z")
const periodEnd = Date.parse("2026-02-01T00:00:00.000Z")

describe("billing scenario DSL", () => {
  it("runs a declarative golden-style scenario against the reference model", () => {
    const result = scenario("monthly usage with included quota and overage")
      .withFixtures(["base-project.sql", "plan-monthly-arrear.sql", "customer-active.sql"])
      .givenCustomer({ id: "cus_test", currency: "EUR" })
      .givenPlan({
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
      .givenSubscription({
        id: "sub_test",
        customerId: "cus_test",
        planId: "plan_test",
        startsAt: periodStart,
        periodStart,
        periodEnd,
      })
      .meterUsage({
        id: "evt_1",
        customerId: "cus_test",
        subscriptionId: "sub_test",
        featureSlug: "events",
        quantity: 1200,
        occurredAt: Date.parse("2026-01-15T12:00:00.000Z"),
      })
      .billPeriod(periodStart, periodEnd)
      .assertAfterEachStep(assertMeteringInvariants, assertLedgerInvariants)
      .expectInvoice({
        currency: "EUR",
        lines: [
          { kind: "flat", featureSlug: "access-pro", quantity: 1, amountCents: 9900 },
          { kind: "usage", featureSlug: "events", quantity: 200, amountCents: 400 },
        ],
        totalCents: 10_300,
      })
      .expectMetering({
        acceptedEventIds: ["evt_1"],
        acceptedUsageByFeature: { events: 1200 },
      })
      .expectLedger({
        movementCount: 2,
      })
      .runReferenceModel()

    expect(result.invoices).toHaveLength(1)
    expect(result.ledgerMovements).toHaveLength(2)
  })

  it("supports imperative clock, deterministic IDs, and wallet expectations", () => {
    const result = scenario("wallet credit reservation lifecycle")
      .givenCustomer({ id: "cus_test", currency: "EUR" })
      .at(periodStart)
      .step("create credit", (runtime) => {
        const creditId = runtime.id("wcr")
        if (creditId !== "wcr_0001") {
          throw new Error(`Expected deterministic credit ID wcr_0001, got ${creditId}`)
        }

        runtime.createCredit({
          id: creditId,
          customerId: "cus_test",
          currency: "EUR",
          amountCents: 10_000,
          source: "credit_line",
        })
      })
      .advanceClockBy(60_000)
      .step("reserve credit", (runtime) => {
        if (runtime.now() !== periodStart + 60_000) {
          throw new Error("Scenario clock did not advance")
        }

        const reservation = runtime.reserveWallet({
          id: runtime.id("res"),
          customerId: "cus_test",
          currency: "EUR",
          amountCents: 3000,
        })
        if (reservation.status !== "reserved") {
          throw new Error("Expected wallet reservation to succeed")
        }
      })
      .step("consume and release remaining credit", (runtime) => {
        runtime.consumeWalletReservation({ reservationId: "res_0001", amountCents: 1200 })
        runtime.releaseWalletReservation({ reservationId: "res_0001" })
      })
      .expectWallet({
        customerId: "cus_test",
        currency: "EUR",
        availableCents: 8800,
        reservedCents: 0,
        consumedCents: 1200,
      })
      .expectLedger({
        movementCount: 4,
        movements: [{ sourceType: "wallet_release", amountCents: 1800 }],
      })
      .runReferenceModel()

    expect(result.model.getWalletState("cus_test", "EUR")).toEqual({
      availableCents: 8800,
      consumedCents: 1200,
      reservedCents: 0,
    })
  })
})
