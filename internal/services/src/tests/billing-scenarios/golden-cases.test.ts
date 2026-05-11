import { describe, expect, it } from "vitest"
import {
  assertLedgerInvariants,
  assertMeteringInvariants,
  scenario,
} from "../../test-fixtures/scenario-dsl"

const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const jan16 = Date.parse("2026-01-16T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const mar1 = Date.parse("2026-03-01T00:00:00.000Z")
const nextYear = Date.parse("2027-01-01T00:00:00.000Z")

type BillingMode =
  | "pay_in_arrear metered"
  | "pay_in_arrear capped wallet"
  | "pay_in_advance metered"
  | "reference-only policy"

function goldenCase(name: string, modes: BillingMode[], run: () => void) {
  it(`${name} [${modes.join(", ")}]`, run)
}

describe("billing golden cases against the reference model", () => {
  goldenCase("basic monthly subscription", ["pay_in_arrear metered"], () => {
    scenario("basic monthly subscription")
      .withFixtures(["base-project.sql", "plan-monthly-arrear.sql", "customer-active.sql"])
      .givenCustomer({ id: "cus_basic", currency: "EUR" })
      .givenPlan({
        id: "plan_basic",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_basic", slug: "basic-seat", kind: "flat", amountCents: 3100 }],
      })
      .givenSubscription({
        id: "sub_basic",
        customerId: "cus_basic",
        planId: "plan_basic",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .billPeriod(jan1, feb1, "sub_basic")
      .assertAfterEachStep(assertMeteringInvariants, assertLedgerInvariants)
      .expectInvoice({
        currency: "EUR",
        lines: [{ kind: "flat", featureSlug: "basic-seat", quantity: 1, amountCents: 3100 }],
        totalCents: 3100,
      })
      .expectLedger({ movementCount: 1 })
      .runReferenceModel()
  })

  goldenCase("usage-based overage", ["pay_in_arrear metered"], () => {
    scenario("usage over included quota")
      .givenCustomer({ id: "cus_usage", currency: "EUR" })
      .givenPlan({
        id: "plan_usage",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [
          { id: "feat_base", slug: "platform-access", kind: "flat", amountCents: 1000 },
          {
            id: "feat_api",
            slug: "api-calls",
            kind: "usage",
            includedUnits: 1000,
            unitPriceCents: 2,
          },
        ],
      })
      .givenSubscription({
        id: "sub_usage",
        customerId: "cus_usage",
        planId: "plan_usage",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .meterUsage({
        id: "evt_usage_1",
        customerId: "cus_usage",
        subscriptionId: "sub_usage",
        featureSlug: "api-calls",
        quantity: 1200,
        occurredAt: Date.parse("2026-01-15T12:00:00.000Z"),
      })
      .billPeriod(jan1, feb1, "sub_usage")
      .expectInvoice({
        currency: "EUR",
        lines: [
          { kind: "flat", featureSlug: "platform-access", quantity: 1, amountCents: 1000 },
          { kind: "usage", featureSlug: "api-calls", quantity: 200, amountCents: 400 },
        ],
        totalCents: 1400,
      })
      .expectMetering({
        acceptedEventIds: ["evt_usage_1"],
        acceptedUsageByFeature: { "api-calls": 1200 },
      })
      .expectLedger({ movementCount: 2 })
      .runReferenceModel()
  })

  goldenCase("upgrade mid-period", ["pay_in_arrear metered"], () => {
    const result = scenario("upgrade mid-period")
      .givenCustomer({ id: "cus_upgrade", currency: "EUR" })
      .givenPlan({
        id: "plan_basic",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_basic", slug: "seat", kind: "flat", amountCents: 3100 }],
      })
      .givenPlan({
        id: "plan_pro",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_pro", slug: "seat", kind: "flat", amountCents: 6200 }],
      })
      .givenSubscription({
        id: "sub_upgrade",
        customerId: "cus_upgrade",
        planId: "plan_basic",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .step("upgrade to pro and record proration", (runtime) => {
        runtime.changePlan({
          subscriptionId: "sub_upgrade",
          planId: "plan_pro",
          effectiveAt: jan16,
        })
        runtime.addProrationLines({
          subscriptionId: "sub_upgrade",
          periodStart: jan1,
          periodEnd: feb1,
          changeAt: jan16,
          oldAmountCents: 3100,
          newAmountCents: 6200,
          featureSlug: "seat",
        })
      })
      .billPeriod(jan1, feb1, "sub_upgrade")
      .expectInvoice({
        currency: "EUR",
        lines: [
          { kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 3100 },
          { kind: "proration_credit", featureSlug: "seat", amountCents: -1600 },
          { kind: "proration_charge", featureSlug: "seat", amountCents: 3200 },
        ],
        totalCents: 4700,
      })
      .expectLedger({ movementCount: 3 })
      .runReferenceModel()

    expect(result.model.getSubscriptionPhases("sub_upgrade")).toEqual([
      expect.objectContaining({ planId: "plan_basic", endsAt: jan16 }),
      expect.objectContaining({ planId: "plan_pro", startsAt: jan16 }),
    ])
  })

  goldenCase("downgrade mid-period", ["pay_in_arrear metered"], () => {
    scenario("downgrade mid-period")
      .givenCustomer({ id: "cus_downgrade", currency: "EUR" })
      .givenPlan({
        id: "plan_pro",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_pro", slug: "seat", kind: "flat", amountCents: 6200 }],
      })
      .givenPlan({
        id: "plan_basic",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_basic", slug: "seat", kind: "flat", amountCents: 3100 }],
      })
      .givenSubscription({
        id: "sub_downgrade",
        customerId: "cus_downgrade",
        planId: "plan_pro",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .step("downgrade to basic and record proration", (runtime) => {
        runtime.changePlan({
          subscriptionId: "sub_downgrade",
          planId: "plan_basic",
          effectiveAt: jan16,
        })
        runtime.addProrationLines({
          subscriptionId: "sub_downgrade",
          periodStart: jan1,
          periodEnd: feb1,
          changeAt: jan16,
          oldAmountCents: 6200,
          newAmountCents: 3100,
          featureSlug: "seat",
        })
      })
      .billPeriod(jan1, feb1, "sub_downgrade")
      .expectInvoice({
        currency: "EUR",
        lines: [
          { kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 6200 },
          { kind: "proration_credit", featureSlug: "seat", amountCents: -3200 },
          { kind: "proration_charge", featureSlug: "seat", amountCents: 1600 },
        ],
        totalCents: 4600,
      })
      .expectLedger({ movementCount: 3 })
      .runReferenceModel()
  })

  goldenCase("cancellation creates no future charge", ["pay_in_arrear metered"], () => {
    scenario("cancellation")
      .givenCustomer({ id: "cus_cancel", currency: "EUR" })
      .givenPlan({
        id: "plan_cancel",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_cancel", slug: "seat", kind: "flat", amountCents: 3100 }],
      })
      .givenSubscription({
        id: "sub_cancel",
        customerId: "cus_cancel",
        planId: "plan_cancel",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .step("cancel at the renewal boundary", (runtime) => {
        runtime.cancelSubscription({ subscriptionId: "sub_cancel", effectiveAt: feb1 })
      })
      .billPeriod(feb1, mar1, "sub_cancel")
      .expectInvoice({
        currency: "EUR",
        lines: [],
        totalCents: 0,
      })
      .expectLedger({ movementCount: 0 })
      .runReferenceModel()
  })

  goldenCase("trial ending creates the first paid invoice", ["pay_in_advance metered"], () => {
    scenario("trial ending")
      .givenCustomer({ id: "cus_trial", currency: "EUR" })
      .givenPlan({
        id: "plan_trial",
        currency: "EUR",
        whenToBill: "pay_in_advance",
        features: [{ id: "feat_trial", slug: "seat", kind: "flat", amountCents: 0 }],
      })
      .givenPlan({
        id: "plan_paid",
        currency: "EUR",
        whenToBill: "pay_in_advance",
        features: [{ id: "feat_paid", slug: "seat", kind: "flat", amountCents: 3100 }],
      })
      .givenSubscription({
        id: "sub_trial",
        customerId: "cus_trial",
        planId: "plan_trial",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .step("transition trial to paid", (runtime) => {
        runtime.changePlan({ subscriptionId: "sub_trial", planId: "plan_paid", effectiveAt: feb1 })
      })
      .billPeriod(feb1, mar1, "sub_trial")
      .expectInvoice({
        currency: "EUR",
        lines: [{ kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 3100 }],
        totalCents: 3100,
      })
      .expectLedger({ movementCount: 1 })
      .runReferenceModel()
  })

  goldenCase(
    "credit balance reduces the invoice and is conserved",
    ["pay_in_arrear capped wallet"],
    () => {
      scenario("credit balance")
        .givenCustomer({ id: "cus_credit", currency: "EUR" })
        .givenPlan({
          id: "plan_credit",
          currency: "EUR",
          whenToBill: "pay_in_arrear",
          features: [{ id: "feat_credit", slug: "seat", kind: "flat", amountCents: 5000 }],
        })
        .givenSubscription({
          id: "sub_credit",
          customerId: "cus_credit",
          planId: "plan_credit",
          startsAt: jan1,
          periodStart: jan1,
          periodEnd: feb1,
        })
        .step("grant and apply invoice credit", (runtime) => {
          runtime.createCredit({
            id: "wcr_invoice_credit",
            customerId: "cus_credit",
            currency: "EUR",
            amountCents: 2000,
            source: "promo",
          })
          runtime.applyCreditToPeriod({
            id: "invoice_credit",
            subscriptionId: "sub_credit",
            customerId: "cus_credit",
            currency: "EUR",
            periodStart: jan1,
            periodEnd: feb1,
            amountCents: 2000,
          })
        })
        .billPeriod(jan1, feb1, "sub_credit")
        .expectInvoice({
          currency: "EUR",
          lines: [
            { kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 5000 },
            { kind: "credit", amountCents: -2000 },
          ],
          totalCents: 3000,
        })
        .expectWallet({
          customerId: "cus_credit",
          currency: "EUR",
          availableCents: 0,
          reservedCents: 0,
          consumedCents: 2000,
        })
        .expectLedger({ movementCount: 5 })
        .runReferenceModel()
    }
  )

  goldenCase("late usage outside the statement is ignored", ["reference-only policy"], () => {
    scenario("late usage ignored")
      .givenCustomer({ id: "cus_late", currency: "EUR" })
      .givenPlan({
        id: "plan_late",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [
          { id: "feat_late_base", slug: "platform-access", kind: "flat", amountCents: 1000 },
          {
            id: "feat_late_api",
            slug: "api-calls",
            kind: "usage",
            includedUnits: 0,
            unitPriceCents: 2,
          },
        ],
      })
      .givenSubscription({
        id: "sub_late",
        customerId: "cus_late",
        planId: "plan_late",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .meterUsage({
        id: "evt_late_boundary",
        customerId: "cus_late",
        subscriptionId: "sub_late",
        featureSlug: "api-calls",
        quantity: 500,
        occurredAt: feb1,
      })
      .billPeriod(jan1, feb1, "sub_late")
      .expectInvoice({
        currency: "EUR",
        lines: [{ kind: "flat", featureSlug: "platform-access", quantity: 1, amountCents: 1000 }],
        totalCents: 1000,
      })
      .expectMetering({
        rejectedEventIds: ["evt_late_boundary"],
        acceptedUsageByFeature: { "api-calls": 0 },
      })
      .expectLedger({ movementCount: 1 })
      .runReferenceModel()
  })

  goldenCase("duplicate event is billed once", ["pay_in_arrear metered"], () => {
    scenario("duplicate event")
      .givenCustomer({ id: "cus_duplicate", currency: "EUR" })
      .givenPlan({
        id: "plan_duplicate",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [
          {
            id: "feat_duplicate_api",
            slug: "api-calls",
            kind: "usage",
            includedUnits: 0,
            unitPriceCents: 10,
          },
        ],
      })
      .givenSubscription({
        id: "sub_duplicate",
        customerId: "cus_duplicate",
        planId: "plan_duplicate",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .meterUsage({
        id: "evt_duplicate",
        customerId: "cus_duplicate",
        subscriptionId: "sub_duplicate",
        featureSlug: "api-calls",
        quantity: 3,
        occurredAt: Date.parse("2026-01-20T00:00:00.000Z"),
      })
      .meterUsage({
        id: "evt_duplicate",
        customerId: "cus_duplicate",
        subscriptionId: "sub_duplicate",
        featureSlug: "api-calls",
        quantity: 3,
        occurredAt: Date.parse("2026-01-20T00:00:00.000Z"),
      })
      .billPeriod(jan1, feb1, "sub_duplicate")
      .expectInvoice({
        currency: "EUR",
        lines: [{ kind: "usage", featureSlug: "api-calls", quantity: 3, amountCents: 30 }],
        totalCents: 30,
      })
      .expectMetering({
        acceptedEventIds: ["evt_duplicate"],
        acceptedUsageByFeature: { "api-calls": 3 },
      })
      .expectLedger({ movementCount: 1 })
      .runReferenceModel()
  })

  goldenCase("annual plan", ["pay_in_advance metered"], () => {
    scenario("annual plan")
      .givenCustomer({ id: "cus_annual", currency: "EUR" })
      .givenPlan({
        id: "plan_annual",
        currency: "EUR",
        whenToBill: "pay_in_advance",
        features: [
          { id: "feat_annual_base", slug: "annual-access", kind: "flat", amountCents: 120_000 },
          {
            id: "feat_annual_api",
            slug: "api-calls",
            kind: "usage",
            includedUnits: 10_000,
            unitPriceCents: 1,
          },
        ],
      })
      .givenSubscription({
        id: "sub_annual",
        customerId: "cus_annual",
        planId: "plan_annual",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: nextYear,
      })
      .meterUsage({
        id: "evt_annual_usage",
        customerId: "cus_annual",
        subscriptionId: "sub_annual",
        featureSlug: "api-calls",
        quantity: 12_000,
        occurredAt: Date.parse("2026-06-01T00:00:00.000Z"),
      })
      .billPeriod(jan1, nextYear, "sub_annual")
      .expectInvoice({
        currency: "EUR",
        lines: [
          { kind: "flat", featureSlug: "annual-access", quantity: 1, amountCents: 120_000 },
          { kind: "usage", featureSlug: "api-calls", quantity: 2000, amountCents: 2000 },
        ],
        totalCents: 122_000,
      })
      .expectLedger({ movementCount: 2 })
      .runReferenceModel()
  })

  goldenCase("multi-currency cases stay isolated", ["pay_in_arrear metered"], () => {
    const eur = scenario("EUR monthly")
      .givenCustomer({ id: "cus_eur", currency: "EUR" })
      .givenPlan({
        id: "plan_eur",
        currency: "EUR",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_eur", slug: "seat", kind: "flat", amountCents: 3100 }],
      })
      .givenSubscription({
        id: "sub_eur",
        customerId: "cus_eur",
        planId: "plan_eur",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .billPeriod(jan1, feb1, "sub_eur")
      .expectInvoice({
        currency: "EUR",
        lines: [{ kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 3100 }],
        totalCents: 3100,
      })
      .runReferenceModel()

    const usd = scenario("USD monthly")
      .givenCustomer({ id: "cus_usd", currency: "USD" })
      .givenPlan({
        id: "plan_usd",
        currency: "USD",
        whenToBill: "pay_in_arrear",
        features: [{ id: "feat_usd", slug: "seat", kind: "flat", amountCents: 4500 }],
      })
      .givenSubscription({
        id: "sub_usd",
        customerId: "cus_usd",
        planId: "plan_usd",
        startsAt: jan1,
        periodStart: jan1,
        periodEnd: feb1,
      })
      .billPeriod(jan1, feb1, "sub_usd")
      .expectInvoice({
        currency: "USD",
        lines: [{ kind: "flat", featureSlug: "seat", quantity: 1, amountCents: 4500 }],
        totalCents: 4500,
      })
      .runReferenceModel()

    expect(eur.ledgerMovements.every((movement) => movement.currency === "EUR")).toBe(true)
    expect(usd.ledgerMovements.every((movement) => movement.currency === "USD")).toBe(true)
  })
})
