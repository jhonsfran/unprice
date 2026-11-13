import { describe, expect, it } from "vitest"
import { flattenUniqueEvents, ingestionEventKey } from "./ingestion-event-rows"
import type { IngestionEventRow } from "./ingestion-events-table-schema"

describe("journal event rows", () => {
  it("keeps the same operation in different budgets and removes overlapping page rows", () => {
    const first: IngestionEventRow = {
      eventId: "evt_1",
      operationId: "r:evt_1",
      budgetKey: "unprice:customer:cus_1",
      customerId: "cus_1",
      eventSlug: "tokens",
      sourceType: "charge",
      state: "rejected",
      rejectionReason: "LIMIT_EXCEEDED",
      timestamp: 1_000,
      handledAt: 1_000,
    }
    const second: IngestionEventRow = {
      ...first,
      budgetKey: "unprice:customer:cus_2",
      customerId: "cus_2",
    }

    const rows = flattenUniqueEvents([
      { recentEvents: [first, second] },
      { recentEvents: [second] },
    ])

    expect(rows.map((row) => row.customerId)).toEqual(["cus_1", "cus_2"])
    expect(rows.map(ingestionEventKey)).toEqual([
      '["unprice:customer:cus_1","r:evt_1"]',
      '["unprice:customer:cus_2","r:evt_1"]',
    ])
  })
})
