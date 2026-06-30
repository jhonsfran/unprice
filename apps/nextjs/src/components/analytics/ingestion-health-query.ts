import type { RouterInputs } from "@unprice/trpc/routes"
import type { IngestionQueryFilter } from "./ingestion-health-model"

export const INGESTION_HEALTH_WINDOW_MS = 60 * 60 * 1000

export type IngestionStatusInput = RouterInputs["analytics"]["getIngestionStatus"]

export function buildRollingIngestionWindow(now: number): IngestionStatusInput["window"] {
  return {
    from: now - INGESTION_HEALTH_WINDOW_MS,
    to: now,
  }
}

export function buildIngestionHealthInput({
  now,
  filter = {},
  limit = 5,
}: {
  now: number
  filter?: IngestionQueryFilter
  limit?: number
}): IngestionStatusInput {
  return {
    window: buildRollingIngestionWindow(now),
    filter,
    limit,
  }
}
