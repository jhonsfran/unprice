import { Ok } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import { INGESTION_MAX_EVENT_AGE_MS } from "../entitlements"
import type { IngestionEntitlement } from "./entitlement-context"
import type { IngestionQueueMessage } from "./message"
import {
  INGESTION_REPORTING_ENVELOPE_TARGET_BYTES,
  type IngestionReportingEnvelope,
  chunkIngestionReportingEnvelope,
  getIngestionReportingEnvelopeSerializedBytes,
  ingestionReportingEnvelopeSchema,
} from "./reporting"
import { IngestionService } from "./service"

const SERVICE_NOW = Date.UTC(2026, 2, 20, 12, 0, 0)

describe("ingestion reporting contract", () => {
  it("accepts one envelope with one processed event and one fact", () => {
    const envelope = createReportingEnvelope({
      auditRecords: [createReportingAuditRecord()],
      meterFacts: [createReportingMeterFact()],
    })

    expect(() => ingestionReportingEnvelopeSchema.parse(envelope)).not.toThrow()
    expect(chunkIngestionReportingEnvelope(envelope)).toEqual([envelope])
    expect(getIngestionReportingEnvelopeSerializedBytes(envelope)).toBeLessThanOrEqual(
      INGESTION_REPORTING_ENVELOPE_TARGET_BYTES
    )
  })

  it("accepts one envelope with multiple audit records and multiple facts", () => {
    const envelope = createReportingEnvelope({
      auditRecords: [
        createReportingAuditRecord({ idempotencyKey: "idem_1", status: "processed" }),
        createReportingAuditRecord({
          idempotencyKey: "idem_2",
          status: "rejected",
          rejectionReason: "LIMIT_EXCEEDED",
        }),
      ],
      meterFacts: [
        createReportingMeterFact({ event_id: "evt_1", idempotency_key: "idem_1" }),
        createReportingMeterFact({
          event_id: "evt_2",
          idempotency_key: "idem_2",
          value_after: 2,
        }),
      ],
    })

    const parsed = ingestionReportingEnvelopeSchema.parse(envelope)

    expect(parsed.auditRecords).toHaveLength(2)
    expect(parsed.meterFacts).toHaveLength(2)
    expect(parsed.auditRecords.map((record) => record.status)).toEqual(["processed", "rejected"])
  })

  it("chunks envelopes when serialized payload size exceeds the target byte size", () => {
    const envelope = createReportingEnvelope({
      envelopeId: "env_large",
      auditRecords: [
        createReportingAuditRecord({
          idempotencyKey: "idem_large_1",
          auditPayloadJson: JSON.stringify({ body: "x".repeat(70_000) }),
        }),
        createReportingAuditRecord({
          idempotencyKey: "idem_large_2",
          auditPayloadJson: JSON.stringify({ body: "y".repeat(70_000) }),
        }),
      ],
      meterFacts: [],
    })

    const chunks = chunkIngestionReportingEnvelope(envelope)

    expect(getIngestionReportingEnvelopeSerializedBytes(envelope)).toBeGreaterThan(
      INGESTION_REPORTING_ENVELOPE_TARGET_BYTES
    )
    expect(chunks).toHaveLength(2)
    expect(chunks.map((chunk) => chunk.envelopeId)).toEqual(["env_large", "env_large:2"])
    expect(
      chunks.flatMap((chunk) => chunk.auditRecords.map((record) => record.idempotencyKey))
    ).toEqual(["idem_large_1", "idem_large_2"])
    expect(
      chunks.every(
        (chunk) =>
          getIngestionReportingEnvelopeSerializedBytes(chunk) <=
          INGESTION_REPORTING_ENVELOPE_TARGET_BYTES
      )
    ).toBe(true)
  })
})

