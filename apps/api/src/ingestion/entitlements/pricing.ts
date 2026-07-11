import type { OverageStrategy } from "@unprice/db/validators"
import { LEDGER_SCALE } from "@unprice/money"
import {
  type Fact,
  type GrantConsumptionState,
  LATE_EVENT_GRACE_MS,
  computeGrantPeriodBucket,
  computeMeterTransition,
  computeUsagePriceDeltaExplanation,
  consumeGrantsByPriority,
  resolveAvailableGrantUnits,
} from "@unprice/services/entitlements"
import type {
  ActiveGrantInput,
  ApplyInput,
  EntitlementApplyMeterFact,
  EntitlementConfigInput,
  MeterIdentity,
  PricedFact,
} from "./contracts"
import type { MeterStateDraft } from "./meter-state-adapter"

type GrantConsumptionSnapshot = Readonly<GrantConsumptionState>
type ActiveGrantSnapshot = Readonly<ActiveGrantInput>

export function resolveTotalGrantUnits(grants: readonly ActiveGrantSnapshot[]): number | null {
  if (grants.some((grant) => grant.allowanceUnits === null)) {
    return null
  }

  return grants.reduce((total, grant) => total + (grant.allowanceUnits ?? 0), 0)
}

export function findGrantLimitExceededFact(params: {
  activeGrants: readonly ActiveGrantSnapshot[]
  entitlement: EntitlementConfigInput
  facts: readonly Fact[]
  overageStrategy: OverageStrategy
  states: readonly GrantConsumptionSnapshot[]
  timestamp: number
}): { available: number; fact: Fact } | null {
  if (params.overageStrategy === "always") {
    return null
  }

  let available = resolveAvailableGrantUnits({
    grants: [...params.activeGrants],
    states: params.states.map((state) => ({ ...state })),
    timestamp: params.timestamp,
  })

  if (available === Number.POSITIVE_INFINITY) {
    return null
  }

  for (const fact of params.facts) {
    if (fact.delta <= 0) {
      continue
    }

    if (params.overageStrategy === "last-call") {
      if (available <= 0) return { available, fact }
      available = Math.max(0, available - fact.delta)
      continue
    }

    if (fact.delta > available) {
      return { available, fact }
    }

    available -= fact.delta
  }

  return null
}

export function buildMeterFactPayload(params: {
  createdAt: number
  input: ApplyInput
  meter: MeterIdentity
  pricedFact: PricedFact
}): EntitlementApplyMeterFact {
  const { createdAt, input, meter, pricedFact } = params

  return {
    event_id: input.event.id,
    idempotency_key: input.idempotencyKey,
    workspace_id: input.event.source.workspaceId,
    project_id: input.projectId,
    customer_id: input.customerId,
    environment: input.event.source.environment,
    api_key_id: input.event.source.apiKeyId,
    source_type: input.event.source.sourceType,
    source_id: input.event.source.sourceId,
    source_name: input.event.source.sourceName,
    currency: pricedFact.currency,
    customer_entitlement_id: meter.customerEntitlementId,
    grant_id: pricedFact.grantId,
    feature_plan_version_id: pricedFact.featurePlanVersionId,
    feature_slug: pricedFact.featureSlug,
    period_key: pricedFact.periodKey,
    event_slug: input.event.slug,
    aggregation_method: meter.config.aggregationMethod,
    timestamp: input.event.timestamp,
    created_at: createdAt,
    delta: pricedFact.units,
    value_after: pricedFact.usageAfter,
    amount: pricedFact.amountMinor,
    amount_after: pricedFact.amountAfterMinor,
    amount_scale: LEDGER_SCALE,
    priced_at: createdAt,
    tier_index: pricedFact.tierIndex,
    tier_mode: pricedFact.tierMode,
    pricing_component_count: pricedFact.pricingComponentCount,
  }
}

export function priceFactsFromGrantStates(params: {
  activeGrants: readonly ActiveGrantSnapshot[]
  entitlement: EntitlementConfigInput
  eventTimestamp: number
  facts: readonly Fact[]
  grantStates: readonly GrantConsumptionSnapshot[]
}): {
  grantStates: readonly GrantConsumptionSnapshot[]
  pricedFacts: readonly PricedFact[]
  touchedStates: ReadonlyMap<string, GrantConsumptionSnapshot>
} {
  const pricedFacts: PricedFact[] = []
  const touchedStates = new Map<string, GrantConsumptionState>()
  const grantStates = params.grantStates.map((state) => ({ ...state }))
  const activeGrants = params.activeGrants.map((grant) => ({ ...grant }))
  const priceGrant = firstGrantByDrainOrder(activeGrants)

  for (const fact of params.facts) {
    if (fact.delta <= 0) {
      pricedFacts.push(
        priceFactWithEntitlement({
          entitlement: params.entitlement,
          fact,
          grant: priceGrant,
          timestamp: params.eventTimestamp,
        })
      )
      continue
    }

    const consumed = consumeGrantsByPriority({
      grants: activeGrants,
      states: grantStates,
      timestamp: params.eventTimestamp,
      units: fact.delta,
    })

    for (const allocation of consumed.allocations) {
      const deltaExplanation = computeUsagePriceDeltaExplanation({
        priceConfig: params.entitlement.featureConfig,
        usageAfter: allocation.usageAfter,
        usageBefore: allocation.usageBefore,
      })
      const amountAfterExplanation = computeUsagePriceDeltaExplanation({
        priceConfig: params.entitlement.featureConfig,
        usageAfter: allocation.usageAfter,
        usageBefore: 0,
      })

      pricedFacts.push({
        amountAfterMinor: amountAfterExplanation.amountMinor,
        amountMinor: deltaExplanation.amountMinor,
        currency: allocation.grant.currencyCode,
        fact,
        featurePlanVersionId: params.entitlement.featurePlanVersionId,
        featureSlug: params.entitlement.featureSlug,
        grantId: allocation.grant.grantId,
        periodKey: allocation.periodKey,
        pricingComponentCount: deltaExplanation.pricingComponentCount,
        tierIndex: deltaExplanation.tierIndex,
        tierMode: deltaExplanation.tierMode,
        usageAfter: allocation.usageAfter,
        usageBefore: allocation.usageBefore,
        units: allocation.units,
      })

      replaceGrantState(grantStates, allocation.nextState)
      touchedStates.set(allocation.nextState.bucketKey, allocation.nextState)
    }

    if (consumed.remaining > 0) {
      pricedFacts.push(
        priceFactWithEntitlement({
          entitlement: params.entitlement,
          fact,
          grant: priceGrant,
          timestamp: params.eventTimestamp,
        })
      )
    }
  }

  return { grantStates, pricedFacts, touchedStates }
}

