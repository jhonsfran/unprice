import {
  type AnalyticsEntitlementMeterFact,
  entitlementMeterFactSchemaV1,
} from "@unprice/analytics"
import {
  type CreditLinePolicy,
  type OverageStrategy,
  type ResetConfig,
  configFeatureSchema,
  creditLinePolicySchema,
  meterConfigSchema,
} from "@unprice/db/validators"
import { LEDGER_SCALE } from "@unprice/money"
import type { Fact, GrantConsumptionState, MeterConfig } from "@unprice/services/entitlements"
import type { IngestionRejectionReason } from "@unprice/services/ingestion"
import type { ReservationCloseReason } from "@unprice/services/wallet"
import { z } from "zod"
import { APPLY_BATCH_SIZE_LIMIT } from "./constants"

export class EntitlementWindowLimitExceededError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      available: number
    }
  ) {
    super(`Limit exceeded for meter ${params.meterKey}`)
    this.name = EntitlementWindowLimitExceededError.name
  }
}

// Raised when the wallet really cannot fund the current event. The DO converts
// this into a denied ApplyResult, persists the denial to the idempotency table,
// and returns WALLET_EMPTY so retries are stable.
export class EntitlementWindowWalletEmptyError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      meterSlug: string
      reservationId: string
      cost: number
      remaining: number
      eventTimestamp: number
    }
  ) {
    super(`Wallet empty for meter ${params.meterSlug} (reservation ${params.reservationId})`)
    this.name = EntitlementWindowWalletEmptyError.name
  }
}

// Raised from the SQLite transaction when the local reservation is too small
// for the current event. The caller can then do external wallet I/O outside the
// transaction, grow the reservation, and retry once before returning
// WALLET_EMPTY.
export class EntitlementWindowReservationUnderfundedError extends Error {
  constructor(
    public readonly params: {
      eventId: string
      meterKey: string
      meterSlug: string
      reservationId: string
      cost: number
      remaining: number
      eventTimestamp: number
    }
  ) {
    super(`Reservation underfunded for meter ${params.meterSlug}`)
    this.name = EntitlementWindowReservationUnderfundedError.name
  }
}

export class EntitlementWindowBatchSequentialReplayRequired extends Error {
  constructor(message: string) {
    super(message)
    this.name = EntitlementWindowBatchSequentialReplayRequired.name
  }
}

export type DeniedReason = Extract<
  IngestionRejectionReason,
  "LIMIT_EXCEEDED" | "WALLET_EMPTY" | "LATE_EVENT_CLOSED_PERIOD"
>

export type ApplyResult = {
  allowed: boolean
  deniedReason?: DeniedReason
  meterFacts?: AnalyticsEntitlementMeterFact[]
  message?: string
}

export type ApplyInnerOptions = {
  emitLog?: boolean
}

// Internal: bubbled out of the apply() transaction so the post-commit
// scheduler can fire `ctx.waitUntil(requestFlushAndRefill(...))` without
// holding the tx open. Amounts are pgledger scale-8 minor units.
export type RefillTrigger = {
  flushSeq: number
  flushAmount: number
  refillAmount: number
  effectiveAt: number
}

export type ReservationGrowthResult =
  | { kind: "already_funded" }
  | { kind: "refilled"; trigger: RefillTrigger }

export const entitlementApplyMeterFactSchema = z
  .object({
    event_id: z.string(),
    idempotency_key: z.string(),
    workspace_id: z.string(),
    project_id: z.string(),
    customer_id: z.string(),
    environment: z.string(),
    api_key_id: z.string().nullable().optional(),
    source_type: z.enum(["api_key", "system", "unknown"]),
    source_id: z.string(),
    source_name: z.string().nullable().optional(),
    currency: z.string().length(3),
    customer_entitlement_id: z.string(),
    grant_id: z.string(),
    feature_plan_version_id: z.string().nullable().optional(),
    feature_slug: z.string(),
    period_key: z.string(),
    event_slug: z.string(),
    aggregation_method: z.string(),
    timestamp: z.number(),
    created_at: z.number(),
    delta: z.number(),
    value_after: z.number(),
    // Signed integer at LEDGER_SCALE (8). Number (not bigint) — at scale 8,
    // Number.MAX_SAFE_INTEGER covers ~$90M per event, far beyond any plausible
    // per-event delta. Negative values represent corrections/refunds; clamping
    // belongs at invoicing.
    amount: z.number().int(),
    amount_after: z.number().int().optional(),
    amount_scale: z.literal(LEDGER_SCALE),
    priced_at: z.number().int(),
    tier_index: z.number().int().nullable(),
    tier_mode: z.enum(["volume", "graduated"]).nullable(),
    pricing_component_count: z.number().int().nonnegative(),
  })
  .transform((fact) => ({
    ...fact,
    amount_after: fact.amount_after ?? fact.amount,
  }))

const rawEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  timestamp: z.number().finite(),
  properties: z.record(z.unknown()),
  source: z.object({
    workspaceId: z.string().min(1),
    environment: z.string().min(1),
    apiKeyId: z.string().nullable(),
    sourceType: z.enum(["api_key", "system", "unknown"]),
    sourceId: z.string().min(1),
    sourceName: z.string().nullable(),
  }),
})

const overageStrategySchema = z.enum(["none", "last-call", "always"] satisfies readonly [
  OverageStrategy,
  ...OverageStrategy[],
])

const resetConfigSnapshotSchema = z.custom<ResetConfig>(
  (val) => val != null && typeof val === "object"
)

export const activeGrantSchema = z.object({
  allowanceUnits: z.number().finite().nullable(),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  grantId: z.string().min(1),
  priority: z.number().int(),
})

export const entitlementConfigSchema = z.object({
  creditLinePolicy: creditLinePolicySchema.default("uncapped"),
  customerEntitlementId: z.string().min(1),
  customerId: z.string().min(1),
  effectiveAt: z.number().finite(),
  expiresAt: z.number().finite().nullable(),
  featureConfig: configFeatureSchema,
  featurePlanVersionId: z.string().min(1),
  featureSlug: z.string().min(1),
  featureType: z.string().min(1),
  meterConfig: meterConfigSchema,
  overageStrategy: overageStrategySchema,
  projectId: z.string().min(1),
  resetConfig: resetConfigSnapshotSchema.nullable().optional(),
})

export const applyInputSchema = z.object({
  event: rawEventSchema,
  idempotencyKey: z.string().min(1),
  projectId: z.string().min(1),
  customerId: z.string().min(1),
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema).min(1),
  enforceLimit: z.boolean(),
  now: z.number().finite(),
})

const applyBatchEventSchema = rawEventSchema.extend({
  correlationKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
  now: z.number().finite(),
})

export const applyBatchInputSchema = applyInputSchema
  .omit({ event: true, idempotencyKey: true, now: true })
  .extend({
    events: z.array(applyBatchEventSchema).min(1).max(APPLY_BATCH_SIZE_LIMIT),
  })

export const enforcementStateInputSchema = z.object({
  entitlement: entitlementConfigSchema,
  grants: z.array(activeGrantSchema),
  now: z.number().finite(),
})

export const batchIdempotencyEntrySchema = z.object({
  eventId: z.string().min(1),
  createdAt: z.number().finite(),
  allowed: z.boolean(),
  deniedReason: z
    .enum(["LIMIT_EXCEEDED", "WALLET_EMPTY", "LATE_EVENT_CLOSED_PERIOD"] satisfies readonly [
      DeniedReason,
      ...DeniedReason[],
    ])
    .nullable(),
  denyMessage: z.string().nullable(),
  meterFacts: z.array(entitlementMeterFactSchemaV1).optional().default([]),
})

export const batchIdempotencyEntryListSchema = z.array(batchIdempotencyEntrySchema)

export const compactGrantConsumptionStateSchema = z.object({
  bucketKey: z.string().min(1),
  grantId: z.string().min(1),
  periodKey: z.string().min(1),
  periodStartAt: z.number().finite(),
  periodEndAt: z.number().finite(),
  consumedInCurrentWindow: z.number().finite(),
  exhaustedAt: z.number().finite().nullable(),
})

export const compactGrantConsumptionStateListSchema = z.array(compactGrantConsumptionStateSchema)

export type BatchIdempotencyEntry = z.infer<typeof batchIdempotencyEntrySchema>
export type ApplyInput = z.infer<typeof applyInputSchema>
export type ApplyBatchInput = z.infer<typeof applyBatchInputSchema>
export type ApplyGrantInput = z.infer<typeof activeGrantSchema>
export type ApplyBatchResultRow = ApplyResult & { correlationKey: string; idempotencyKey: string }

export type ApplyBatchMetrics = {
  duplicate_count: number
  grant_allocation_count: number
  grant_window_write_count: number
  idempotency_event_count: number
  idempotency_insert_count: number
  meter_state_write_count: number
  outbox_fact_count: number
  outbox_insert_count: number
  priced_fact_count: number
  wallet_reservation_write_count: number
}

export type ApplyBatchInternalResult = {
  results: ApplyBatchResultRow[]
  metrics: ApplyBatchMetrics
}