describe("IngestionService entitlement routing", () => {
  it("loads customer entitlements and routes by customerEntitlementId", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(
          Ok([
            {
              id: entitlement.customerEntitlementId,
              projectId: entitlement.projectId,
              customerId: entitlement.customerId,
              featurePlanVersionId: entitlement.featurePlanVersionId,
              subscriptionId: null,
              subscriptionPhaseId: null,
              subscriptionItemId: null,
              effectiveAt: entitlement.effectiveAt,
              expiresAt: entitlement.expiresAt,
              overageStrategy: entitlement.overageStrategy,
              metadata: null,
              createdAtM: 0,
              updatedAtM: 0,
              grants: [
                {
                  id: "grant_123",
                  projectId: entitlement.projectId,
                  customerEntitlementId: entitlement.customerEntitlementId,
                  type: "subscription",
                  priority: 10,
                  allowanceUnits: 100,
                  effectiveAt: entitlement.effectiveAt,
                  expiresAt: entitlement.expiresAt,
                  metadata: null,
                  createdAtM: 0,
                  updatedAtM: 0,
                },
              ],
              featurePlanVersion: {
                id: entitlement.featurePlanVersionId,
                projectId: entitlement.projectId,
                planVersionId: "version_123",
                type: "feature",
                featureId: "feature_123",
                featureType: "usage",
                unitOfMeasure: "units",
                config: entitlement.featureConfig,
                billingConfig: {
                  name: "monthly",
                  billingInterval: "month",
                  billingIntervalCount: 1,
                  billingAnchor: "dayOfCreation",
                  planType: "recurring",
                },
                resetConfig: null,
                metadata: null,
                order: 1,
                defaultQuantity: 1,
                limit: 100,
                meterConfig: entitlement.meterConfig,
                createdAtM: 0,
                updatedAtM: 0,
                feature: {
                  id: "feature_123",
                  projectId: entitlement.projectId,
                  slug: entitlement.featureSlug,
                  type: "usage",
                  title: "API calls",
                  description: null,
                  metadata: null,
                  createdAtM: 0,
                  updatedAtM: 0,
                },
              },
            },
          ] as never)
        ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message: {
        version: 1,
        workspaceId: "ws_123",
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        requestId: "req_123",
        receivedAt: Date.now(),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "usage.recorded",
        timestamp: Date.UTC(2026, 2, 19),
        properties: { amount: 1 },
        source: {
          environment: "test",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      },
    })

    expect(result.allowed).toBe(true)
    expect(getEntitlementWindowStub).toHaveBeenCalledWith({
      customerEntitlementId: entitlement.customerEntitlementId,
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
    })
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement: expect.objectContaining({
          customerEntitlementId: entitlement.customerEntitlementId,
        }),
        grants: [
          expect.objectContaining({
            grantId: "grant_123",
            allowanceUnits: 100,
          }),
        ],
      })
    )
  })

  it("replays sync entitlement-window denials through reporting", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({
      allowed: false,
      deniedReason: "WALLET_EMPTY",
      message: "Wallet empty for meter api_calls (reservation res_123)",
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message: {
        version: 1,
        workspaceId: "ws_123",
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        requestId: "req_123",
        receivedAt: SERVICE_NOW,
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "usage.recorded",
        timestamp: Date.UTC(2026, 2, 19),
        properties: { amount: 1 },
        source: {
          environment: "test",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      },
    })

    expect(result).toEqual({
      allowed: false,
      message: "Wallet empty for meter api_calls (reservation res_123)",
      rejectionReason: "WALLET_EMPTY",
      state: "rejected",
    })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      rejectionReason: "WALLET_EMPTY",
      status: "rejected",
    })
    expect(envelope.meterFacts).toEqual([])
  })

  it("fails sync ingestion when reporting enqueue fails", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({ allowed: true })
    const send = vi.fn().mockRejectedValue(new Error("reporting unavailable"))

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: {
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          apply,
          getEnforcementState: vi.fn(),
        }),
      },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    await expect(
      service.ingestFeatureSync({
        featureSlug: entitlement.featureSlug,
        message: {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { amount: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      })
    ).rejects.toThrow("reporting unavailable")

    expect(apply).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("retries a sync replay after reporting enqueue fails without charging the same idempotency key twice", async () => {
    const entitlement = createEntitlement()
    const chargedKeys = new Set<string>()
    let chargeCount = 0
    const apply = vi.fn().mockImplementation((input: { idempotencyKey: string }) => {
      if (!chargedKeys.has(input.idempotencyKey)) {
        chargedKeys.add(input.idempotencyKey)
        chargeCount++
      }
      return Promise.resolve({ allowed: true })
    })
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("reporting unavailable"))
      .mockResolvedValueOnce(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: {
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          apply,
          getEnforcementState: vi.fn(),
        }),
      },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })
    const message = createMessage(entitlement)

    await expect(
      service.ingestFeatureSync({
        featureSlug: entitlement.featureSlug,
        message,
      })
    ).rejects.toThrow("reporting unavailable")

    const retry = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message,
    })

    expect(retry).toEqual({
      allowed: true,
      state: "processed",
    })
    expect(apply).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(chargeCount).toBe(1)
  })

  it("enqueues allowed sync audit and facts before returning", async () => {
    const entitlement = createEntitlement()
    const meterFact = createReportingMeterFact()
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: {
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          apply: vi.fn().mockResolvedValue({ allowed: true, meterFacts: [meterFact] }),
          getEnforcementState: vi.fn(),
        }),
      },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const message = createMessage(entitlement)
    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message,
    })

    expect(result).toEqual({
      allowed: true,
      state: "processed",
    })
    expect(send).toHaveBeenCalledTimes(1)
    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      status: "processed",
    })
    expect(envelope.meterFacts).toEqual([meterFact])
  })

  it("retries async queue outcomes when reporting enqueue fails after entitlement apply", async () => {
    const entitlement = createEntitlement()
    const chargedKeys = new Set<string>()
    let chargeCount = 0
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        entitlement: { customerEntitlementId: string }
        events: { correlationKey: string; id: string; idempotencyKey: string }[]
      }) => {
        for (const event of input.events) {
          if (!chargedKeys.has(event.idempotencyKey)) {
            chargedKeys.add(event.idempotencyKey)
            chargeCount++
          }
        }

        return Promise.resolve({
          results: input.events.map((event) => ({
            allowed: true,
            correlationKey: event.correlationKey,
            idempotencyKey: event.idempotencyKey,
            meterFacts: [
              createReportingMeterFact({
                event_id: event.id,
                idempotency_key: event.idempotencyKey,
                customer_entitlement_id: input.entitlement.customerEntitlementId,
              }),
            ],
          })),
        })
      }
    )
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("reporting unavailable"))
      .mockResolvedValueOnce(undefined)
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: {
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          apply: vi.fn(),
          applyBatch,
          getEnforcementState: vi.fn(),
        }),
      },
      logger: logger as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const group = {
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [createMessage(entitlement)],
    }
    const result = await service.processCustomerGroup(group)
    const retry = await service.processCustomerGroup(group)

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("retry")
    expect(retry[0]?.disposition.action).toBe("ack")
    expect(applyBatch).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(chargeCount).toBe(1)
    expect((send.mock.calls[1]?.[0] as IngestionReportingEnvelope).meterFacts).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledWith(
      "ingestion reporting enqueue failed",
      expect.objectContaining({
        customerId: entitlement.customerId,
        projectId: entitlement.projectId,
      })
    )
  })

  it("rejects duplicate active entitlements for the same customer feature", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn()
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        entitlement: { customerEntitlementId: string }
        events: { correlationKey: string; id: string; idempotencyKey: string }[]
      }) =>
        Promise.resolve({
          results: input.events.map((event) => ({
            allowed: true,
            correlationKey: event.correlationKey,
            idempotencyKey: event.idempotencyKey,
            meterFacts: [
              createReportingMeterFact({
                event_id: event.id,
                idempotency_key: event.idempotencyKey,
                customer_entitlement_id: input.entitlement.customerEntitlementId,
              }),
            ],
          })),
        })
    )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(
          Ok([
            createCustomerEntitlementRecord(entitlement),
            createCustomerEntitlementRecord({
              ...entitlement,
              customerEntitlementId: "ce_duplicate",
              featurePlanVersionId: "fpv_duplicate",
            }),
          ] as never)
        ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: logger as never,
      now: () => SERVICE_NOW,
    })

    const result = await service.ingestFeatureSync({
      featureSlug: entitlement.featureSlug,
      message: {
        version: 1,
        workspaceId: "ws_123",
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        requestId: "req_123",
        receivedAt: Date.now(),
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "usage.recorded",
        timestamp: Date.UTC(2026, 2, 19),
        properties: { amount: 1 },
        source: {
          environment: "test",
          apiKeyId: "key_123",
          sourceType: "api_key",
          sourceId: "key_123",
          sourceName: null,
        },
      },
    })

    expect(result).toMatchObject({
      allowed: false,
      rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
      state: "rejected",
    })
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      "multiple active entitlements matched ingestion event",
      expect.objectContaining({
        customerEntitlementIds: ["ce_123", "ce_duplicate"],
      })
    )
  })

  it("fans async events out to multiple payload-compatible meters with the same event slug", async () => {
    const eventsEntitlement = createEntitlement({
      customerEntitlementId: "ce_events",
      featurePlanVersionId: "fpv_events",
      featureSlug: "events",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "events",
      },
    })
    const keysEntitlement = createEntitlement({
      customerEntitlementId: "ce_keys",
      featurePlanVersionId: "fpv_keys",
      featureSlug: "apikeys",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "keys",
      },
    })
    const apply = vi.fn()
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        entitlement: { customerEntitlementId: string }
        events: { correlationKey: string; id: string; idempotencyKey: string }[]
      }) =>
        Promise.resolve({
          results: input.events.map((event) => ({
            allowed: true,
            correlationKey: event.correlationKey,
            idempotencyKey: event.idempotencyKey,
            meterFacts: [
              createReportingMeterFact({
                event_id: event.id,
                idempotency_key: event.idempotencyKey,
                customer_entitlement_id: input.entitlement.customerEntitlementId,
              }),
            ],
          })),
        })
    )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(
            Ok([
              createCustomerEntitlementRecord(eventsEntitlement),
              createCustomerEntitlementRecord(keysEntitlement),
            ] as never)
          ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: logger as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: eventsEntitlement.customerId,
      projectId: eventsEntitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: eventsEntitlement.projectId,
          customerId: eventsEntitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "completions",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { events: 2, keys: 3 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")
    expect(getEntitlementWindowStub).toHaveBeenCalledTimes(2)
    expect(getEntitlementWindowStub).toHaveBeenNthCalledWith(1, {
      customerEntitlementId: "ce_events",
      customerId: eventsEntitlement.customerId,
      projectId: eventsEntitlement.projectId,
    })
    expect(getEntitlementWindowStub).toHaveBeenNthCalledWith(2, {
      customerEntitlementId: "ce_keys",
      customerId: eventsEntitlement.customerId,
      projectId: eventsEntitlement.projectId,
    })
    expect(apply).not.toHaveBeenCalled()
    expect(applyBatch).toHaveBeenCalledTimes(2)
    expect(applyBatch.mock.calls.map(([input]) => input.entitlement.customerEntitlementId)).toEqual(
      ["ce_events", "ce_keys"]
    )
    expect(send).toHaveBeenCalledTimes(1)

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      rejectionReason: undefined,
      status: "processed",
    })
    expect(envelope.meterFacts).toEqual([
      expect.objectContaining({
        event_id: "evt_123",
        customer_entitlement_id: "ce_events",
      }),
      expect.objectContaining({
        event_id: "evt_123",
        customer_entitlement_id: "ce_keys",
      }),
    ])
    expect(logger.info).toHaveBeenCalledWith(
      "raw ingestion entitlement fanout",
      expect.objectContaining({
        raw_event_count: 1,
        matched_entitlement_count: 2,
        matched_entitlements_per_event_max: 2,
        apply_group_count: 2,
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      "raw ingestion customer group",
      expect.objectContaining({
        raw_event_count: 1,
        fresh_event_count: 1,
        reporting_envelope_count: 1,
        reporting_audit_record_count: 1,
        reporting_meter_fact_count: 2,
      })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it("warns when async fanout exceeds the configured threshold", async () => {
    const entitlements = ["tokens", "requests", "images"].map((field) =>
      createEntitlement({
        customerEntitlementId: `ce_${field}`,
        featurePlanVersionId: `fpv_${field}`,
        featureSlug: field,
        meterConfig: {
          eventId: "evt_ai_usage",
          eventSlug: "ai.usage",
          aggregationMethod: "sum",
          aggregationField: field,
        },
      })
    )
    const applyBatch = vi
      .fn()
      .mockImplementation(
        (input: { events: { correlationKey: string; idempotencyKey: string }[] }) =>
          Promise.resolve({
            results: input.events.map((event) => ({
              allowed: true,
              correlationKey: event.correlationKey,
              idempotencyKey: event.idempotencyKey,
            })),
          })
      )
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(
            Ok(
              entitlements.map((entitlement) =>
                createCustomerEntitlementRecord(entitlement)
              ) as never
            )
          ),
      } as never,
      entitlementWindowClient: {
        getEntitlementWindowStub: vi.fn().mockReturnValue({
          apply: vi.fn(),
          applyBatch,
          getEnforcementState: vi.fn(),
        }),
      },
      fanoutWarningThreshold: 2,
      logger: logger as never,
      now: () => SERVICE_NOW,
    })

    const [entitlement] = entitlements
    if (!entitlement) {
      throw new Error("missing entitlement fixture")
    }

    await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "ai.usage",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { tokens: 1, requests: 1, images: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(logger.warn).toHaveBeenCalledWith(
      "high ingestion entitlement fanout",
      expect.objectContaining({
        matched_entitlements_per_event: 3,
        fanout_warning_threshold: 2,
        customerEntitlementIds: ["ce_tokens", "ce_requests", "ce_images"],
      })
    )
  })

  it("reports a partially applied async fanout as replayable failed ingestion", async () => {
    const eventsEntitlement = createEntitlement({
      customerEntitlementId: "ce_events",
      featurePlanVersionId: "fpv_events",
      featureSlug: "events",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "events",
      },
    })
    const keysEntitlement = createEntitlement({
      customerEntitlementId: "ce_keys",
      featurePlanVersionId: "fpv_keys",
      featureSlug: "apikeys",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "keys",
      },
    })
    const chargedKeys = new Set<string>()
    let eventsChargeCount = 0
    const eventsApplyBatch = vi
      .fn()
      .mockImplementation(
        (input: { events: { correlationKey: string; idempotencyKey: string }[] }) => {
          for (const event of input.events) {
            if (!chargedKeys.has(event.idempotencyKey)) {
              chargedKeys.add(event.idempotencyKey)
              eventsChargeCount++
            }
          }
          return Promise.resolve({
            results: input.events.map((event) => ({
              allowed: true,
              correlationKey: event.correlationKey,
              idempotencyKey: event.idempotencyKey,
            })),
          })
        }
      )
    const keysApplyBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("keys window crashed"))
      .mockImplementationOnce(
        (input: { events: { correlationKey: string; idempotencyKey: string }[] }) =>
          Promise.resolve({
            results: input.events.map((event) => ({
              allowed: true,
              correlationKey: event.correlationKey,
              idempotencyKey: event.idempotencyKey,
            })),
          })
      )
    const getEntitlementWindowStub = vi
      .fn()
      .mockImplementation((params: { customerEntitlementId: string }) => ({
        apply: vi.fn(),
        applyBatch:
          params.customerEntitlementId === "ce_events" ? eventsApplyBatch : keysApplyBatch,
        getEnforcementState: vi.fn(),
      }))
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(
            Ok([
              createCustomerEntitlementRecord(eventsEntitlement),
              createCustomerEntitlementRecord(keysEntitlement),
            ] as never)
          ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })
    const group = {
      customerId: eventsEntitlement.customerId,
      projectId: eventsEntitlement.projectId,
      messages: [
        createMessage(eventsEntitlement, {
          idempotencyKey: "idem_partial_fanout",
          id: "evt_partial_fanout",
          slug: "completions",
          properties: { events: 2, keys: 3 },
        }),
      ],
    }

    const result = await service.processCustomerGroup(group)
    const failedEnvelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope

    expect(result[0]?.disposition.action).toBe("ack")
    expect(eventsApplyBatch).toHaveBeenCalledTimes(1)
    expect(keysApplyBatch).toHaveBeenCalledTimes(1)
    expect(eventsChargeCount).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(failedEnvelope.meterFacts).toEqual([])
    expect(failedEnvelope.auditRecords[0]).toMatchObject({
      status: "failed",
      failureStage: "rating_fact",
      failureReason: "raw_ingestion_queue_processing_failed",
      failureMessage: "keys window crashed",
      replayable: true,
    })
    expect(failedEnvelope.auditRecords[0]?.payloadJson).toEqual(JSON.stringify(group.messages[0]))
  })

  it("keeps async fanout processed when one meter applies before another denies late", async () => {
    const eventsEntitlement = createEntitlement({
      customerEntitlementId: "ce_events",
      featurePlanVersionId: "fpv_events",
      featureSlug: "events",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "events",
      },
    })
    const keysEntitlement = createEntitlement({
      customerEntitlementId: "ce_keys",
      featurePlanVersionId: "fpv_keys",
      featureSlug: "apikeys",
      meterConfig: {
        eventId: "evt_completions",
        eventSlug: "completions",
        aggregationMethod: "sum",
        aggregationField: "keys",
      },
    })
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        entitlement: IngestionEntitlement
        events: { correlationKey: string; idempotencyKey: string }[]
      }) =>
        Promise.resolve({
          results: input.events.map((event) =>
            input.entitlement.customerEntitlementId === "ce_keys"
              ? {
                  allowed: false,
                  correlationKey: event.correlationKey,
                  deniedReason: "LATE_EVENT_CLOSED_PERIOD",
                  idempotencyKey: event.idempotencyKey,
                }
              : {
                  allowed: true,
                  correlationKey: event.correlationKey,
                  idempotencyKey: event.idempotencyKey,
                }
          ),
        })
    )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply: vi.fn(),
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(
            Ok([
              createCustomerEntitlementRecord(eventsEntitlement),
              createCustomerEntitlementRecord(keysEntitlement),
            ] as never)
          ),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: eventsEntitlement.customerId,
      projectId: eventsEntitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: eventsEntitlement.projectId,
          customerId: eventsEntitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "completions",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { events: 2, keys: 3 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      rejectionReason: undefined,
      status: "processed",
    })
  })

  it("rejects async queue outcomes when no entitlement apply is allowed", async () => {
    const entitlement = createEntitlement()
    const applyBatch = vi
      .fn()
      .mockImplementation(
        (input: { events: { correlationKey: string; idempotencyKey: string }[] }) =>
          Promise.resolve({
            results: input.events.map((event) => ({
              allowed: false,
              correlationKey: event.correlationKey,
              deniedReason: "WALLET_EMPTY",
              idempotencyKey: event.idempotencyKey,
            })),
          })
      )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply: vi.fn(),
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: logger as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: entitlement.meterConfig?.eventSlug ?? "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { amount: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      rejectionReason: "WALLET_EMPTY",
      status: "rejected",
    })
    expect(JSON.parse(envelope.auditRecords[0]?.auditPayloadJson ?? "{}")).toMatchObject({
      state: "rejected",
      rejection_reason: "WALLET_EMPTY",
    })
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion message rejected",
      expect.objectContaining({
        idempotencyKey: "idem_123",
        rejectionReason: "WALLET_EMPTY",
      })
    )
  })

  it("correlates async batch outcomes when messages share an idempotency key", async () => {
    const entitlement = createEntitlement()
    const applyBatch = vi.fn().mockImplementation(
      (input: {
        events: { correlationKey: string; id: string; idempotencyKey: string }[]
      }) =>
        Promise.resolve({
          results: [...input.events].reverse().map((event) =>
            event.id === "evt_first"
              ? {
                  allowed: true,
                  correlationKey: event.correlationKey,
                  idempotencyKey: event.idempotencyKey,
                }
              : {
                  allowed: false,
                  correlationKey: event.correlationKey,
                  deniedReason: "LATE_EVENT_CLOSED_PERIOD",
                  idempotencyKey: event.idempotencyKey,
                }
          ),
        })
    )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply: vi.fn(),
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_first",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_shared",
          id: "evt_first",
          slug: entitlement.meterConfig?.eventSlug ?? "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { amount: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_second",
          receivedAt: SERVICE_NOW,
          idempotencyKey: "idem_shared",
          id: "evt_second",
          slug: entitlement.meterConfig?.eventSlug ?? "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19) + 1,
          properties: { amount: 2 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(2)
    expect(result.every((item) => item.disposition.action === "ack")).toBe(true)

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    const entriesByEventId = new Map(
      envelope.auditRecords.map((entry) => [JSON.parse(entry.auditPayloadJson).id, entry])
    )
    expect(entriesByEventId.get("evt_first")).toMatchObject({
      status: "processed",
      rejectionReason: undefined,
    })
    expect(entriesByEventId.get("evt_second")).toMatchObject({
      status: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("chunks async entitlement window batch applies at 100 messages", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn()
    const applyBatch = vi
      .fn()
      .mockImplementation(
        (input: { events: { correlationKey: string; idempotencyKey: string }[] }) =>
          Promise.resolve({
            results: input.events.map((event) => ({
              allowed: true,
              correlationKey: event.correlationKey,
              idempotencyKey: event.idempotencyKey,
            })),
          })
      )
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      applyBatch,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const messages = Array.from({ length: 101 }, (_, index) => ({
      version: 1 as const,
      workspaceId: "ws_123",
      projectId: entitlement.projectId,
      customerId: entitlement.customerId,
      requestId: `req_${index}`,
      receivedAt: SERVICE_NOW,
      idempotencyKey: `idem_${index.toString().padStart(3, "0")}`,
      id: `evt_${index}`,
      slug: entitlement.meterConfig?.eventSlug ?? "usage.recorded",
      timestamp: Date.UTC(2026, 2, 19) + index,
      properties: { amount: 1 },
      source: {
        environment: "test",
        apiKeyId: "key_123",
        sourceType: "api_key" as const,
        sourceId: "key_123",
        sourceName: null,
      },
    }))

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages,
    })

    expect(result).toHaveLength(101)
    expect(result.every((item) => item.disposition.action === "ack")).toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(applyBatch).toHaveBeenCalledTimes(2)
    expect(applyBatch.mock.calls.map(([input]) => input.events.length)).toEqual([100, 1])
    expect(send).toHaveBeenCalledTimes(2)
    expect(
      send.mock.calls.reduce(
        (count, [envelope]) => count + (envelope as IngestionReportingEnvelope).auditRecords.length,
        0
      )
    ).toBe(101)
  })

  it("returns CUSTOMER_NOT_FOUND when verifying a missing customer", async () => {
    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(Ok([])),
        customerExists: vi.fn().mockResolvedValue(Ok(false)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub: vi.fn() },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_missing",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: SERVICE_NOW,
    })

    expect(result).toMatchObject({
      allowed: false,
      featureSlug: "api_calls",
      rejectionReason: "CUSTOMER_NOT_FOUND",
    })
  })

  it("returns NO_MATCHING_ENTITLEMENT when the customer exists without a matching entitlement", async () => {
    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi.fn().mockResolvedValue(Ok([])),
        customerExists: vi.fn().mockResolvedValue(Ok(true)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub: vi.fn() },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "missing_feature",
      projectId: "proj_123",
      timestamp: SERVICE_NOW,
    })

    expect(result).toMatchObject({
      allowed: false,
      featureSlug: "missing_feature",
      rejectionReason: "NO_MATCHING_ENTITLEMENT",
    })
  })

  it("returns static quantity limits for tier and package feature verification", async () => {
    for (const featureType of ["tier", "package"] as const) {
      const entitlement = createEntitlement({
        customerEntitlementId: `ce_${featureType}`,
        featureSlug: `${featureType}_seats`,
        featureType,
        grants: [
          {
            allowanceUnits: 7,
            effectiveAt: Date.UTC(2026, 2, 1),
            expiresAt: null,
            grantId: `grant_${featureType}`,
            priority: 10,
          },
        ],
        meterConfig: null,
      })
      const getEntitlementWindowStub = vi.fn()

      const service = new IngestionService({
        cache: createCache(),
        entitlementService: {
          getCustomerEntitlementsForCustomer: vi
            .fn()
            .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
        } as never,
        entitlementWindowClient: { getEntitlementWindowStub },
        logger: createLogger() as never,
        now: () => SERVICE_NOW,
      })

      await expect(
        service.verifyFeatureStatus({
          customerId: entitlement.customerId,
          featureSlug: entitlement.featureSlug,
          projectId: entitlement.projectId,
          timestamp: SERVICE_NOW,
        })
      ).resolves.toEqual({
        allowed: true,
        featureSlug: entitlement.featureSlug,
        limit: 7,
      })
      expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    }
  })

  it("returns compact usage verification state with current spend", async () => {
    const entitlement = createEntitlement()
    const getEnforcementState = vi.fn().mockResolvedValue({
      usage: 42,
      limit: 100,
      isLimitReached: false,
      spending: {
        currency: "USD",
        ledgerAmount: 4_200_000_000,
        scale: 8,
      },
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply: vi.fn(),
      getEnforcementState,
    })

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
    })

    const result = await service.verifyFeatureStatus({
      customerId: entitlement.customerId,
      featureSlug: entitlement.featureSlug,
      projectId: entitlement.projectId,
      timestamp: SERVICE_NOW,
    })

    expect(result).toEqual({
      allowed: true,
      featureSlug: "api_calls",
      limit: 100,
      spending: {
        currency: "USD",
        displayAmount: "$42",
        ledgerAmount: 4_200_000_000,
        scale: 8,
      },
      usage: 42,
    })
  })

  it("returns LIMIT_EXCEEDED when usage verification reaches the entitlement limit", async () => {
    const entitlement = createEntitlement()
    const getEnforcementState = vi.fn().mockResolvedValue({
      usage: 100,
      limit: 100,
      isLimitReached: true,
      spending: {
        currency: "USD",
        ledgerAmount: 10_000_000_000,
        scale: 8,
      },
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply: vi.fn(),
      getEnforcementState,
    })

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
    })

    await expect(
      service.verifyFeatureStatus({
        customerId: entitlement.customerId,
        featureSlug: entitlement.featureSlug,
        projectId: entitlement.projectId,
        timestamp: SERVICE_NOW,
      })
    ).resolves.toMatchObject({
      allowed: false,
      featureSlug: "api_calls",
      limit: 100,
      rejectionReason: "LIMIT_EXCEEDED",
      spending: {
        displayAmount: "$100",
        ledgerAmount: 10_000_000_000,
      },
      usage: 100,
    })
  })

  it("records late closed-period DO denials as rejected queue outcomes", async () => {
    const entitlement = createEntitlement()
    const apply = vi.fn().mockResolvedValue({
      allowed: false,
      deniedReason: "LATE_EVENT_CLOSED_PERIOD",
      message: "closed period",
    })
    const getEntitlementWindowStub = vi.fn().mockReturnValue({
      apply,
      getEnforcementState: vi.fn(),
    })
    const send = vi.fn().mockResolvedValue(undefined)

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer: vi
          .fn()
          .mockResolvedValue(Ok([createCustomerEntitlementRecord(entitlement)] as never)),
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: createLogger() as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: Date.now(),
          idempotencyKey: "idem_123",
          id: "evt_123",
          slug: "usage.recorded",
          timestamp: Date.UTC(2026, 2, 19),
          properties: { amount: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_123",
      status: "rejected",
      rejectionReason: "LATE_EVENT_CLOSED_PERIOD",
    })
    expect(JSON.parse(envelope.auditRecords[0]?.auditPayloadJson ?? "{}")).toMatchObject({
      state: "rejected",
      rejection_reason: "LATE_EVENT_CLOSED_PERIOD",
    })
  })

  it("rejects queue messages older than the ingestion cap before entitlement processing", async () => {
    const entitlement = createEntitlement()
    const getCustomerEntitlementsForCustomer = vi.fn()
    const getEntitlementWindowStub = vi.fn()
    const send = vi.fn().mockResolvedValue(undefined)
    const logger = createLogger()

    const service = new IngestionService({
      cache: createCache(),
      entitlementService: {
        getCustomerEntitlementsForCustomer,
      } as never,
      entitlementWindowClient: { getEntitlementWindowStub },
      logger: logger as never,
      now: () => SERVICE_NOW,
      reportingClient: { send },
    })

    const result = await service.processCustomerGroup({
      customerId: entitlement.customerId,
      projectId: entitlement.projectId,
      messages: [
        {
          version: 1,
          workspaceId: "ws_123",
          projectId: entitlement.projectId,
          customerId: entitlement.customerId,
          requestId: "req_123",
          receivedAt: SERVICE_NOW - INGESTION_MAX_EVENT_AGE_MS - 10_000,
          idempotencyKey: "idem_too_old",
          id: "evt_too_old",
          slug: "usage.recorded",
          timestamp: SERVICE_NOW - INGESTION_MAX_EVENT_AGE_MS - 1,
          properties: { amount: 1 },
          source: {
            environment: "test",
            apiKeyId: "key_123",
            sourceType: "api_key",
            sourceId: "key_123",
            sourceName: null,
          },
        },
      ],
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.disposition.action).toBe("ack")
    expect(getCustomerEntitlementsForCustomer).not.toHaveBeenCalled()
    expect(getEntitlementWindowStub).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      "raw ingestion event rejected as too old",
      expect.objectContaining({
        projectId: entitlement.projectId,
        customerId: entitlement.customerId,
        idempotencyKey: "idem_too_old",
        rejectionReason: "EVENT_TOO_OLD",
      })
    )
    expect(send).toHaveBeenCalledTimes(1)

    const envelope = send.mock.calls[0]?.[0] as IngestionReportingEnvelope
    expect(envelope.auditRecords[0]).toMatchObject({
      idempotencyKey: "idem_too_old",
      status: "rejected",
      rejectionReason: "EVENT_TOO_OLD",
    })
  })
})

