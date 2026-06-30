import type { RouterInputs } from "@unprice/trpc/routes"
import type { IngestionQueryFilter } from "./ingestion-health-model"

export const DEFAULT_INGESTION_HEALTH_WINDOW_MS = 60 * 60 * 1000

export type IngestionStatusInput = RouterInputs["analytics"]["getIngestionStatus"]

export function buildRollingIngestionWindow(
  now: number,
  intervalMs = DEFAULT_INGESTION_HEALTH_WINDOW_MS
): IngestionStatusInput["window"] {
  return {
    from: now - intervalMs,
    to: now,
  }
}

export function buildIngestionHealthInput({
  now,
  intervalMs = DEFAULT_INGESTION_HEALTH_WINDOW_MS,
  filter = {},
  limit = 5,
}: {
  now: number
  intervalMs?: number
  filter?: IngestionQueryFilter
  limit?: number
}): IngestionStatusInput {
  return {
    window: buildRollingIngestionWindow(now, intervalMs),
    filter,
    limit,
  }
}
