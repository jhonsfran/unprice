import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  ReferenceBillingModel,
  type ReferenceCurrency,
  type ReferenceInvoice,
  type ReferenceUsageEvent,
} from "./reference-model"

const modelRuns = Number.parseInt(process.env.UNPRICE_MODEL_RUNS ?? "50", 10)
const modelSeed = process.env.UNPRICE_MODEL_SEED
  ? Number.parseInt(process.env.UNPRICE_MODEL_SEED, 10)
  : undefined

const jan1 = Date.parse("2026-01-01T00:00:00.000Z")
const jan16 = Date.parse("2026-01-16T00:00:00.000Z")
const feb1 = Date.parse("2026-02-01T00:00:00.000Z")
const oneDayMs = 24 * 60 * 60 * 1000
const customerId = "cus_model"
const subscriptionId = "sub_model"
const currency: ReferenceCurrency = "EUR"

type LifecycleRuntime = {
  creditSeq: number
  currentFlatAmountCents: number
  currentPlanId: string
  model: ReferenceBillingModel
}

type LifecycleCommand =
  | {
      type: "meter_usage"
      eventId: string
      occurredAt: number
      quantity: number
    }
  | {
      type: "bill_period"
      finalize: boolean
    }
  | {
      type: "change_plan"
      effectiveAt: number
      targetPlanId: "plan_basic" | "plan_pro"
    }
  | {
      type: "cancel"
      effectiveAt: number
    }
  | {
      type: "apply_credit"
      amountCents: number
    }
  | {
      type: "wallet_reservation"
      consumeCents: number
      grantCents: number
      reserveCents: number
    }
  | {
      type: "failed_wallet_release"
      grantCents: number
      reserveCents: number
    }

const lifecycleCommandArbitrary: fc.Arbitrary<LifecycleCommand> = fc.oneof(
  fc.record({
    type: fc.constant("meter_usage" as const),
    eventId: fc.integer({ min: 1, max: 12 }).map((id) => `evt_${id}`),
    occurredAt: fc.integer({ min: jan1 - oneDayMs, max: feb1 + oneDayMs }),
    quantity: fc.integer({ min: 0, max: 2_000 }),
  }),
  fc.record({
    type: fc.constant("bill_period" as const),
    finalize: fc.boolean(),
  }),
  fc.record({
    type: fc.constant("change_plan" as const),
    effectiveAt: fc.integer({ min: jan1, max: feb1 }),
    targetPlanId: fc.constantFrom("plan_basic" as const, "plan_pro" as const),
  }),
  fc.record({
    type: fc.constant("cancel" as const),
    effectiveAt: fc.integer({ min: jan1, max: feb1 }),
  }),
  fc.record({
    type: fc.constant("apply_credit" as const),
    amountCents: fc.integer({ min: 1, max: 10_000 }),
  }),
  fc
    .record({
      type: fc.constant("wallet_reservation" as const),
      grantCents: fc.integer({ min: 1, max: 20_000 }),
      reserveRatio: fc.float({ min: Math.fround(0.05), max: Math.fround(1), noNaN: true }),
      consumeRatio: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
    })
    .map(({ reserveRatio, consumeRatio, ...input }) => {
      const reserveCents = Math.max(1, Math.floor(input.grantCents * reserveRatio))
      return {
        ...input,
        reserveCents,
        consumeCents: Math.floor(reserveCents * consumeRatio),
      }
    }),
  fc.record({
    type: fc.constant("failed_wallet_release" as const),
    grantCents: fc.integer({ min: 1, max: 20_000 }),
    reserveCents: fc.integer({ min: 1, max: 20_000 }),
  })
)

