import { DEFAULT_INACTIVITY_THRESHOLD_MS, DEVELOPMENT_INACTIVITY_THRESHOLD_MS } from "./constants"

// Caps how long consumed-but-unflushed usage can sit outside the ledger.
export function maxFlushIntervalMs(env: { NODE_ENV?: string }): number {
  return env.NODE_ENV === "development" ? 30_000 : 10 * 60_000
}

export function inactivityThresholdMs(env: { NODE_ENV?: string }): number {
  return env.NODE_ENV === "development"
    ? DEVELOPMENT_INACTIVITY_THRESHOLD_MS
    : DEFAULT_INACTIVITY_THRESHOLD_MS
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
