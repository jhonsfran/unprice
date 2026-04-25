import { type Entitlement, calculateCycleWindow } from "@unprice/db/validators"
import { z } from "zod"
import { type IngestionResolvedState, type RawEvent, computePeriodKey } from "../entitlements"

export const ingestionQueueMessageSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  customerId: z.string(),
  requestId: z.string(),
  receivedAt: z.number(),
  idempotencyKey: z.string(),
  id: z.string(),
  slug: z.string(),
  timestamp: z.number(),
  properties: z.record(z.string(), z.unknown()),
})

export type IngestionQueueMessage = z.infer<typeof ingestionQueueMessageSchema>

export type IngestionQueueRetryOptions = {
  delaySeconds?: number
}

export type IngestionQueueConsumerMessage = {
  ack: () => void
  body: IngestionQueueMessage
  retry: (options?: IngestionQueueRetryOptions) => void
}

export function partitionDuplicateQueuedMessages(messages: IngestionQueueConsumerMessage[]): {
  duplicates: IngestionQueueConsumerMessage[]
  unique: IngestionQueueConsumerMessage[]
} {
  const seen = new Set<string>()
  const duplicates: IngestionQueueConsumerMessage[] = []
  const unique: IngestionQueueConsumerMessage[] = []

  for (const message of messages) {
    const dedupeKey = [
      message.body.projectId,
      message.body.customerId,
      message.body.idempotencyKey,
    ].join(":")

    if (seen.has(dedupeKey)) {
      duplicates.push(message)
      continue
    }

    seen.add(dedupeKey)
    unique.push(message)
  }

  return {
    duplicates,
    unique,
  }
}

export function buildEntitlementWindowName(params: {
  appEnv: string
  customerId: string
  entitlementId: string
  periodKey: string
  projectId: string
}): string {
  return [
    params.appEnv,
    params.projectId,
    params.customerId,
    params.entitlementId,
    params.periodKey,
  ].join(":")
}

export function buildIngestionWindowName(params: {
  appEnv: string
  customerId: string
  periodKey: string
  projectId: string
  streamId: string
}): string {
  return [
    params.appEnv,
    params.projectId,
    params.customerId,
    params.streamId,
    params.periodKey,
  ].join(":")
}

export function computeEntitlementPeriodKey(
  entitlement: Entitlement,
  timestamp: number
): string | null {
  if (timestamp < entitlement.effectiveAt) {
    return null
  }

  if (typeof entitlement.expiresAt === "number" && timestamp >= entitlement.expiresAt) {
    return null
  }

  if (!entitlement.resetConfig) {
    return computePeriodKey({
      now: timestamp,
      effectiveStartDate: entitlement.effectiveAt,
      effectiveEndDate: entitlement.expiresAt,
      trialEndsAt: null,
      config: {
        name: "ingestion",
        interval: "onetime",
        intervalCount: 1,
        anchor: "dayOfCreation",
        planType: "onetime",
      },
    })
  }

  return computePeriodKey({
    now: timestamp,
    effectiveStartDate: entitlement.effectiveAt,
    effectiveEndDate: entitlement.expiresAt,
    trialEndsAt: null,
    config: {
      name: entitlement.resetConfig.name,
      interval: entitlement.resetConfig.resetInterval,
      intervalCount: entitlement.resetConfig.resetIntervalCount,
      anchor: entitlement.resetConfig.resetAnchor,
      planType: entitlement.resetConfig.planType,
    },
  })
}

export function computeResolvedStatePeriodKey(
  state: Pick<IngestionResolvedState, "resetConfig" | "streamEndAt" | "streamStartAt">,
  timestamp: number
): string | null {
  if (timestamp < state.streamStartAt) {
    return null
  }

  if (typeof state.streamEndAt === "number" && timestamp >= state.streamEndAt) {
    return null
  }

  if (!state.resetConfig) {
    return computePeriodKey({
      now: timestamp,
      effectiveStartDate: state.streamStartAt,
      effectiveEndDate: state.streamEndAt,
      trialEndsAt: null,
      config: {
        name: "ingestion",
        interval: "onetime",
        intervalCount: 1,
        anchor: "dayOfCreation",
        planType: "onetime",
      },
    })
  }

  return computePeriodKey({
    now: timestamp,
    effectiveStartDate: state.streamStartAt,
    effectiveEndDate: state.streamEndAt,
    trialEndsAt: null,
    config: {
      name: state.resetConfig.name,
      interval: state.resetConfig.resetInterval,
      intervalCount: state.resetConfig.resetIntervalCount,
      anchor: state.resetConfig.resetAnchor,
      planType: state.resetConfig.planType,
    },
  })
}