export function createApplyBatchMetrics(): ApplyBatchMetrics {
  return {
    duplicate_count: 0,
    grant_allocation_count: 0,
    grant_window_write_count: 0,
    idempotency_event_count: 0,
    idempotency_insert_count: 0,
    meter_state_write_count: 0,
    outbox_fact_count: 0,
    outbox_insert_count: 0,
    priced_fact_count: 0,
    wallet_reservation_write_count: 0,
  }
}

export const entitlementWindowStatusSchema = z.object({
  durableObjectId: z.string(),
  outboxCount: z.number().int(),
  nextAlarmAt: z.number().nullable(),
  lastIdempotencyCleanupAt: z.number().nullable(),
  walletReservation: z
    .object({
      reservationId: z.string().nullable(),
      projectId: z.string().nullable(),
      customerId: z.string().nullable(),
      currency: z.string().nullable(),
      reservationEndAt: z.number().nullable(),
      billingPeriodId: z.string().nullable(),
      featurePlanVersionItemId: z.string().nullable(),
      statementKey: z.string().nullable(),
      consumedAmount: z.number().int(),
      flushedAmount: z.number().int(),
      unflushedAmount: z.number().int(),
      allocationAmount: z.number().int(),
      refillInFlight: z.boolean(),
      flushSeq: z.number().int(),
      pendingFlushSeq: z.number().int().nullable(),
      pendingFlushFinal: z.boolean(),
      pendingFlushAmount: z.number().int().nullable(),
      pendingRefillAmount: z.number().int(),
      lastEventAt: z.number().nullable(),
      lastFlushedAt: z.number().nullable(),
      deletionRequested: z.boolean(),
      recoveryRequired: z.boolean(),
    })
    .nullable(),
})

export type EntitlementWindowStatus = z.infer<typeof entitlementWindowStatusSchema>
export type EnforcementStateInput = z.infer<typeof enforcementStateInputSchema>

export type ActiveGrantInput = ApplyGrantInput & {
  cadenceEffectiveAt: number
  cadenceExpiresAt: number | null
  currencyCode: string
  resetConfig: ResetConfig | null
}

export type EntitlementConfigInput = z.infer<typeof entitlementConfigSchema>
export type EntitlementCreditLinePolicy = CreditLinePolicy

export type MeterIdentity = {
  customerEntitlementId: string
  currency: string
  key: string
  config: MeterConfig
}

export type PricedFact = {
  amountAfterMinor: number
  amountMinor: number
  currency: string
  fact: Fact
  featurePlanVersionId: string
  featureSlug: string
  grantId: string
  periodKey: string
  pricingComponentCount: number
  tierIndex: number | null
  tierMode: "volume" | "graduated" | null
  usageAfter: number
  usageBefore: number
  units: number
}

export type CloseReservationResult =
  | {
      ok: true
      outcome: "already_reconciled" | "deferred" | "no_reservation" | "success"
      reason?: "deletion_requested" | "pending_wallet_flush" | "recovery_required"
    }
  | {
      errorMessage?: string
      ok: false
      outcome: "exception" | "wallet_error"
    }

export type CloseReservationOptions = {
  allowDeletionRequested?: boolean
  closeReason: ReservationCloseReason
  recoverPendingFinal?: boolean
}

export type EnforcementStateResult = {
  isLimitReached: boolean
  limit: number | null
  spending: {
    currency: string
    ledgerAmount: number
    scale: typeof LEDGER_SCALE
  }
  usage: number
}

export type EnforcementStateCache = {
  entitlement: EntitlementConfigInput | null
  grants: ActiveGrantInput[]
  inputSignature: string | null
  states: GrantConsumptionState[]
}

export type EntitlementApplyMeterFact = z.output<typeof entitlementApplyMeterFactSchema>

export type WalletReservationSnapshot = {
  projectId: string | null
  customerId: string | null
  currency: string
  reservationEndAt: number | null
  billingPeriodId: string | null
  featurePlanVersionItemId: string | null
  statementKey: string | null
  reservationId: string | null
  allocationAmount: number
  consumedAmount: number
  flushedAmount: number
  refillThresholdBps: number
  refillChunkAmount: number
  targetReservationAmount: number
  spendEwmaAmount: number
  lastRateSampledAtMs: number | null
  maxEventCostAmount: number
  pendingRefillAmount: number
  pendingFlushAmount: number | null
  refillInFlight: boolean
  flushSeq: number
  pendingFlushSeq: number | null
  pendingFlushFinal: boolean
  lastEventAt: number | null
  lastFlushedAt: number | null
  deletionRequested: boolean
  recoveryRequired: boolean
} | null