function createLifecycleRuntime(): LifecycleRuntime {
  const model = new ReferenceBillingModel()
  model.addCustomer({ id: customerId, currency })
  model.addPlan({
    id: "plan_basic",
    currency,
    whenToBill: "pay_in_arrear",
    features: [
      { id: "feat_basic_access", slug: "seat", kind: "flat", amountCents: 3_100 },
      {
        id: "feat_basic_events",
        slug: "events",
        kind: "usage",
        includedUnits: 1_000,
        unitPriceCents: 2,
      },
    ],
  })
  model.addPlan({
    id: "plan_pro",
    currency,
    whenToBill: "pay_in_arrear",
    features: [
      { id: "feat_pro_access", slug: "seat", kind: "flat", amountCents: 6_200 },
      {
        id: "feat_pro_events",
        slug: "events",
        kind: "usage",
        includedUnits: 5_000,
        unitPriceCents: 1,
      },
    ],
  })
  model.addSubscription({
    id: subscriptionId,
    customerId,
    planId: "plan_basic",
    startsAt: jan1,
  })
  model.createBillingPeriod({
    subscriptionId,
    customerId,
    planId: "plan_basic",
    periodStart: jan1,
    periodEnd: feb1,
  })

  return {
    creditSeq: 0,
    currentFlatAmountCents: 3_100,
    currentPlanId: "plan_basic",
    model,
  }
}

function applyLifecycleCommand(runtime: LifecycleRuntime, command: LifecycleCommand) {
  switch (command.type) {
    case "meter_usage":
      runtime.model.meterUsage(usageEvent(command))
      return
    case "bill_period":
      runtime.model.billPeriod({
        subscriptionId,
        periodStart: jan1,
        periodEnd: feb1,
        finalize: command.finalize,
      })
      return
    case "change_plan":
      if (hasBilled(runtime)) return
      if (command.targetPlanId === runtime.currentPlanId) return
      runtime.model.changeSubscriptionPlan({
        subscriptionId,
        planId: command.targetPlanId,
        effectiveAt: command.effectiveAt,
      })
      runtime.model.addProrationLines({
        subscriptionId,
        periodStart: jan1,
        periodEnd: feb1,
        changeAt: command.effectiveAt,
        oldAmountCents: runtime.currentFlatAmountCents,
        newAmountCents: flatAmountForPlan(command.targetPlanId),
        featureSlug: "seat",
      })
      runtime.currentPlanId = command.targetPlanId
      runtime.currentFlatAmountCents = flatAmountForPlan(command.targetPlanId)
      return
    case "cancel":
      if (hasBilled(runtime)) return
      runtime.model.cancelSubscription({ subscriptionId, effectiveAt: command.effectiveAt })
      return
    case "apply_credit":
      if (hasBilled(runtime)) return
      runtime.creditSeq += 1
      runtime.model.createCredit({
        id: `wcr_credit_${runtime.creditSeq}`,
        customerId,
        currency,
        amountCents: command.amountCents,
        source: "promo",
      })
      runtime.model.applyCreditToPeriod({
        id: `credit_${runtime.creditSeq}`,
        subscriptionId,
        customerId,
        currency,
        periodStart: jan1,
        periodEnd: feb1,
        amountCents: command.amountCents,
      })
      return
    case "wallet_reservation": {
      runtime.creditSeq += 1
      const creditId = `wcr_res_${runtime.creditSeq}`
      const reservationId = `res_${runtime.creditSeq}`
      runtime.model.createCredit({
        id: creditId,
        customerId,
        currency,
        amountCents: command.grantCents,
        source: "credit_line",
      })
      const reservation = runtime.model.reserveWallet({
        id: reservationId,
        customerId,
        currency,
        amountCents: Math.min(command.reserveCents, command.grantCents),
      })
      expect(reservation.status).toBe("reserved")
      if (reservation.status !== "reserved") return

      if (command.consumeCents > 0) {
        runtime.model.consumeWalletReservation({
          reservationId,
          amountCents: Math.min(command.consumeCents, reservation.reservation.allocationCents),
        })
      }

      const releasable =
        reservation.reservation.allocationCents - reservation.reservation.consumedCents
      if (releasable > 0) {
        runtime.model.releaseWalletReservation({ reservationId, amountCents: releasable })
      }
      return
    }
    case "failed_wallet_release": {
      runtime.creditSeq += 1
      const reservationId = `res_failed_${runtime.creditSeq}`
      const grantCents = Math.max(command.grantCents, command.reserveCents)
      runtime.model.createCredit({
        id: `wcr_failed_${runtime.creditSeq}`,
        customerId,
        currency,
        amountCents: grantCents,
        source: "failure_probe",
      })
      const reservation = runtime.model.reserveWallet({
        id: reservationId,
        customerId,
        currency,
        amountCents: command.reserveCents,
      })
      expect(reservation.status).toBe("reserved")
      const before = runtime.model.getWalletState(customerId, currency)
      expect(() =>
        runtime.model.releaseWalletReservation({
          reservationId,
          amountCents: command.reserveCents + 1,
        })
      ).toThrow("Cannot release more than the unconsumed reservation")
      expect(runtime.model.getWalletState(customerId, currency)).toEqual(before)
      runtime.model.releaseWalletReservation({ reservationId })
      return
    }
  }
}

