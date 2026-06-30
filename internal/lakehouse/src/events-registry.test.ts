import {
  buildCloudflareLakehousePipelineDefinitions,
  getLakehouseSourceCurrentVersion,
  getLakehouseSourceSchema,
  parseLakehouseEvent,
  toCloudflarePipelineSchema,
} from "@unprice/lakehouse"
import { describe, expect, it } from "vitest"

describe("lakehouse events registry", () => {
  it("registers the events source with schema versioning", () => {
    const schema = getLakehouseSourceSchema("events")

    expect(schema.source).toBe("events")
    expect(schema.firstVersion).toBe(1)
    expect(schema.currentVersion).toBe(4)
    expect(getLakehouseSourceCurrentVersion("events")).toBe(4)
    expect(schema.fields.some((field) => field.name === "schema_version" && field.required)).toBe(
      true
    )
    expect(schema.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workspace_id",
          required: false,
          addedInVersion: 3,
        }),
        expect.objectContaining({
          name: "source_id",
          required: false,
          addedInVersion: 3,
        }),
        expect.objectContaining({
          name: "run_id",
          required: false,
          addedInVersion: 4,
        }),
        expect.objectContaining({
          name: "payload_json",
          required: false,
          addedInVersion: 4,
        }),
      ])
    )
  })

  it("builds the Cloudflare pipeline schema for events", () => {
    expect(toCloudflarePipelineSchema("events")).toEqual({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "schema_version",
          type: "int32",
          required: true,
        }),
        expect.objectContaining({
          name: "properties",
          type: "json",
          required: true,
        }),
      ]),
    })
  })

  it("parses run-attributed failed events for sync reporting evidence", () => {
    const payloadJson = JSON.stringify({
      version: 1,
      projectId: "proj_123",
      customerId: "cus_123",
      idempotencyKey: "idem_failed",
      id: "evt_failed",
      slug: "tokens_used",
      timestamp: Date.UTC(2026, 2, 19, 10, 0, 0),
      properties: { amount: 1 },
    })

    expect(
      parseLakehouseEvent("events", {
        event_date: "2026-03-19",
        schema_version: 4,
        id: "evt_failed",
        project_id: "proj_123",
        customer_id: "cus_123",
        workspace_id: "ws_123",
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
        idempotency_key: "idem_failed",
        slug: "tokens_used",
        timestamp: Date.UTC(2026, 2, 19, 10, 0, 0),
        received_at: Date.UTC(2026, 2, 19, 10, 0, 1),
        handled_at: Date.UTC(2026, 2, 19, 10, 0, 2),
        state: "failed",
        failure_stage: "rating_fact",
        failure_reason: "raw_ingestion_queue_processing_failed",
        failure_message: "apply failed",
        replayable: true,
        payload_json: payloadJson,
        properties: {
          amount: 1,
        },
        canonical_audit_id: "audit_failed",
        payload_hash: "hash_failed",
      })
    ).toEqual(
      expect.objectContaining({
        schema_version: 4,
        run_id: "brun_123",
        workload_id: "research-assistant",
        state: "failed",
        failure_stage: "rating_fact",
        replayable: true,
        payload_json: payloadJson,
      })
    )
  })

  it("parses a valid events record from the registry schema", () => {
    expect(
      parseLakehouseEvent("events", {
        event_date: "2026-03-19",
        schema_version: 1,
        id: "evt_123",
        project_id: "proj_123",
        customer_id: "cus_123",
        workspace_id: "ws_123",
        environment: "test",
        api_key_id: "key_123",
        source_type: "api_key",
        source_id: "key_123",
        source_name: null,
        request_id: "req_123",
        idempotency_key: "idem_123",
        slug: "tokens_used",
        timestamp: Date.UTC(2026, 2, 19, 10, 0, 0),
        received_at: Date.UTC(2026, 2, 19, 10, 0, 1),
        handled_at: Date.UTC(2026, 2, 19, 10, 0, 2),
        state: "processed",
        properties: {
          amount: 1,
        },
      })
    ).toEqual(
      expect.objectContaining({
        schema_version: 1,
        state: "processed",
        source_id: "key_123",
        workspace_id: "ws_123",
      })
    )
  })

  it("parses rejected events with business rejection reasons", () => {
    expect(
      parseLakehouseEvent("events", {
        event_date: "2026-03-19",
        schema_version: 1,
        id: "evt_missing_customer",
        project_id: "proj_123",
        customer_id: "cus_missing",
        request_id: "req_123",
        idempotency_key: "idem_missing_customer",
        slug: "tokens_used",
        timestamp: Date.UTC(2026, 2, 19, 10, 0, 0),
        received_at: Date.UTC(2026, 2, 19, 10, 0, 1),
        handled_at: Date.UTC(2026, 2, 19, 10, 0, 2),
        state: "rejected",
        rejection_reason: "CUSTOMER_NOT_FOUND",
        properties: {
          amount: 1,
        },
      })
    ).toEqual(
      expect.objectContaining({
        state: "rejected",
        rejection_reason: "CUSTOMER_NOT_FOUND",
      })
    )
  })

  it("parses rejected events with invalid aggregation property reasons", () => {
    expect(
      parseLakehouseEvent("events", {
        event_date: "2026-03-19",
        schema_version: 1,
        id: "evt_invalid_properties",
        project_id: "proj_123",
        customer_id: "cus_123",
        request_id: "req_123",
        idempotency_key: "idem_invalid_properties",
        slug: "api_keys",
        timestamp: Date.UTC(2026, 2, 19, 10, 0, 0),
        received_at: Date.UTC(2026, 2, 19, 10, 0, 1),
        handled_at: Date.UTC(2026, 2, 19, 10, 0, 2),
        state: "rejected",
        rejection_reason: "INVALID_AGGREGATION_PROPERTIES",
        properties: {
          amount: 1,
        },
      })
    ).toEqual(
      expect.objectContaining({
        state: "rejected",
        rejection_reason: "INVALID_AGGREGATION_PROPERTIES",
      })
    )
  })

  it("emits an events schema file definition", () => {
    expect(buildCloudflareLakehousePipelineDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "events",
          schemaFile: "events.json",
        }),
      ])
    )
  })
})
