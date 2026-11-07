import { FetchError } from "@unprice/error"
import { describe, expect, it } from "vitest"
import { journalAnalytics } from "../../analytics/journal.fixture"
import { getRejectedEventPayload } from "./get-rejected-event-payload"

const handledAt = Date.parse("2026-11-03T10:00:00.000Z")
const input = { projectId: "proj_1", customerId: "cus_1", operationId: "r:evt_1", handledAt }

describe("getRejectedEventPayload", () => {
  it("reads the refused event and its rejection from the journal", async () => {
    const data = {
      customerId: "cus_1",
      idempotencyKey: "evt_1",
      event: { slug: "tokens", properties: { input: 10 } },
      rejection: { code: "LIMIT_EXCEEDED" },
    }
    const { analytics, queries } = journalAnalytics(() => [
      {
        budget_key: "unprice:customer:cus_1",
        operation_id: "r:evt_1",
        timestamp: "2026-11-03T10:00:00.000Z",
        data: JSON.stringify(data),
      },
    ])

    const result = await getRejectedEventPayload({ analytics }, input)

    expect(queries[0]).toContain("AND operation_id = 'r:evt_1'")
    expect(queries[0]).toContain("AND status = 'rejected'")
    expect(result.val).toEqual({
      eventId: "evt_1",
      operationId: "r:evt_1",
      customerId: "cus_1",
      rejectionReason: "LIMIT_EXCEEDED",
      payloadJson: JSON.stringify(data, null, 2),
      handledAt,
    })
  })

  it("answers null until the journal has the row", async () => {
    const { analytics } = journalAnalytics(() => [])
    expect((await getRejectedEventPayload({ analytics }, input)).val).toBeNull()
  })

  it("answers null for a row whose data is not valid JSON", async () => {
    const { analytics } = journalAnalytics(() => [
      {
        budget_key: "unprice:customer:cus_1",
        operation_id: "r:evt_1",
        timestamp: "2026-11-03T10:00:00.000Z",
        data: "{not json",
      },
    ])
    const result = await getRejectedEventPayload({ analytics }, input)
    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
  })

  it("returns a journal failure", async () => {
    const { analytics } = journalAnalytics(() => new Error("basin down"))
    expect((await getRejectedEventPayload({ analytics }, input)).err).toBeInstanceOf(FetchError)
  })
})