function assertLifecycleInvariants(runtime: LifecycleRuntime) {
  const acceptedEvents = runtime.model.getAcceptedUsageEvents()
  const acceptedIds = acceptedEvents.map((event) => event.id)
  expect(new Set(acceptedIds).size).toBe(acceptedIds.length)
  expect(acceptedEvents.every((event) => jan1 <= event.occurredAt && event.occurredAt < feb1)).toBe(
    true
  )
  expect(runtime.model.getMeteringState().acceptedUsageByFeature.events ?? 0).toBe(
    acceptedEvents.reduce((sum, event) => sum + event.quantity, 0)
  )

  for (const invoice of runtime.model.getInvoices()) {
    assertInvoiceInvariant(invoice)
  }

  const ledgerMovements = runtime.model.getLedgerMovements()
  const ledgerIds = ledgerMovements.map((movement) => movement.id)
  expect(new Set(ledgerIds).size).toBe(ledgerIds.length)
  expect(ledgerMovements.every((movement) => movement.amountCents > 0)).toBe(true)
  runtime.model.assertLedgerConservation()

  const wallet = runtime.model.getWalletState(customerId, currency)
  expect(wallet.availableCents).toBeGreaterThanOrEqual(0)
  expect(wallet.reservedCents).toBeGreaterThanOrEqual(0)
  expect(wallet.consumedCents).toBeGreaterThanOrEqual(0)

  const invoice = runtime.model.getInvoices()[0]
  if (invoice) {
    const ledgerCount = runtime.model.getLedgerMovements().length
    expect(runtime.model.billPeriod({ subscriptionId, periodStart: jan1, periodEnd: feb1 })).toBe(
      invoice
    )
    expect(runtime.model.getLedgerMovements()).toHaveLength(ledgerCount)
  }
}

function assertInvoiceInvariant(invoice: ReferenceInvoice) {
  expect(invoice.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(invoice.totalCents)
  expect(invoice.lines.every((line) => line.periodStart === invoice.periodStart)).toBe(true)
  expect(invoice.lines.every((line) => line.periodEnd === invoice.periodEnd)).toBe(true)
}

function flatAmountForPlan(planId: "plan_basic" | "plan_pro") {
  return planId === "plan_basic" ? 3_100 : 6_200
}

function hasBilled(runtime: LifecycleRuntime) {
  return runtime.model.getInvoices().length > 0
}

function usageEvent(
  command: Extract<LifecycleCommand, { type: "meter_usage" }>
): ReferenceUsageEvent {
  return {
    id: command.eventId,
    customerId,
    subscriptionId,
    featureSlug: "events",
    quantity: command.quantity,
    occurredAt: command.occurredAt,
  }
}

describe("ReferenceBillingModel stateful lifecycle commands", () => {
  it("preserves billing, metering, ledger, and wallet invariants after every command", () => {
    fc.assert(
      fc.property(fc.array(lifecycleCommandArbitrary, { maxLength: 60 }), (commands) => {
        const runtime = createLifecycleRuntime()

        for (const command of commands) {
          applyLifecycleCommand(runtime, command)
          assertLifecycleInvariants(runtime)
        }
      }),
      {
        examples: [
          [
            [
              { type: "meter_usage", eventId: "evt_1", occurredAt: jan16, quantity: 1_200 },
              { type: "change_plan", targetPlanId: "plan_pro", effectiveAt: jan16 },
              { type: "apply_credit", amountCents: 500 },
              { type: "bill_period", finalize: false },
              { type: "bill_period", finalize: true },
            ],
          ],
        ],
        numRuns: modelRuns,
        seed: modelSeed,
      }
    )
  })
})
