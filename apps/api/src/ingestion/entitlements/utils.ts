import type { Env } from "~/env"
import { DEFAULT_INACTIVITY_THRESHOLD_MS, DEVELOPMENT_INACTIVITY_THRESHOLD_MS } from "./constants"

// Caps how long consumed-but-unflushed usage can sit outside the ledger.
export function maxFlushIntervalMs(env: Pick<Env, "NODE_ENV">): number {
  return env.NODE_ENV === "development" ? 30_000 : 10 * 60_000
}

export function inactivityThresholdMs(env: Pick<Env, "NODE_ENV">): number {
  return env.NODE_ENV === "development"
    ? DEVELOPMENT_INACTIVITY_THRESHOLD_MS
    : DEFAULT_INACTIVITY_THRESHOLD_MS
}

export function minNullableExpiry(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJson(left ?? null)) === JSON.stringify(stableJson(right ?? null))
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson)
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, stableJson(nestedValue)])
    )
  }

  return value
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