export function computeResolvedStatePeriodWindow(
  state: Pick<IngestionResolvedState, "resetConfig" | "streamEndAt" | "streamStartAt">,
  timestamp: number
): { start: number; end: number } | null {
  if (timestamp < state.streamStartAt) {
    return null
  }

  if (typeof state.streamEndAt === "number" && timestamp >= state.streamEndAt) {
    return null
  }

  if (!state.resetConfig) {
    const cycle = calculateCycleWindow({
      now: timestamp,
      effectiveStartDate: state.streamStartAt,
      effectiveEndDate: state.streamEndAt,
      trialEndsAt: null,
      config: {
        name: "ingestion",
        interval: "onetime",
        intervalCount: 1,
        anchor: "dayOfCreation",
        planType: "onetime",
      },
    })

    return cycle ? { start: cycle.start, end: cycle.end } : null
  }

  const cycle = calculateCycleWindow({
    now: timestamp,
    effectiveStartDate: state.streamStartAt,
    effectiveEndDate: state.streamEndAt,
    trialEndsAt: null,
    config: {
      name: state.resetConfig.name,
      interval: state.resetConfig.resetInterval,
      intervalCount: state.resetConfig.resetIntervalCount,
      anchor: state.resetConfig.resetAnchor,
      planType: state.resetConfig.planType,
    },
  })

  return cycle ? { start: cycle.start, end: cycle.end } : null
}

export function computeResolvedStatePeriodEndAt(
  state: Pick<IngestionResolvedState, "resetConfig" | "streamEndAt" | "streamStartAt">,
  timestamp: number
): number | null {
  return computeResolvedStatePeriodWindow(state, timestamp)?.end ?? null
}

export function filterMatchingEntitlements(params: {
  entitlements: Entitlement[]
  event: RawEvent
}): Entitlement[] {
  return params.entitlements.filter((entitlement) => {
    // only entitlements with meters
    if (entitlement.featureType !== "usage" || !entitlement.meterConfig) {
      return false
    }

    // only entitlements listening for this event
    if (entitlement.meterConfig.eventSlug !== params.event.slug) {
      return false
    }

    // only events that have a valid periodkey
    return computeEntitlementPeriodKey(entitlement, params.event.timestamp) !== null
  })
}

export function filterEntitlementsWithValidAggregationPayload(params: {
  entitlements: Entitlement[]
  event: RawEvent
}): Entitlement[] {
  return params.entitlements.filter((entitlement) => {
    const meterConfig = entitlement.meterConfig

    if (!meterConfig) {
      return false
    }

    if (meterConfig.aggregationMethod === "count") {
      return true
    }

    const aggregationField = meterConfig.aggregationField

    if (!aggregationField) {
      return false
    }

    const value = params.event.properties[aggregationField]

    return parseFiniteAggregationValue(value) !== null
  })
}

export function filterMatchingResolvedStates(params: {
  event: RawEvent
  states: IngestionResolvedState[]
}): IngestionResolvedState[] {
  return params.states.filter((state) => {
    return (
      state.meterConfig.eventSlug === params.event.slug &&
      computeResolvedStatePeriodKey(state, params.event.timestamp) !== null
    )
  })
}

export function filterResolvedStatesWithValidAggregationPayload(params: {
  event: RawEvent
  states: IngestionResolvedState[]
}): IngestionResolvedState[] {
  return params.states.filter((state) => {
    const meterConfig = state.meterConfig

    if (meterConfig.aggregationMethod === "count") {
      return true
    }

    const aggregationField = meterConfig.aggregationField

    if (!aggregationField) {
      return false
    }

    const value = params.event.properties[aggregationField]

    return parseFiniteAggregationValue(value) !== null
  })
}

function parseFiniteAggregationValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null
  }

  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()

  if (trimmedValue.length === 0) {
    return null
  }

  const parsedValue = Number(trimmedValue)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

export function sortQueuedMessages(
  left: IngestionQueueConsumerMessage,
  right: IngestionQueueConsumerMessage
): number {
  return (
    left.body.timestamp - right.body.timestamp ||
    left.body.idempotencyKey.localeCompare(right.body.idempotencyKey)
  )
}
