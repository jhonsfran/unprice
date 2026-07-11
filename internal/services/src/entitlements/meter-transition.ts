import type { Fact, MeterConfig, RawEvent } from "./domain"
import { deriveMeterKey, validateEventTimestamp } from "./domain"

export type MeterStateSnapshot = Readonly<{
  updatedAt: number
  value: number
}>

export type MeterTransition = {
  fact: Fact
  nextState: MeterStateSnapshot
}

export function computeMeterTransition(params: {
  currentState: MeterStateSnapshot | null
  event: RawEvent
  meterConfig: MeterConfig
  /** Omit only when the caller intentionally defers timestamp validation. */
  validationTimeMs?: number
}): MeterTransition | null {
  const { currentState, event, meterConfig, validationTimeMs } = params
  if (validationTimeMs !== undefined) {
    validateEventTimestamp(event.timestamp, validationTimeMs)
  }

  if (meterConfig.eventSlug !== event.slug) {
    return null
  }

  const meterKey = deriveMeterKey(meterConfig)
  const previousValue = currentState?.value ?? 0
  const previousUpdatedAt = currentState?.updatedAt ?? Number.NEGATIVE_INFINITY

  switch (meterConfig.aggregationMethod) {
    case "count": {
      const nextValue = previousValue + 1
      return {
        fact: { eventId: event.id, meterKey, delta: 1, valueAfter: nextValue },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }
    case "sum": {
      const numericValue = readNumericFieldValue(meterConfig, event)
      const nextValue = previousValue + numericValue
      return {
        fact: { eventId: event.id, meterKey, delta: numericValue, valueAfter: nextValue },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }
    case "max": {
      const numericValue = readNumericFieldValue(meterConfig, event)
      const nextValue = currentState === null ? numericValue : Math.max(previousValue, numericValue)
      return {
        fact: {
          eventId: event.id,
          meterKey,
          delta: nextValue - previousValue,
          valueAfter: nextValue,
        },
        nextState: {
          value: nextValue,
          updatedAt: Math.max(previousUpdatedAt, event.timestamp),
        },
      }
    }
    case "latest": {
      const numericValue = readNumericFieldValue(meterConfig, event)
      if (event.timestamp < previousUpdatedAt) {
        return {
          fact: { eventId: event.id, meterKey, delta: 0, valueAfter: previousValue },
          nextState: currentState ?? {
            value: previousValue,
            updatedAt: previousUpdatedAt,
          },
        }
      }
      return {
        fact: {
          eventId: event.id,
          meterKey,
          delta: numericValue - previousValue,
          valueAfter: numericValue,
        },
        nextState: { value: numericValue, updatedAt: event.timestamp },
      }
    }
    default:
      return assertUnsupportedAggregationMethod(meterConfig.aggregationMethod)
  }
}

function readNumericFieldValue(meterConfig: MeterConfig, event: RawEvent): number {
  const field = meterConfig.aggregationField
  if (!field) {
    throw new Error(`Meter ${meterConfig.eventId} requires an aggregation field`)
  }

  const numericValue = parseFiniteNumericValue(event.properties[field])
  if (numericValue === null) {
    throw new Error(
      `Meter ${meterConfig.eventId} requires a finite numeric value at properties.${field}`
    )
  }
  return numericValue
}

function parseFiniteNumericValue(value: unknown): number | null {
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

function assertUnsupportedAggregationMethod(_aggregationMethod: never): never {
  throw new Error("Unsupported aggregation method")
}