function replaceGrantState(
  states: GrantConsumptionState[],
  nextState: GrantConsumptionState
): void {
  const index = states.findIndex((state) => state.bucketKey === nextState.bucketKey)
  if (index === -1) {
    states.push(nextState)
    return
  }
  states[index] = nextState
}

export function projectEventCostMinor(params: {
  activeGrants: readonly ActiveGrantSnapshot[]
  entitlement: EntitlementConfigInput
  event: ApplyInput["event"]
  eventTimestamp: number
  grantStates: readonly GrantConsumptionSnapshot[]
  meter: MeterIdentity
  meterState: Readonly<MeterStateDraft>
  /** Omit only when the caller intentionally defers timestamp validation. */
  validationTimeMs?: number
}): number {
  const transition = computeMeterTransition({
    currentState: params.meterState.exists
      ? {
          updatedAt: params.meterState.updatedAt ?? Number.NEGATIVE_INFINITY,
          value: params.meterState.usage,
        }
      : null,
    event: params.event,
    meterConfig: params.meter.config,
    ...(params.validationTimeMs === undefined ? {} : { validationTimeMs: params.validationTimeMs }),
  })
  if (!transition) {
    return 0
  }

  const { pricedFacts } = priceFactsFromGrantStates({
    activeGrants: params.activeGrants,
    entitlement: params.entitlement,
    eventTimestamp: params.eventTimestamp,
    facts: [transition.fact],
    grantStates: params.grantStates,
  })

  return pricedFacts.reduce((sum, fact) => sum + fact.amountMinor, 0)
}

export function priceFactWithEntitlement(params: {
  entitlement: EntitlementConfigInput
  fact: Fact
  grant: ActiveGrantSnapshot
  timestamp: number
}): PricedFact {
  const { entitlement, fact, grant, timestamp } = params
  const bucket = computeGrantPeriodBucket(grant, timestamp)
  if (!bucket) {
    throw new Error("Unable to resolve grant bucket for fact pricing")
  }

  const usageAfter = Math.max(0, fact.valueAfter)
  const usageBefore = Math.max(0, fact.valueAfter - fact.delta)
  const deltaExplanation = computeUsagePriceDeltaExplanation({
    priceConfig: entitlement.featureConfig,
    usageAfter,
    usageBefore,
  })
  const amountAfterExplanation = computeUsagePriceDeltaExplanation({
    priceConfig: entitlement.featureConfig,
    usageAfter,
    usageBefore: 0,
  })

  return {
    amountAfterMinor: amountAfterExplanation.amountMinor,
    amountMinor: deltaExplanation.amountMinor,
    currency: grant.currencyCode,
    fact,
    featurePlanVersionId: entitlement.featurePlanVersionId,
    featureSlug: entitlement.featureSlug,
    grantId: grant.grantId,
    periodKey: bucket.periodKey,
    pricingComponentCount: deltaExplanation.pricingComponentCount,
    tierIndex: deltaExplanation.tierIndex,
    tierMode: deltaExplanation.tierMode,
    usageAfter,
    usageBefore,
    units: fact.delta,
  }
}

export function firstGrantByDrainOrder(
  grants: readonly ActiveGrantSnapshot[]
): ActiveGrantSnapshot {
  const grant = [...grants].sort((left, right) => compareGrantDrainOrder(left, right))[0]
  if (!grant) {
    throw new Error("Expected at least one grant")
  }
  return grant
}

export function resolveLateClosedPeriod(params: {
  activeGrants: readonly ActiveGrantSnapshot[]
  eventTimestamp: number
  now: number
}): { lagMs: number; periodEndAt: number } | null {
  const grant = firstGrantByDrainOrder(params.activeGrants)
  const bucket = computeGrantPeriodBucket(grant, params.eventTimestamp)

  if (!bucket || bucket.end === Number.MAX_SAFE_INTEGER) {
    return null
  }

  const graceEndsAt = bucket.end + LATE_EVENT_GRACE_MS
  if (params.now <= graceEndsAt) {
    return null
  }

  return {
    lagMs: params.now - graceEndsAt,
    periodEndAt: bucket.end,
  }
}

export function compareGrantDrainOrder(
  left: Pick<ActiveGrantInput, "expiresAt" | "grantId" | "priority">,
  right: Pick<ActiveGrantInput, "expiresAt" | "grantId" | "priority">
): number {
  return (
    right.priority - left.priority ||
    (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY) ||
    left.grantId.localeCompare(right.grantId)
  )
}
