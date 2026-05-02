import {
  type ConfigFeatureVersionType,
  type OverageStrategy,
  type ResetConfig,
  calculateCycleWindow,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { diffLedgerMinor } from "@unprice/money"

const GRANT_PRICING_FEATURE_TYPE = "usage" as const

export type GrantConsumptionGrant = {
  amount: number | null
  anchor: number
  effectiveAt: number
  expiresAt: number | null
  grantId: string
  priority: number
  resetConfig?: ResetConfig | null
}

export type GrantConsumptionState = {
  bucketKey: string
  consumedInCurrentWindow: number
  exhaustedAt: number | null
  grantId: string
  periodEndAt: number
  periodKey: string
  periodStartAt: number
}

export type GrantConsumptionAllocation<TGrant extends GrantConsumptionGrant> = {
  grant: TGrant
  nextState: GrantConsumptionState
  periodKey: string
  units: number
  usageAfter: number
  usageBefore: number
}

export type GrantConsumptionResult<TGrant extends GrantConsumptionGrant> = {
  allocations: GrantConsumptionAllocation<TGrant>[]
  remaining: number
}

export type GrantPolicyGrant = GrantConsumptionGrant & {
  currencyCode: string
  meterHash: string
  overageStrategy: OverageStrategy
}

export function consumeGrantsByPriority<TGrant extends GrantConsumptionGrant>(params: {
  grants: TGrant[]
  states: GrantConsumptionState[]
  timestamp: number
  units: number
}): GrantConsumptionResult<TGrant> {
  if (params.units <= 0) {
    return { allocations: [], remaining: params.units }
  }

  const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
  const eligible = params.grants
    .map((grant) => {
      const bucket = computeGrantPeriodBucket(grant, params.timestamp)
      if (!bucket) return null
      return {
        grant,
        state:
          statesByBucketKey.get(bucket.bucketKey) ??
          createEmptyGrantState({
            grantId: grant.grantId,
            bucket,
          }),
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => compareGrantDrainOrder(left.grant, right.grant))

  let remaining = params.units
  const allocations: GrantConsumptionAllocation<TGrant>[] = []

  for (const { grant, state } of eligible) {
    if (remaining <= 0) {
      break
    }

    const available =
      grant.amount === null
        ? Number.POSITIVE_INFINITY
        : grant.amount - state.consumedInCurrentWindow

    if (available <= 0) {
      continue
    }

    const units = Math.min(remaining, available)
    const allocation = allocateUnits({ grant, state, timestamp: params.timestamp, units })
    allocations.push(allocation)
    statesByBucketKey.set(state.bucketKey, allocation.nextState)
    remaining -= units
  }

  if (remaining > 0 && eligible.length > 0) {
    const { grant } = eligible[0]!
    const state = statesByBucketKey.get(eligible[0]!.state.bucketKey) ?? eligible[0]!.state
    const allocation = allocateUnits({
      grant,
      state,
      timestamp: params.timestamp,
      units: remaining,
    })
    allocations.push(allocation)
    remaining = 0
  }

  return { allocations, remaining }
}

export function computeGrantPeriodBucket(
  grant: Pick<
    GrantConsumptionGrant,
    "anchor" | "effectiveAt" | "expiresAt" | "grantId" | "resetConfig"
  >,
  timestamp: number
): { bucketKey: string; end: number; periodKey: string; start: number } | null {
  const config = grant.resetConfig
    ? {
        name: grant.resetConfig.name,
        interval: grant.resetConfig.resetInterval,
        intervalCount: grant.resetConfig.resetIntervalCount,
        anchor: grant.anchor,
        planType: grant.resetConfig.planType,
      }
    : {
        name: "ingestion",
        interval: "onetime" as const,
        intervalCount: 1,
        anchor: "dayOfCreation" as const,
        planType: "onetime" as const,
      }

  const cycle = calculateCycleWindow({
    now: timestamp,
    effectiveStartDate: grant.effectiveAt,
    effectiveEndDate: grant.expiresAt,
    trialEndsAt: null,
    config,
  })

  if (!cycle) return null

  const periodKey = `${config.interval}:${cycle.start}`
  return {
    bucketKey: `${grant.grantId}:${periodKey}`,
    periodKey,
    start: cycle.start,
    end: Number.isFinite(cycle.end) ? cycle.end : Number.MAX_SAFE_INTEGER,
  }
}

export function resolveActiveGrants<TGrant extends GrantConsumptionGrant>(
  grants: TGrant[],
  timestamp: number
): TGrant[] {
  return grants
    .filter(
      (grant) =>
        grant.effectiveAt <= timestamp && (grant.expiresAt === null || timestamp < grant.expiresAt)
    )
    .sort(compareGrantDrainOrder)
}

export function resolveGrantOverageStrategy<TGrant extends { overageStrategy: OverageStrategy }>(
  grants: TGrant[]
): OverageStrategy {
  if (grants.some((grant) => grant.overageStrategy === "always")) {
    return "always"
  }

  if (grants.some((grant) => grant.overageStrategy === "last-call")) {
    return "last-call"
  }

  return "none"
}

export function validateGrantBatch<
  TGrant extends Pick<GrantPolicyGrant, "currencyCode" | "meterHash">,
>(grants: TGrant[]): void {
  const currencies = new Set(grants.map((grant) => grant.currencyCode))
  if (currencies.size > 1) {
    throw new Error("Mixed-currency grants are not supported for one entitlement window")
  }

  const meterHashes = new Set(grants.map((grant) => grant.meterHash))
  if (meterHashes.size > 1) {
    throw new Error("Mixed meter hashes are not supported for one entitlement window")
  }
}

export function mergeGrantExpiry(current: number | null, incoming: number | null): number | null {
  if (incoming === null) return current
  if (current === null) return incoming
  return Math.min(current, incoming)
}

export function resolveAvailableGrantUnits<TGrant extends GrantConsumptionGrant>(params: {
  grants: TGrant[]
  states: GrantConsumptionState[]
  timestamp: number
}): number {
  const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
  let available = 0

  for (const grant of params.grants) {
    if (grant.amount === null) {
      return Number.POSITIVE_INFINITY
    }

    const bucket = computeGrantPeriodBucket(grant, params.timestamp)
    if (!bucket) {
      continue
    }

    const consumed = statesByBucketKey.get(bucket.bucketKey)?.consumedInCurrentWindow ?? 0
    available += Math.max(0, grant.amount - consumed)
  }

  return available
}

export function resolveConsumedGrantUnits<TGrant extends GrantConsumptionGrant>(params: {
  grants: TGrant[]
  states: GrantConsumptionState[]
  timestamp: number
}): number {
  const statesByBucketKey = new Map(params.states.map((state) => [state.bucketKey, state]))
  let consumed = 0

  for (const grant of params.grants) {
    const bucket = computeGrantPeriodBucket(grant, params.timestamp)
    if (!bucket) {
      continue
    }

    consumed += statesByBucketKey.get(bucket.bucketKey)?.consumedInCurrentWindow ?? 0
  }

  return consumed
}

export function computeUsagePriceDeltaMinor(params: {
  priceConfig: ConfigFeatureVersionType
  usageAfter: number
  usageBefore: number
}): number {
  const usageAfter = Math.max(0, params.usageAfter)
  const usageBefore = Math.max(0, params.usageBefore)

  const beforeResult = calculatePricePerFeature({
    quantity: usageBefore,
    featureType: GRANT_PRICING_FEATURE_TYPE,
    config: params.priceConfig,
  })

  if (beforeResult.err) {
    throw beforeResult.err
  }

  const afterResult = calculatePricePerFeature({
    quantity: usageAfter,
    featureType: GRANT_PRICING_FEATURE_TYPE,
    config: params.priceConfig,
  })

  if (afterResult.err) {
    throw afterResult.err
  }

  return diffLedgerMinor(afterResult.val.totalPrice.dinero, beforeResult.val.totalPrice.dinero)
}

export function computeMaxMarginalPriceMinor(priceConfig: ConfigFeatureVersionType): number {
  let maxMarginal = probeMarginalPriceMinor(priceConfig, 0, 1)
  const tiers = "tiers" in priceConfig && Array.isArray(priceConfig.tiers) ? priceConfig.tiers : []

  for (const tier of tiers) {
    const firstUnit = tier?.firstUnit
    if (typeof firstUnit !== "number" || firstUnit < 1) continue

    const crossing = probeMarginalPriceMinor(priceConfig, firstUnit - 1, firstUnit)
    if (crossing > maxMarginal) {
      maxMarginal = crossing
    }
  }

  return maxMarginal
}

function probeMarginalPriceMinor(
  priceConfig: ConfigFeatureVersionType,
  usageBefore: number,
  usageAfter: number
): number {
  try {
    return computeUsagePriceDeltaMinor({ priceConfig, usageBefore, usageAfter })
  } catch {
    return 0
  }
}

function createEmptyGrantState(params: {
  bucket: { bucketKey: string; end: number; periodKey: string; start: number }
  grantId: string
}): GrantConsumptionState {
  return {
    bucketKey: params.bucket.bucketKey,
    consumedInCurrentWindow: 0,
    exhaustedAt: null,
    grantId: params.grantId,
    periodEndAt: params.bucket.end,
    periodKey: params.bucket.periodKey,
    periodStartAt: params.bucket.start,
  }
}

function allocateUnits<TGrant extends GrantConsumptionGrant>(params: {
  grant: TGrant
  state: GrantConsumptionState
  timestamp: number
  units: number
}): GrantConsumptionAllocation<TGrant> {
  const usageBefore = params.state.consumedInCurrentWindow
  const usageAfter = usageBefore + params.units

  return {
    grant: params.grant,
    nextState: {
      ...params.state,
      consumedInCurrentWindow: usageAfter,
      exhaustedAt:
        params.grant.amount !== null && usageAfter >= params.grant.amount
          ? params.timestamp
          : params.state.exhaustedAt,
    },
    periodKey: params.state.periodKey,
    units: params.units,
    usageAfter,
    usageBefore,
  }
}

function compareGrantDrainOrder(
  left: Pick<GrantConsumptionGrant, "expiresAt" | "grantId" | "priority">,
  right: Pick<GrantConsumptionGrant, "expiresAt" | "grantId" | "priority">
): number {
  return (
    right.priority - left.priority ||
    (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY) ||
    left.grantId.localeCompare(right.grantId)
  )
}
