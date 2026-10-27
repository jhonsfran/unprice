import {
  type BillingUsageIdentity,
  type BillingUsageRegistration,
  type BillingUsageSnapshot,
  addBillingUsage,
  billingUsageIdentitySchema,
  billingUsageRegistrationSchema,
  completeBillingUsage,
  registerBillingUsage,
  sealBillingUsage,
} from "@unprice/services/billing"
import { DO_IDEMPOTENCY_TTL_MS } from "@unprice/services/entitlements"
import { findBillingPeriodAt } from "@unprice/services/ingestion"
import type { ApplyInput, BatchIdempotencyEntry } from "./contracts"
import type { EntitlementWindowStateOps } from "./ports"

type BillingEventInput = Pick<ApplyInput, "entitlement" | "projectId" | "customerId"> & {
  event: Pick<ApplyInput["event"], "timestamp">
}

export function hasRetainedBillingUsage(store: EntitlementWindowStateOps, now: number): boolean {
  return store
    .listBillingUsageSnapshots()
    .some(
      (snapshot) =>
        snapshot.state !== "completed" || now <= snapshot.completedAt + DO_IDEMPOTENCY_TTL_MS
    )
}

function assertIdentity(snapshot: BillingUsageSnapshot, identity: BillingUsageIdentity): void {
  const expected = billingUsageIdentitySchema.parse(identity)
  const actual = billingUsageIdentitySchema.parse(snapshot)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Billing period ${identity.billingPeriodId} identity does not match its registration`
    )
  }
}

export function registerBillingPeriods(
  store: EntitlementWindowStateOps,
  registrations: BillingUsageRegistration[]
): BillingUsageSnapshot[] {
  return registrations.map((raw) => {
    const registration = billingUsageRegistrationSchema.parse(raw)
    const existing = store.readBillingUsageSnapshot(registration.billingPeriodId)
    if (existing) {
      assertIdentity(existing, registration)
      return existing
    }
    const snapshot = registerBillingUsage(registration)
    store.writeBillingUsageSnapshot(snapshot)
    return snapshot
  })
}

export function planBillingEventSnapshot(
  store: EntitlementWindowStateOps,
  input: BillingEventInput,
  facts: BatchIdempotencyEntry["meterFacts"],
  staged?: ReadonlyMap<string, BillingUsageSnapshot>
): BillingUsageSnapshot | null {
  const entitlement = input.entitlement
  if (!entitlement.subscriptionId || entitlement.featureType !== "usage") return null
  const period = findBillingPeriodAt(entitlement.billingPeriods, input.event.timestamp)
  if (!period) throw new Error("Subscription usage requires a pending billing period")
  let snapshot =
    staged?.get(period.billingPeriodId) ?? store.readBillingUsageSnapshot(period.billingPeriodId)
  if (!snapshot)
    throw new Error(`Billing period ${period.billingPeriodId} has no complete usage registration`)
  if (
    snapshot.projectId !== input.projectId ||
    snapshot.customerId !== input.customerId ||
    snapshot.customerEntitlementId !== entitlement.customerEntitlementId ||
    snapshot.subscriptionId !== entitlement.subscriptionId ||
    snapshot.subscriptionItemId !== entitlement.subscriptionItemId ||
    snapshot.statementKey !== period.statementKey
  )
    throw new Error("Subscription usage does not match its registered billing period")

  const deltas =
    facts.length > 0
      ? facts.map((fact) => ({
          amount: fact.amount,
          quantity: fact.delta,
          currency: fact.currency,
          amountScale: fact.amount_scale,
          timestamp: fact.timestamp,
        }))
      : [
          {
            amount: 0,
            quantity: 0,
            currency: snapshot.currency,
            amountScale: snapshot.amountScale,
            timestamp: input.event.timestamp,
          },
        ]
  for (const delta of deltas) snapshot = addBillingUsage(snapshot, delta)
  return snapshot
}

export function recordBillingEvent(
  store: EntitlementWindowStateOps,
  input: BillingEventInput,
  facts: BatchIdempotencyEntry["meterFacts"]
): void {
  const snapshot = planBillingEventSnapshot(store, input, facts)
  if (snapshot) store.writeBillingUsageSnapshot(snapshot)
}

export function sealBillingPeriods(
  store: EntitlementWindowStateOps,
  identities: BillingUsageIdentity[],
  now: number
): BillingUsageSnapshot[] {
  return identities.map((identity) => {
    let snapshot = store.readBillingUsageSnapshot(identity.billingPeriodId)
    if (!snapshot)
      throw new Error(`Billing period ${identity.billingPeriodId} has unknown usage coverage`)
    if (
      snapshot.state === "open" &&
      identity.cycleEndAt < snapshot.cycleEndAt &&
      (snapshot.lastEventAt === null || snapshot.lastEventAt < identity.cycleEndAt)
    ) {
      snapshot = {
        ...snapshot,
        cycleEndAt: identity.cycleEndAt,
        statementKey: identity.statementKey,
      }
    }
    assertIdentity(snapshot, identity)
    const sealed = sealBillingUsage(snapshot, now)
    store.writeBillingUsageSnapshot(sealed)
    return sealed
  })
}

export function completeBillingPeriods(
  store: EntitlementWindowStateOps,
  periodIds: string[],
  now: number
): void {
  for (const periodId of periodIds) {
    const snapshot = store.readBillingUsageSnapshot(periodId)
    if (!snapshot) continue
    store.writeBillingUsageSnapshot(completeBillingUsage(snapshot, now))
  }
}
