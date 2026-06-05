import type { IngestionReportingEnvelope } from "@unprice/services/ingestion"
import { describe, expect, it, vi } from "vitest"
import { IngestionReportingConsumer, chunkMeterFactsForTinybird } from "./consumer"

const TEST_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("IngestionReportingConsumer", () => {
  it("publishes one batch to Pipeline and Tinybird", async () => {
    const auditRecord = createAuditRecord()
    const meterFact = createMeterFact()
    const ack = vi.fn()
    const publishAuditRecords = vi.fn().mockResolvedValue(undefined)
    const ingestMeterFacts = vi.fn().mockResolvedValue({
      quarantined_rows: 0,
      successful_rows: 1,
    })
    const consumer = new IngestionReportingConsumer({
      ingestMeterFacts,
      logger: createLogger() as never,
      publishAuditRecords,
    })

    await consumer.consumeBatch({
      messages: [
        {
          ack,
          body: createEnvelope({
            auditRecords: [auditRecord],
            meterFacts: [meterFact],
          }),
          retry: vi.fn(),
        },
      ],
    })

    expect(publishAuditRecords).toHaveBeenCalledWith([auditRecord])
    expect(ingestMeterFacts).toHaveBeenCalledWith([meterFact])
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it("chunks a large fact list into multiple Tinybird writes", async () => {
    const facts = Array.from({ length: 5_001 }, (_, index) =>
      createMeterFact({
        event_id: `evt_${index}`,
        idempotency_key: `idem_${index}`,
        value_after: index + 1,
      })
    )
    const ingestMeterFacts = vi.fn().mockImplementation((chunk: unknown[]) =>
      Promise.resolve({
        quarantined_rows: 0,
        successful_rows: chunk.length,
      })
    )
    const consumer = new IngestionReportingConsumer({
      ingestMeterFacts,
      logger: createLogger() as never,
      publishAuditRecords: vi.fn().mockResolvedValue(undefined),
    })

    await consumer.consumeBatch({
      messages: [
        {
          ack: vi.fn(),
          body: createEnvelope({ meterFacts: facts }),
          retry: vi.fn(),
        },
      ],
    })

    expect(ingestMeterFacts).toHaveBeenCalledTimes(2)
    expect(ingestMeterFacts.mock.calls.map(([chunk]) => chunk.length)).toEqual([5_000, 1])
  })

  it("chunks Tinybird writes by NDJSON byte size", () => {
    const firstFact = createMeterFact({
      event_id: "evt_large_1",
      idempotency_key: "idem_large_1",
      feature_slug: "x".repeat(100),
    })
    const secondFact = createMeterFact({
      event_id: "evt_large_2",
      idempotency_key: "idem_large_2",
      feature_slug: "y".repeat(100),
    })
    const firstFactBytes = getNdjsonBytes(firstFact)
    const secondFactBytes = getNdjsonBytes(secondFact)

    const chunks = chunkMeterFactsForTinybird([firstFact, secondFact], {
      maxFactsPerRequest: 100,
      maxNdjsonBytesPerRequest: Math.max(firstFactBytes, secondFactBytes),
    })

    expect(chunks).toEqual([[firstFact], [secondFact]])
  })

  it("throws so Cloudflare retries the queue batch when Tinybird fails", async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const consumer = new IngestionReportingConsumer({
      ingestMeterFacts: vi.fn().mockResolvedValue({
        quarantined_rows: 0,
        successful_rows: 0,
      }),
      logger: createLogger() as never,
      publishAuditRecords: vi.fn().mockResolvedValue(undefined),
    })

    await expect(
      consumer.consumeBatch({
        messages: [
          {
            ack,
            body: createEnvelope({ meterFacts: [createMeterFact()] }),
            retry,
          },
        ],
      })
    ).rejects.toThrow("Tinybird entitlement meter facts ingestion failed")

    expect(ack).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it("throws so Cloudflare retries the queue batch when Pipeline fails", async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const ingestMeterFacts = vi.fn()
    const consumer = new IngestionReportingConsumer({
      ingestMeterFacts,
      logger: createLogger() as never,
      publishAuditRecords: vi.fn().mockRejectedValue(new Error("pipeline down")),
    })

    await expect(
      consumer.consumeBatch({
        messages: [
          {
            ack,
            body: createEnvelope({
              auditRecords: [createAuditRecord()],
              meterFacts: [createMeterFact()],
            }),
            retry,
          },
        ],
      })
    ).rejects.toThrow("pipeline down")

    expect(ingestMeterFacts).not.toHaveBeenCalled()
    expect(ack).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
  })

  it("accepts duplicate envelopes without local dedupe", async () => {
    const auditRecord = createAuditRecord()
    const meterFact = createMeterFact()
    const envelope = createEnvelope({
      auditRecords: [auditRecord],
      meterFacts: [meterFact],
    })
    const firstAck = vi.fn()
    const secondAck = vi.fn()
    const ingestMeterFacts = vi.fn().mockResolvedValue({
      quarantined_rows: 0,
      successful_rows: 2,
    })
    const publishAuditRecords = vi.fn().mockResolvedValue(undefined)
    const consumer = new IngestionReportingConsumer({
      ingestMeterFacts,
      logger: createLogger() as never,
      publishAuditRecords,
    })

    await consumer.consumeBatch({
      messages: [
        { ack: firstAck, body: envelope, retry: vi.fn() },
        { ack: secondAck, body: envelope, retry: vi.fn() },
      ],
    })

    expect(publishAuditRecords).toHaveBeenCalledWith([auditRecord, auditRecord])
    expect(ingestMeterFacts).toHaveBeenCalledWith([meterFact, meterFact])
    expect(firstAck).toHaveBeenCalledTimes(1)
    expect(secondAck).toHaveBeenCalledTimes(1)
  })
})

function createEnvelope(
  overrides: Partial<IngestionReportingEnvelope> = {}
): IngestionReportingEnvelope {
  return {
    kind: "ingestion.reporting.v1",
    envelopeId: "env_123",
    createdAt: TEST_NOW,
    projectId: "proj_123",
    customerId: "cus_123",
    auditRecords: [],
    meterFacts: [],
    ...overrides,
  }
}

function createAuditRecord(
  overrides: Partial<IngestionReportingEnvelope["auditRecords"][number]> = {}
): IngestionReportingEnvelope["auditRecords"][number] {
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
    status: "processed",
    firstSeenAt: TEST_NOW,
    handledAt: TEST_NOW + 1,
    auditPayloadJson: JSON.stringify({
      event_date: "2026-03-20",
      schema_version: 1,
      id: "evt_123",
      workspace_id: "ws_123",
      project_id: "proj_123",
      customer_id: "cus_123",
      environment: "test",
      api_key_id: "key_123",
      source_type: "api_key",
      source_id: "key_123",
      source_name: null,
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

function createMeterFact(
  overrides: Partial<IngestionReportingEnvelope["meterFacts"][number]> = {}
): IngestionReportingEnvelope["meterFacts"][number] {
  return {
    event_id: "evt_123",
    idempotency_key: "idem_123",
    workspace_id: "ws_123",
    project_id: "proj_123",
    customer_id: "cus_123",
    environment: "test",
    api_key_id: "key_123",
    source_type: "api_key",
    source_id: "key_123",
    source_name: null,
    customer_entitlement_id: "ce_123",
    feature_slug: "api_calls",
    period_key: "2026-03",
    event_slug: "usage.recorded",
    aggregation_method: "sum",
    timestamp: TEST_NOW,
    created_at: TEST_NOW + 1,
    delta: 1,
    value_after: 1,
    grant_id: "grant_123",
    feature_plan_version_id: "fpv_123",
    amount: 0,
    amount_after: 0,
    amount_scale: 8,
    currency: "USD",
    priced_at: TEST_NOW + 1,
    ...overrides,
  }
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    set: vi.fn(),
    warn: vi.fn(),
  }
}

function getNdjsonBytes(value: unknown): number {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`).byteLength
}
