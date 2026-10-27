import { type CustomerEntitlement, currencySchema } from "@unprice/db/validators"
import { z } from "zod"
import { billingUsageGenesisSchema } from "../entitlements/billing-usage-genesis"
import { UnsupportedUsageCorrectionError } from "../entitlements/errors"

export const billingUsageIdentitySchema = z.object({
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  customerEntitlementId: z.string().min(1),
  subscriptionId: z.string().min(1),
  subscriptionPhaseId: z.string().min(1),
  subscriptionItemId: z.string().min(1),
  billingPeriodId: z.string().min(1),
  statementKey: z.string().min(1),
  featureSlug: z.string().min(1),
  cycleStartAt: z.number().int().safe(),
  cycleEndAt: z.number().int().safe(),
  currency: currencySchema,
  amountScale: z.literal(8),
})

export const billingUsageRegistrationSchema = billingUsageIdentitySchema.extend({
  genesis: billingUsageGenesisSchema,
  origin: z.literal("period_generation_v1"),
  registeredAt: z.number().int().safe(),
})

const totalsSchema = billingUsageRegistrationSchema.extend({
  amount: z.number().int().safe(),
  quantity: z.number().finite().safe(),
  lastEventAt: z.number().int().safe().nullable(),
})

export const billingUsageSnapshotSchema = z.discriminatedUnion("state", [
  totalsSchema.extend({ state: z.literal("open"), sealedAt: z.null(), completedAt: z.null() }),
  totalsSchema.extend({
    state: z.literal("sealed"),
    sealedAt: z.number().int().safe(),
    completedAt: z.null(),
  }),
  totalsSchema.extend({
    state: z.literal("completed"),
    sealedAt: z.number().int().safe(),
    completedAt: z.number().int().safe(),
  }),
])

export type BillingUsageIdentity = z.infer<typeof billingUsageIdentitySchema>
export type BillingUsageRegistration = z.infer<typeof billingUsageRegistrationSchema>
export type BillingUsageSnapshot = z.infer<typeof billingUsageSnapshotSchema>

export function ownsBillingUsagePeriod(
  entitlement: Pick<CustomerEntitlement, "effectiveAt" | "expiresAt">,
  period: Pick<BillingUsageIdentity, "cycleStartAt" | "cycleEndAt">
): boolean {
  return (
    entitlement.effectiveAt < period.cycleEndAt &&
    (entitlement.expiresAt === null || entitlement.expiresAt > period.cycleStartAt)
  )
}

export function registerBillingUsage(input: BillingUsageRegistration): BillingUsageSnapshot {
  const registration = billingUsageRegistrationSchema.parse(input)
  if (registration.genesis.customerEntitlementId !== registration.customerEntitlementId) {
    throw new Error("Billing usage genesis belongs to another entitlement")
  }
  if (registration.cycleEndAt <= registration.cycleStartAt) {
    throw new Error("Billing usage period must have a positive duration")
  }
  return {
    ...registration,
    amount: 0,
    quantity: 0,
    lastEventAt: null,
    state: "open",
    sealedAt: null,
    completedAt: null,
  }
}

export function addBillingUsage(
  snapshot: BillingUsageSnapshot,
  delta: {
    amount: number
    quantity: number
    currency: string
    amountScale: number
    timestamp: number
  }
): BillingUsageSnapshot {
  if (snapshot.state !== "open")
    throw new Error(`Billing period ${snapshot.billingPeriodId} is sealed`)
  if (delta.currency !== snapshot.currency || delta.amountScale !== snapshot.amountScale) {
    throw new Error("Billing usage currency or scale does not match its registered period")
  }
  if (delta.timestamp < snapshot.cycleStartAt || delta.timestamp >= snapshot.cycleEndAt) {
    throw new Error("Billing usage timestamp is outside its registered period")
  }
  if (snapshot.amount + delta.amount < 0) {
    throw new UnsupportedUsageCorrectionError(
      "Correction requires a credit for usage from an earlier billing period"
    )
  }
  return billingUsageSnapshotSchema.parse({
    ...snapshot,
    amount: snapshot.amount + delta.amount,
    quantity: snapshot.quantity + delta.quantity,
    lastEventAt: Math.max(snapshot.lastEventAt ?? delta.timestamp, delta.timestamp),
  })
}

export function sealBillingUsage(
  snapshot: BillingUsageSnapshot,
  now: number
): BillingUsageSnapshot {
  return snapshot.state === "open" ? { ...snapshot, state: "sealed", sealedAt: now } : snapshot
}

export function completeBillingUsage(
  snapshot: BillingUsageSnapshot,
  now: number
): BillingUsageSnapshot {
  if (snapshot.state === "open") throw new Error("Cannot complete an unsealed billing period")
  return snapshot.state === "sealed"
    ? { ...snapshot, state: "completed", completedAt: now }
    : snapshot
}