function createReportingEnvelope(
  overrides: Partial<IngestionReportingEnvelope> = {}
): IngestionReportingEnvelope {
  return {
    kind: "ingestion.reporting.v1",
    envelopeId: "env_123",
    createdAt: SERVICE_NOW,
    projectId: "proj_123",
    customerId: "cus_123",
    auditRecords: [],
    meterFacts: [],
    ...overrides,
  }
}

function createReportingAuditRecord(
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
    failureStage: null,
    failureReason: null,
    failureMessage: null,
    replayable: false,
    payloadJson: null,
    r2ObjectKey: null,
    firstSeenAt: SERVICE_NOW,
    handledAt: SERVICE_NOW + 1,
    auditPayloadJson: JSON.stringify({ id: "evt_123" }),
    ...overrides,
  }
}

function createReportingMeterFact(
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
    timestamp: SERVICE_NOW,
    created_at: SERVICE_NOW + 1,
    delta: 1,
    value_after: 1,
    grant_id: "grant_123",
    feature_plan_version_id: "fpv_123",
    amount: 0,
    amount_after: 0,
    amount_scale: 8,
    currency: "USD",
    priced_at: SERVICE_NOW + 1,
    tier_index: null,
    tier_mode: null,
    pricing_component_count: 0,
    ...overrides,
  }
}

