import type { IngestionReportingAuditRecord } from "@unprice/services/ingestion"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuditRecordPublisher } from "./audit-record-publisher"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("createAuditRecordPublisher", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends audit records to the Cloudflare Pipeline binding", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const publisher = createAuditRecordPublisher({
      APP_ENV: "production",
      LOCAL_PIPELINE_URL: undefined,
      PIPELINE_EVENTS: { send },
    } as unknown as Parameters<typeof createAuditRecordPublisher>[0])

    await publisher([createAuditRecord()])

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject([
      {
        id: "evt_123",
        project_id: "proj_123",
        customer_id: "cus_123",
        state: "processed",
      },
    ])
  })

  it("preserves run and replay evidence in Pipeline records", async () => {
    const payloadJson = JSON.stringify({
      version: 1,
      workspaceId: "ws_123",
      projectId: "proj_123",
      customerId: "cus_123",
      requestId: "req_123",
      receivedAt: TEST_NOW,
      idempotencyKey: "idem_123",
      id: "evt_123",
      slug: "usage.recorded",
      timestamp: TEST_NOW,
      properties: { amount: 1 },
      source: {
        environment: "test",
        apiKeyId: "key_123",
        sourceType: "api_key",
        sourceId: "key_123",
        sourceName: null,
      },
    })
    const send = vi.fn().mockResolvedValue(undefined)
    const publisher = createAuditRecordPublisher({
      APP_ENV: "production",
      LOCAL_PIPELINE_URL: undefined,
      PIPELINE_EVENTS: { send },
    } as unknown as Parameters<typeof createAuditRecordPublisher>[0])

    await publisher([
      createAuditRecord({
        status: "failed",
        failureStage: "rating_fact",
        failureReason: "raw_ingestion_queue_processing_failed",
        failureMessage: "apply failed",
        replayable: true,
        payloadJson,
        auditPayloadJson: JSON.stringify({
          event_date: "2026-03-20",
          schema_version: 4,
          id: "evt_123",
          workspace_id: "ws_123",
          project_id: "proj_123",
          customer_id: "cus_123",
          environment: "test",
          api_key_id: "key_123",
          source_type: "api_key",
          source_id: "key_123",
          source_name: null,
          run_id: "brun_123",
          trace_id: "trace_123",
          parent_run_id: "brun_parent_123",
          workload_type: "agent",
          workload_id: "research-assistant",
          request_id: "req_123",
          idempotency_key: "idem_123",
          slug: "usage.recorded",
          timestamp: TEST_NOW,
          received_at: TEST_NOW,
          handled_at: TEST_NOW + 1,
          state: "failed",
          failure_stage: "rating_fact",
          failure_reason: "raw_ingestion_queue_processing_failed",
          failure_message: "apply failed",
          replayable: true,
          payload_json: payloadJson,
          properties: { amount: 1 },
          canonical_audit_id: "audit_123",
          payload_hash: "hash_123",
        }),
      }),
    ])

    expect(send.mock.calls[0]?.[0]).toMatchObject([
      {
        schema_version: 4,
        run_id: "brun_123",
        trace_id: "trace_123",
        parent_run_id: "brun_parent_123",
        workload_type: "agent",
        workload_id: "research-assistant",
        state: "failed",
        failure_stage: "rating_fact",
        failure_reason: "raw_ingestion_queue_processing_failed",
        failure_message: "apply failed",
        replayable: true,
        payload_json: payloadJson,
      },
    ])
  })

  it("prefers the local pipeline URL in development", async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    const publisher = createAuditRecordPublisher({
      APP_ENV: "development",
      LOCAL_PIPELINE_URL: "http://127.0.0.1:8787/pipeline",
      PIPELINE_EVENTS: { send },
    } as unknown as Parameters<typeof createAuditRecordPublisher>[0])

    await publisher([createAuditRecord()])

    expect(send).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8787/pipeline")
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    })
    expect(parseRequestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject([
      {
        id: "evt_123",
        project_id: "proj_123",
        customer_id: "cus_123",
        state: "processed",
      },
    ])
  })

  it("throws when no Pipeline destination is configured", async () => {
    const publisher = createAuditRecordPublisher({
      APP_ENV: "production",
      LOCAL_PIPELINE_URL: undefined,
      PIPELINE_EVENTS: undefined,
    } as unknown as Parameters<typeof createAuditRecordPublisher>[0])

    await expect(publisher([createAuditRecord()])).rejects.toThrow(
      "PIPELINE_EVENTS binding is required"
    )
  })

  it("skips empty batches without requiring a destination", async () => {
    const publisher = createAuditRecordPublisher({
      APP_ENV: "production",
      LOCAL_PIPELINE_URL: undefined,
      PIPELINE_EVENTS: undefined,
    } as unknown as Parameters<typeof createAuditRecordPublisher>[0])

    await expect(publisher([])).resolves.toBeUndefined()
  })
})

function createAuditRecord(
  overrides: Partial<IngestionReportingAuditRecord> = {}
): IngestionReportingAuditRecord {
  return {
    canonicalAuditId: "audit_123",
    payloadHash: "hash_123",
    idempotencyKey: "idem_123",
    workspaceId: "ws_123",
    projectId: "proj_123",
    customerId: "cus_123",
    environment: "test",
    apiKeyId: "key_123",
    sourceType: "api_key",
    sourceId: "key_123",
    sourceName: null,
    runId: null,
    traceId: null,
    parentRunId: null,
    workloadType: null,
    workloadId: null,
    status: "processed",
    failureStage: null,
    failureReason: null,
    failureMessage: null,
    replayable: false,
    payloadJson: null,
    firstSeenAt: TEST_NOW,
    handledAt: TEST_NOW + 1,
    auditPayloadJson: JSON.stringify({
      event_date: "2026-03-20",
      schema_version: 1,
      id: "evt_123",
      project_id: "proj_123",
      customer_id: "cus_123",
      request_id: "req_123",
      idempotency_key: "idem_123",
      slug: "usage.recorded",
      timestamp: TEST_NOW,
      received_at: TEST_NOW,
      handled_at: TEST_NOW + 1,
      state: "processed",
      properties: { amount: 1 },
      canonical_audit_id: "audit_123",
      payload_hash: "hash_123",
    }),
    ...overrides,
  }
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (!init || typeof init.body !== "string") {
    return null
  }

  return JSON.parse(init.body)
}
