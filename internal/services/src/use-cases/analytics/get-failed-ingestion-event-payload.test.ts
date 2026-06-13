import type { IngestionReplayPayloadRow } from "@unprice/analytics"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import {
  type GetFailedIngestionEventPayloadDeps,
  getFailedIngestionEventPayload,
} from "./get-failed-ingestion-event-payload"

describe("getFailedIngestionEventPayload", () => {
  it("returns a failed event payload from Tinybird", async () => {
    const { deps, analytics } = makeDeps({
      rows: [
        replayPayloadRow({
          canonical_audit_id: "audit_123",
          payload_json: JSON.stringify({ id: "evt_123" }),
        }),
      ],
    })

    const result = await getFailedIngestionEventPayload(deps, {
      projectId: "proj_123",
      canonicalAuditId: "audit_123",
    })

    expect(result.err).toBeUndefined()
    expect(analytics.getIngestionReplayPayloads).toHaveBeenCalledWith({
      project_id: "proj_123",
      canonical_audit_ids: "audit_123",
    })
    expect(result.val).toEqual({
      eventId: "evt_123",
      canonicalAuditId: "audit_123",
      customerId: "cus_123",
      failureStage: "raw_ingestion",
      failureReason: "raw_ingestion_queue_processing_failed",
      failureMessage: "apply failed",
      payloadJson: JSON.stringify({ id: "evt_123" }),
      handledAt: 4_070_908_800_000,
    })
  })

  it("returns null when Tinybird has no replayable failed payload", async () => {
    const { deps } = makeDeps({ rows: [] })

    const result = await getFailedIngestionEventPayload(deps, {
      projectId: "proj_123",
      canonicalAuditId: "audit_missing",
    })

    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
  })

  it("returns Tinybird failures as fetch errors", async () => {
    const { deps } = makeDeps({ error: new Error("tinybird unavailable") })

    const result = await getFailedIngestionEventPayload(deps, {
      projectId: "proj_123",
      canonicalAuditId: "audit_123",
    })

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })
})

function makeDeps(
  options: {
    rows?: IngestionReplayPayloadRow[]
    error?: Error
  } = {}
): {
  deps: GetFailedIngestionEventPayloadDeps
  analytics: GetFailedIngestionEventPayloadDeps["analytics"]
} {
  const analytics = {
    getIngestionReplayPayloads: vi.fn(() => {
      if (options.error) {
        return Promise.reject(options.error)
      }

      return Promise.resolve({ data: options.rows ?? [] })
    }),
  } as unknown as GetFailedIngestionEventPayloadDeps["analytics"]

  return {
    deps: { analytics },
    analytics,
  }
}

function replayPayloadRow(
  overrides: Partial<IngestionReplayPayloadRow> = {}
): IngestionReplayPayloadRow {
  return {
    event_id: "evt_123",
    canonical_audit_id: "audit_123",
    customer_id: "cus_123",
    failure_stage: "raw_ingestion",
    failure_reason: "raw_ingestion_queue_processing_failed",
    failure_message: "apply failed",
    payload_json: JSON.stringify({ id: "evt_123" }),
    handled_at: 4_070_908_800_000,
    ...overrides,
  }
}
