import type { RouterOutputs } from "@unprice/trpc/routes"

type IngestionStatus = RouterOutputs["analytics"]["listIngestionEvents"]
type IngestionEventRow = IngestionStatus["recentEvents"][number]

export function ingestionEventKey(event: Pick<IngestionEventRow, "budgetKey" | "operationId">) {
  return JSON.stringify([event.budgetKey, event.operationId])
}

export function flattenUniqueEvents(
  pages: readonly Pick<IngestionStatus, "recentEvents">[]
): IngestionEventRow[] {
  const seen = new Set<string>()
  const events: IngestionEventRow[] = []

  for (const page of pages) {
    for (const event of page.recentEvents) {
      const key = ingestionEventKey(event)
      if (seen.has(key)) continue
      seen.add(key)
      events.push(event)
    }
  }

  return events
}