function createEntitlement(overrides: Partial<IngestionEntitlement> = {}): IngestionEntitlement {
  return {
    billingPeriods: [],
    creditLinePolicy: "capped",
    customerEntitlementId: "ce_123",
    customerId: "cus_123",
    effectiveAt: Date.UTC(2026, 2, 1),
    expiresAt: null,
    featureConfig: {
      usageMode: "unit",
      price: {
        dinero: {
          amount: 0,
          currency: { code: "USD", base: 10, exponent: 2 },
          scale: 2,
        },
        displayAmount: "0.00",
      },
    },
    featurePlanVersionId: "fpv_123",
    featureSlug: "api_calls",
    featureType: "usage",
    grants: [],
    meterConfig: {
      eventId: "evt_type",
      eventSlug: "usage.recorded",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    subscriptionItemId: null,
    ...overrides,
  }
}

function createCustomerEntitlementRecord(entitlement: IngestionEntitlement) {
  return {
    id: entitlement.customerEntitlementId,
    projectId: entitlement.projectId,
    customerId: entitlement.customerId,
    featurePlanVersionId: entitlement.featurePlanVersionId,
    subscriptionId: null,
    subscriptionPhaseId: null,
    subscriptionItemId: null,
    effectiveAt: entitlement.effectiveAt,
    expiresAt: entitlement.expiresAt,
    overageStrategy: entitlement.overageStrategy,
    metadata: null,
    createdAtM: 0,
    updatedAtM: 0,
    subscriptionPhase: {
      creditLinePolicy: entitlement.creditLinePolicy,
    },
    grants: toGrantRecords(entitlement),
    featurePlanVersion: {
      id: entitlement.featurePlanVersionId,
      projectId: entitlement.projectId,
      planVersionId: "version_123",
      type: "feature",
      featureId: "feature_123",
      featureType: entitlement.featureType,
      unitOfMeasure: "units",
      config: entitlement.featureConfig,
      billingConfig: {
        name: "monthly",
        billingInterval: "month",
        billingIntervalCount: 1,
        billingAnchor: "dayOfCreation",
        planType: "recurring",
      },
      resetConfig: null,
      metadata: null,
      order: 1,
      defaultQuantity: 1,
      limit: 100,
      meterConfig: entitlement.meterConfig,
      createdAtM: 0,
      updatedAtM: 0,
      feature: {
        id: "feature_123",
        projectId: entitlement.projectId,
        slug: entitlement.featureSlug,
        type: entitlement.featureType,
        title: "API calls",
        description: null,
        metadata: null,
        createdAtM: 0,
        updatedAtM: 0,
      },
    },
  }
}

function toGrantRecords(entitlement: IngestionEntitlement) {
  const grants =
    entitlement.grants.length > 0
      ? entitlement.grants
      : [
          {
            allowanceUnits: 100,
            effectiveAt: entitlement.effectiveAt,
            expiresAt: entitlement.expiresAt,
            grantId: `${entitlement.customerEntitlementId}_grant`,
            priority: 10,
          },
        ]

  return grants.map((grant) => ({
    id: grant.grantId,
    projectId: entitlement.projectId,
    customerEntitlementId: entitlement.customerEntitlementId,
    type: "subscription",
    priority: grant.priority,
    allowanceUnits: grant.allowanceUnits,
    effectiveAt: grant.effectiveAt,
    expiresAt: grant.expiresAt,
    metadata: null,
    createdAtM: 0,
    updatedAtM: 0,
  }))
}

function createMessage(
  entitlement: IngestionEntitlement,
  overrides: Partial<IngestionQueueMessage> = {}
): IngestionQueueMessage {
  return {
    version: 1,
    workspaceId: "ws_123",
    projectId: entitlement.projectId,
    customerId: entitlement.customerId,
    requestId: "req_123",
    receivedAt: SERVICE_NOW,
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: entitlement.meterConfig?.eventSlug ?? "usage.recorded",
    timestamp: Date.UTC(2026, 2, 19),
    properties: { amount: 1 },
    source: {
      environment: "test",
      apiKeyId: "key_123",
      sourceType: "api_key",
      sourceId: "key_123",
      sourceName: null,
    },
    ...overrides,
  }
}

function createCache() {
  return {
    ingestionPreparedGrantContext: {
      swr: async (_key: string, loader: () => Promise<unknown>) => ({ val: await loader() }),
    },
  } as never
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
