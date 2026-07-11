import type { OverageStrategy } from "@unprice/db/validators"
import { LEDGER_SCALE } from "@unprice/money"
import {
  type Fact,
  type GrantConsumptionState,
  LATE_EVENT_GRACE_MS,
  computeGrantPeriodBucket,
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
import { replaceGrantConsumptionState } from "./entitlement-window-store"
import type { EntitlementWindowStateOps } from "./ports"

export function resolveTotalGrantUnits(grants: ActiveGrantInput[]): number | null {
  if (grants.some((grant) => grant.allowanceUnits === null)) {
    return null
  }

  return grants.reduce((total, grant) => total + (grant.allowanceUnits ?? 0), 0)
}

export function findGrantLimitExceededFact(params: {
  activeGrants: ActiveGrantInput[]
  entitlement: EntitlementConfigInput
  facts: Fact[]
  overageStrategy: OverageStrategy
  states: GrantConsumptionState[]
  timestamp: number
}): { available: number; fact: Fact } | null {
  if (params.overageStrategy === "always") {
    return null
  }

  let available = resolveAvailableGrantUnits({
    grants: params.activeGrants,
    states: params.states,
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

export function priceFactsFromCompactGrantState(
  tx: EntitlementWindowStateOps,
  params: {
    activeGrants: ActiveGrantInput[]
    entitlement: EntitlementConfigInput
    eventTimestamp: number
    facts: Fact[]
  }
): { periodWriteCount: number; pricedFacts: PricedFact[]; touchedStateCount: number } {
  const grantStates = params.facts.some((fact) => fact.delta > 0)
    ? tx.readGrantStatesForActiveGrants(params.activeGrants, params.eventTimestamp)
    : []
  const { pricedFacts, touchedStates } = priceFactsFromGrantStates({
    ...params,
    grantStates,
  })

  const periodWriteCount = tx.writeGrantConsumptions(touchedStates.values())

  return { periodWriteCount, pricedFacts, touchedStateCount: touchedStates.size }
}

export function priceFactsFromGrantStates(params: {
  activeGrants: ActiveGrantInput[]
  entitlement: EntitlementConfigInput
  eventTimestamp: number
  facts: Fact[]
  grantStates: GrantConsumptionState[]
}): {
  pricedFacts: PricedFact[]
  touchedStates: Map<string, GrantConsumptionState>
} {
  const pricedFacts: PricedFact[] = []
  const touchedStates = new Map<string, GrantConsumptionState>()
  const priceGrant = firstGrantByDrainOrder(params.activeGrants)

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
      grants: params.activeGrants,
      states: params.grantStates,
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

      replaceGrantConsumptionState(params.grantStates, allocation.nextState)
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

  return { pricedFacts, touchedStates }
}

export function priceFactWithEntitlement(params: {
  entitlement: EntitlementConfigInput
  fact: Fact
  grant: ActiveGrantInput
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

export function firstGrantByDrainOrder(grants: ActiveGrantInput[]): ActiveGrantInput {
  const grant = [...grants].sort((left, right) => compareGrantDrainOrder(left, right))[0]
  if (!grant) {
    throw new Error("Expected at least one grant")
  }
  return grant
}

export function resolveLateClosedPeriod(params: {
  activeGrants: ActiveGrantInput[]
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
