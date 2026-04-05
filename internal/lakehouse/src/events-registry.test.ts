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
    expect(schema.currentVersion).toBe(1)
    expect(getLakehouseSourceCurrentVersion("events")).toBe(1)
    expect(schema.fields.some((field) => field.name === "schema_version" && field.required)).toBe(
      true
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

  it("parses a valid events record from the registry schema", () => {
    expect(
      parseLakehouseEvent("events", {
        event_date: "2026-03-19",
        schema_version: 1,
        id: "evt_123",
        project_id: "proj_123",
        customer_id: "cus_123",
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
