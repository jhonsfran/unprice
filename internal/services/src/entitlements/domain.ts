import { calculateCycleWindow } from "@unprice/db/validators"
import type { MeterConfig as DbMeterConfig } from "@unprice/db/validators"
import { BaseError } from "@unprice/error"

export const MAX_FUTURE_EVENT_SKEW_MS = 5_000 // 5 secs is more than enough to avoid clock skews
export const INGESTION_MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1_000 // 30 days to allow late events
export const DO_IDEMPOTENCY_TTL_MS = INGESTION_MAX_EVENT_AGE_MS + 7 * 24 * 60 * 60 * 1_000
export const MAX_EVENT_AGE_MS = INGESTION_MAX_EVENT_AGE_MS
export const LATE_EVENT_GRACE_MS = 60 * 60 * 1_000 // 1h producer / queue lag grace before period close

if (DO_IDEMPOTENCY_TTL_MS <= INGESTION_MAX_EVENT_AGE_MS) {
  throw new Error("DO idempotency retention must exceed ingestion event acceptance")
}

export interface RawEvent {
  id: string
  slug: string
  timestamp: number
  properties: Record<string, unknown>
}

export type MeterConfig = DbMeterConfig

export interface Fact {
  eventId: string
  meterKey: string
  delta: number
  valueAfter: number
}

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T): Promise<void>
  list<T>(prefix: string): Promise<T[]>
}

export interface SyncStorageAdapter {
  getSync<T>(key: string): T | null
  putSync<T>(key: string, value: T): void
  listSync<T>(prefix: string): T[]
}

export class EventTimestampTooFarInFutureError extends BaseError<{
  eventTimeMs: number
  serverTimeMs: number
  maxFutureSkewMs: number
}> {
  public readonly retry = false
  public readonly name = EventTimestampTooFarInFutureError.name

  constructor(eventTimeMs: number, serverTimeMs: number) {
    super({
      message: "Event timestamp is too far in the future",
      context: {
        eventTimeMs,
        serverTimeMs,
        maxFutureSkewMs: MAX_FUTURE_EVENT_SKEW_MS,
      },
    })
  }
}

export class EventTimestampTooOldError extends BaseError<{
  eventTimeMs: number
  serverTimeMs: number
  maxEventAgeMs: number
}> {
  public readonly retry = false
  public readonly name = EventTimestampTooOldError.name

  constructor(eventTimeMs: number, serverTimeMs: number) {
    super({
      message: "Event timestamp is older than the maximum accepted age",
      context: {
        eventTimeMs,
        serverTimeMs,
        maxEventAgeMs: INGESTION_MAX_EVENT_AGE_MS,
      },
    })
  }
}

export class PeriodKeyComputationError extends BaseError<{
  now: number
  effectiveStartDate: number
  effectiveEndDate: number | null
  interval: Parameters<typeof calculateCycleWindow>[0]["config"]["interval"]
}> {
  public readonly retry = false
  public readonly name = PeriodKeyComputationError.name

  constructor(params: Parameters<typeof calculateCycleWindow>[0]) {
    super({
      message: "Unable to compute a period key for an inactive cycle",
      context: {
        now: params.now,
        effectiveStartDate: params.effectiveStartDate,
        effectiveEndDate: params.effectiveEndDate,
        interval: params.config.interval,
      },
    })
  }
}

/**
 * This function validates the events timestamp is not too old or too far in the future
 * @param eventTimeMs
 * @param serverTimeMs
 */
export function validateEventTimestamp(eventTimeMs: number, serverTimeMs: number): void {
  if (eventTimeMs - serverTimeMs >= MAX_FUTURE_EVENT_SKEW_MS) {
    throw new EventTimestampTooFarInFutureError(eventTimeMs, serverTimeMs)
  }

  if (serverTimeMs - eventTimeMs > INGESTION_MAX_EVENT_AGE_MS) {
    throw new EventTimestampTooOldError(eventTimeMs, serverTimeMs)
  }
}

export function computePeriodKey(params: Parameters<typeof calculateCycleWindow>[0]): string {
  const cycle = calculateCycleWindow(params)

  if (!cycle) {
    throw new PeriodKeyComputationError(params)
  }

  return `${params.config.interval}:${cycle.start}`
}

export function deriveMeterKey(meterConfig: MeterConfig): string {
  const aggregationField = meterConfig.aggregationField?.trim()
  const sortedFilters = meterConfig.filters
    ? Object.entries(meterConfig.filters).sort(([left], [right]) => left.localeCompare(right))
    : []
  const sortedGroupBy = meterConfig.groupBy ? [...meterConfig.groupBy].sort() : []

  const keyParts = [
    `slug=${encodeURIComponent(meterConfig.eventSlug)}`,
    `method=${meterConfig.aggregationMethod}`,
  ]

  if (aggregationField) {
    keyParts.push(`field=${encodeURIComponent(aggregationField)}`)
  }

  if (sortedFilters.length > 0) {
    keyParts.push(
      `filters=${sortedFilters
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&")}`
    )
  }

  if (sortedGroupBy.length > 0) {
    keyParts.push(`groupBy=${sortedGroupBy.map((value) => encodeURIComponent(value)).join(",")}`)
  }

  if (meterConfig.windowSize) {
    keyParts.push(`window=${meterConfig.windowSize}`)
  }

  return keyParts.join("|")
}
