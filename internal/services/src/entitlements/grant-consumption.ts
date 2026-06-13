import {
  type ConfigFeatureVersionType,
  type OverageStrategy,
  type ResetConfig,
  calculateCycleWindow,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { diffLedgerMinor } from "@unprice/money"

const GRANT_PRICING_FEATURE_TYPE = "usage" as const
type GrantPricingFeatureType = "flat" | "package" | "tier" | "usage"

export type UsagePriceDeltaExplanation = {
  amountMinor: number
  usageBefore: number
  usageAfter: number
  tierMode: "volume" | "graduated" | null
  tierIndex: number | null
  pricingComponentCount: number
}

export type GrantConsumptionGrant = {
  allowanceUnits: number | null
  cadenceEffectiveAt?: number
  cadenceExpiresAt?: number | null
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
      grant.allowanceUnits === null
        ? Number.POSITIVE_INFINITY
        : grant.allowanceUnits - state.consumedInCurrentWindow

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
    | "cadenceEffectiveAt"
    | "cadenceExpiresAt"
    | "effectiveAt"
    | "expiresAt"
    | "grantId"
    | "resetConfig"
  >,
  timestamp: number
): { bucketKey: string; end: number; periodKey: string; start: number } | null {
  const config = grant.resetConfig
    ? {
        name: grant.resetConfig.name,
        interval: grant.resetConfig.resetInterval,
        intervalCount: grant.resetConfig.resetIntervalCount,
        anchor: "dayOfCreation" as const,
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
    effectiveStartDate: grant.cadenceEffectiveAt ?? grant.effectiveAt,
    effectiveEndDate: grant.cadenceExpiresAt ?? grant.expiresAt,
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

export function validateGrantBatch<TGrant extends Pick<GrantPolicyGrant, "currencyCode">>(
  grants: TGrant[]
): void {
  const currencies = new Set(grants.map((grant) => grant.currencyCode))
  if (currencies.size > 1) {
    throw new Error("Mixed-currency grants are not supported for one entitlement window")
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
    if (grant.allowanceUnits === null) {
      return Number.POSITIVE_INFINITY
    }

    const bucket = computeGrantPeriodBucket(grant, params.timestamp)
    if (!bucket) {
      continue
    }

    const consumed = statesByBucketKey.get(bucket.bucketKey)?.consumedInCurrentWindow ?? 0
    available += Math.max(0, grant.allowanceUnits - consumed)
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
    featureType: resolveGrantPricingFeatureType(params.priceConfig),
    config: params.priceConfig,
  })

  if (beforeResult.err) {
    throw beforeResult.err
  }

  const afterResult = calculatePricePerFeature({
    quantity: usageAfter,
    featureType: resolveGrantPricingFeatureType(params.priceConfig),
    config: params.priceConfig,
  })

  if (afterResult.err) {
    throw afterResult.err
  }

  return diffLedgerMinor(afterResult.val.totalPrice.dinero, beforeResult.val.totalPrice.dinero)
}

export function computeUsagePriceDeltaExplanation(params: {
  priceConfig: ConfigFeatureVersionType
  usageAfter: number
  usageBefore: number
}): UsagePriceDeltaExplanation {
  const amountMinor = computeUsagePriceDeltaMinor(params)
  const tierMode =
    "usageMode" in params.priceConfig && params.priceConfig.usageMode === "tier"
      ? (params.priceConfig.tierMode ?? null)
      : "tierMode" in params.priceConfig
        ? (params.priceConfig.tierMode ?? null)
        : null

  return {
    amountMinor,
    usageBefore: Math.max(0, params.usageBefore),
    usageAfter: Math.max(0, params.usageAfter),
    tierMode,
    tierIndex: resolveTierIndex(params.priceConfig, Math.max(0, params.usageAfter)),
    pricingComponentCount: resolvePricingComponentCount(
      params.priceConfig,
      params.usageBefore,
      params.usageAfter
    ),
  }
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

export function resolveTierIndex(
  priceConfig: ConfigFeatureVersionType,
  usage: number
): number | null {
  const tiers = "tiers" in priceConfig && Array.isArray(priceConfig.tiers) ? priceConfig.tiers : []
  const normalizedUsage = Math.max(0, usage)

  if (tiers.length === 0 || normalizedUsage === 0) {
    return null
  }

  const index = tiers.findIndex(
    (tier) =>
      normalizedUsage >= tier.firstUnit &&
      (tier.lastUnit === null || normalizedUsage <= tier.lastUnit)
  )

  if (index >= 0) {
    return index
  }

  const firstTier = tiers[0]
  if (firstTier && normalizedUsage > 0 && normalizedUsage < firstTier.firstUnit) {
    return 0
  }

  return null
}

export function resolvePricingComponentCount(
  priceConfig: ConfigFeatureVersionType,
  usageBefore: number,
  usageAfter: number
): number {
  const before = Math.max(0, usageBefore)
  const after = Math.max(0, usageAfter)

  if (before === after) {
    return 0
  }

  const featureType = resolveGrantPricingFeatureType(priceConfig)
  const tiers = "tiers" in priceConfig && Array.isArray(priceConfig.tiers) ? priceConfig.tiers : []

  if (isPackagePricing(priceConfig)) {
    return resolvePackageComponentCount(priceConfig, before, after)
  }

  if (featureType === "flat" || tiers.length === 0) {
    return 1
  }

  const lower = Math.min(before, after)
  const upper = Math.max(before, after)

  if (resolveTierMode(priceConfig) === "volume") {
    return new Set(
      [resolveTierIndex(priceConfig, lower), resolveTierIndex(priceConfig, upper)].filter(
        (index): index is number => index !== null
      )
    ).size
  }

  return tiers.filter((tier, index) => {
    const tierStartExclusive = index === 0 ? 0 : tier.firstUnit - 1
    const tierEnd = tier.lastUnit ?? Number.POSITIVE_INFINITY
    return upper > tierStartExclusive && lower < tierEnd
  }).length
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

function resolveGrantPricingFeatureType(
  priceConfig: ConfigFeatureVersionType
): GrantPricingFeatureType {
  if ("usageMode" in priceConfig && priceConfig.usageMode) {
    return GRANT_PRICING_FEATURE_TYPE
  }

  if ("tiers" in priceConfig && Array.isArray(priceConfig.tiers)) {
    return "tier"
  }

  if ("units" in priceConfig && typeof priceConfig.units === "number") {
    return "package"
  }

  return "flat"
}

function resolveTierMode(priceConfig: ConfigFeatureVersionType): "volume" | "graduated" | null {
  if ("usageMode" in priceConfig && priceConfig.usageMode === "tier") {
    return priceConfig.tierMode ?? null
  }

  return "tierMode" in priceConfig ? (priceConfig.tierMode ?? null) : null
}

function resolvePackageComponentCount(
  priceConfig: ConfigFeatureVersionType,
  usageBefore: number,
  usageAfter: number
): number {
  const units = "units" in priceConfig ? priceConfig.units : null
  if (typeof units !== "number" || units <= 0) {
    return 1
  }

  return Math.abs(Math.ceil(usageAfter / units) - Math.ceil(usageBefore / units))
}

function isPackagePricing(priceConfig: ConfigFeatureVersionType): boolean {
  if ("usageMode" in priceConfig && priceConfig.usageMode === "package") {
    return true
  }

  return !("usageMode" in priceConfig) && "units" in priceConfig
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
        params.grant.allowanceUnits !== null && usageAfter >= params.grant.allowanceUnits
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
