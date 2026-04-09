import { describe, expect, it, vi } from "vitest"
import { computePayloadHash, selectIngestionAuditShardIndex } from "./audit"
import type { IngestionQueueBatch } from "./consumer"
import {
  createBatchMessage,
  createBooleanGrant,
  createRawBatchMessage,
  createResolvedState,
  createServiceHarness,
  createUsageGrant,
  mapFeatureStatesBySlug,
} from "./testing/serviceTestHarness"

vi.mock("@unprice/lakehouse", () => ({
  getLakehouseSourceCurrentVersion: vi.fn(() => 2),
  parseLakehouseEvent: vi.fn((_source: string, payload: unknown) => payload),
}))

describe("IngestionService", () => {
  it("drops malformed queue messages and acks them", async () => {
    const { consumer, mocks } = createServiceHarness()
    const malformed = createRawBatchMessage({
      customerId: "cus_123",
      projectId: "proj_123",
    })

    await consumer.consumeBatch({
      messages: [malformed.message],
    } as unknown as IngestionQueueBatch)

    expect(malformed.ack).toHaveBeenCalledTimes(1)
    expect(malformed.retry).not.toHaveBeenCalled()
    expect(mocks.getGrantsForCustomer).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "dropping malformed ingestion queue message",
      expect.objectContaining({
        errors: expect.any(Array),
      })
    )
  })

  it("acks duplicate messages from the same batch before the expensive processing path", async () => {
    const { consumer, mocks } = createServiceHarness()
    const first = createBatchMessage({
      id: "evt_first",
      idempotencyKey: "idem_shared",
    })
    const duplicate = createBatchMessage({
      id: "evt_duplicate",
      idempotencyKey: "idem_shared",
    })

    await consumer.consumeBatch({
      messages: [first.message, duplicate.message],
    } as unknown as IngestionQueueBatch)

    expect(first.ack).toHaveBeenCalledTimes(1)
    expect(duplicate.ack).toHaveBeenCalledTimes(1)
    expect(first.retry).not.toHaveBeenCalled()
    expect(duplicate.retry).not.toHaveBeenCalled()
    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        idempotencyKey: "idem_shared",
        status: "rejected",
        rejectionReason: "NO_MATCHING_ENTITLEMENT",
      }),
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("commits a rejected audit entry when the customer is missing", async () => {
    const { consumer, mocks } = createServiceHarness({
      customer: null,
    })
    const message = createBatchMessage({
      id: "evt_missing_customer",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "CUSTOMER_NOT_FOUND",
      }),
    ])
    expect(mocks.apply).not.toHaveBeenCalled()
  })

  it("acks and commits NO_MATCHING_ENTITLEMENT when no usage entitlements are available", async () => {
    const { consumer, mocks } = createServiceHarness({
      grants: [createBooleanGrant()],
    })
    const message = createBatchMessage({
      id: "evt_no_usage_entitlement",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "NO_MATCHING_ENTITLEMENT",
      }),
    ])
  })

  it("routes processable events through a stable stream identity", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_stream",
      idempotencyKey: "idem_stream",
      timestamp,
      properties: {
        amount: 7,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.getEntitlementWindowStub).toHaveBeenCalledTimes(1)
    expect(mocks.getEntitlementWindowStub.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        streamId: "stream_123",
      })
    )
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "stream_123",
        featureSlug: "api_calls",
        limit: 100,
      })
    )
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        idempotencyKey: "idem_stream",
        status: "processed",
      }),
    ])
  })

  it("passes billing currency and feature plan version id to the entitlement window apply input", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [
        createUsageGrant({
          currency: "EUR",
          featurePlanVersionId: "fpv_billing_123",
        }),
      ],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_currency",
      idempotencyKey: "idem_currency",
      timestamp,
      properties: {
        amount: 7,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "EUR",
        featurePlanVersionId: "fpv_billing_123",
      })
    )
  })

  it("retries the entire group when processing fails with an unrecoverable error", async () => {
    const { consumer, mocks } = createServiceHarness({
      customer: null,
    })

    // Override getGrantsForCustomer to throw instead of returning a result
    mocks.getGrantsForCustomer.mockRejectedValue(new Error("unrecoverable DB error"))

    const message = createBatchMessage({
      id: "evt_processing_failure",
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid aggregation payloads without calling the entitlement DO", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_invalid_aggregation",
      timestamp,
      properties: {},
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
      }),
    ])
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it("accepts parseable numeric-string aggregation payloads and processes the event", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const message = createBatchMessage({
      id: "evt_valid_numeric_string_aggregation",
      timestamp,
      properties: {
        amount: "4.5",
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.resolveIngestionStatesFromGrants).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "processed",
      }),
    ])
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it("rejects ingestion with INVALID_ENTITLEMENT_CONFIGURATION when grant resolution fails", async () => {
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolveIngestionStatesError: new Error("bad grant configuration"),
    })
    const message = createBatchMessage({
      id: "evt_invalid_entitlement_config",
      properties: {
        amount: 2,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
      }),
    ])
  })

  it("rejects ingestion with INVALID_ENTITLEMENT_CONFIGURATION when period key calculation throws", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [
        createResolvedState(timestamp, {
          resetConfig: {
            name: "daily",
            resetInterval: "day",
            resetIntervalCount: 1,
            resetAnchor: 99,
            planType: "recurring",
          },
        }),
      ],
    })
    const message = createBatchMessage({
      id: "evt_invalid_period_config",
      timestamp,
      properties: {
        amount: 3,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "rejected",
        rejectionReason: "INVALID_ENTITLEMENT_CONFIGURATION",
      }),
    ])
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "invalid resolved-state period configuration for ingestion",
      expect.objectContaining({
        event: expect.objectContaining({
          id: "evt_invalid_period_config",
        }),
        invalidStates: expect.arrayContaining([
          expect.objectContaining({
            featureSlug: "api_calls",
            streamId: "stream_123",
            errorMessage: expect.stringContaining("daily intervals"),
          }),
        ]),
      })
    )
  })

  it("ingests a single feature synchronously using waitUntil for the audit commit", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const state = createResolvedState(timestamp)
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [state],
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
    })
    const message = createBatchMessage({
      id: "evt_sync_feature",
      timestamp,
      properties: {
        amount: 5,
      },
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: true,
      message: undefined,
      rejectionReason: undefined,
      state: "processed",
    })
    expect(mocks.resolveFeatureStateAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        featureSlug: "api_calls",
        projectId: "proj_123",
        timestamp,
      })
    )
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        enforceLimit: true,
        featureSlug: "api_calls",
      })
    )
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1)
  })

  it("enforces sync limits and verify reports only persisted usage", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const state = createResolvedState(timestamp, {
      limit: 10,
      meterConfig: {
        eventId: "meter_limit",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
    })
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [state],
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
    })
    const firstMessage = createBatchMessage({
      id: "evt_sync_allowed",
      idempotencyKey: "idem_sync_allowed",
      timestamp,
      properties: {
        amount: 7,
      },
    }).message.body
    const secondMessage = createBatchMessage({
      id: "evt_sync_denied",
      idempotencyKey: "idem_sync_denied",
      timestamp: timestamp + 1,
      properties: {
        amount: 5,
      },
    }).message.body

    const firstResult = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message: firstMessage,
    })
    const secondResult = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message: secondMessage,
    })
    const verifyResult = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: timestamp + 1,
    })

    expect(firstResult).toEqual({
      allowed: true,
      message: undefined,
      rejectionReason: undefined,
      state: "processed",
    })
    expect(secondResult).toEqual({
      allowed: false,
      message: expect.stringContaining("Limit exceeded"),
      rejectionReason: "LIMIT_EXCEEDED",
      state: "rejected",
    })
    expect(verifyResult).toEqual(
      expect.objectContaining({
        allowed: true,
        status: "usage",
        usage: 7,
        limit: 10,
        isLimitReached: false,
      })
    )
    expect(mocks.apply).toHaveBeenCalledTimes(2)
    expect(mocks.apply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        enforceLimit: true,
      })
    )
    expect(mocks.apply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        enforceLimit: true,
      })
    )
  })

  it("batches audit commits per touched shard instead of per event", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const [firstKey, secondKey] = findIdempotencyKeysForSameAuditShard()
    const { consumer, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [createResolvedState(timestamp)],
    })
    const firstMessage = createBatchMessage({
      id: "evt_same_shard_1",
      idempotencyKey: firstKey,
      timestamp,
      properties: { amount: 2 },
    })
    const secondMessage = createBatchMessage({
      id: "evt_same_shard_2",
      idempotencyKey: secondKey,
      timestamp: timestamp + 1,
      properties: { amount: 3 },
    })

    await consumer.consumeBatch({
      messages: [firstMessage.message, secondMessage.message],
    } as unknown as IngestionQueueBatch)

    const expectedShardIndex = selectIngestionAuditShardIndex(firstKey)

    expect(selectIngestionAuditShardIndex(secondKey)).toBe(expectedShardIndex)
    expect(mocks.getAuditStub).toHaveBeenCalledTimes(1)
    expect(mocks.getAuditStub).toHaveBeenCalledWith({
      customerId: "cus_123",
      projectId: "proj_123",
      shardIndex: expectedShardIndex,
    })
    expect(mocks.commit).toHaveBeenCalledTimes(1)
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        idempotencyKey: firstKey,
        status: "processed",
      }),
      expect.objectContaining({
        idempotencyKey: secondKey,
        status: "processed",
      }),
    ])
  })

  it("rejects synchronous feature ingestion when the customer is missing", async () => {
    const { service, mocks } = createServiceHarness({
      customer: null,
    })
    const message = createBatchMessage({
      id: "evt_sync_missing_customer",
    }).message.body

    const result = await service.ingestFeatureSync({
      featureSlug: "api_calls",
      message,
    })

    expect(result).toEqual({
      allowed: false,
      message: undefined,
      rejectionReason: "CUSTOMER_NOT_FOUND",
      state: "rejected",
    })
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1)
  })

  it("returns an active non-usage feature without meter state", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service, mocks } = createServiceHarness({
      grants: [createBooleanGrant()],
      resolvedFeatureState: {
        kind: "non_usage",
        entitlement: {
          featureType: "flat",
        } as never,
      },
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "team_members",
      projectId: "proj_123",
      timestamp,
    })

    expect(result).toEqual({
      allowed: true,
      featureSlug: "team_members",
      featureType: "flat",
      status: "non_usage",
      timestamp,
    })
    expect(mocks.getEnforcementState).not.toHaveBeenCalled()
  })

  it("returns invalid_entitlement_configuration for verify when feature state resolution fails", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const { service } = createServiceHarness({
      grants: [createUsageGrant()],
      resolveFeatureStateError: new Error("bad feature config"),
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp,
    })

    expect(result).toEqual({
      allowed: false,
      featureSlug: "api_calls",
      message: "bad feature config",
      status: "invalid_entitlement_configuration",
      timestamp,
    })
  })

  it("returns invalid_entitlement_configuration for verify when period key calculation throws", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const invalidState = createResolvedState(timestamp, {
      resetConfig: {
        name: "daily",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 99,
        planType: "recurring",
      },
    })
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([invalidState]),
      resolvedStates: [invalidState],
    })

    const result = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp,
    })

    expect(result).toEqual({
      allowed: false,
      featureSlug: "api_calls",
      featureType: "usage",
      message: "Unable to resolve the current meter window for this feature",
      status: "invalid_entitlement_configuration",
      timestamp,
    })
    expect(mocks.getEnforcementState).not.toHaveBeenCalled()
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "invalid resolved-state period configuration for feature verification",
      expect.objectContaining({
        featureSlug: "api_calls",
      })
    )
  })

  it("fans out one async event to five entitlements and verify returns per-feature usage", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const states = [
      createResolvedState(timestamp, {
        featureSlug: "feature_sum",
        streamId: "stream_sum",
        meterConfig: {
          eventId: "meter_sum",
          eventSlug: "tokens_used",
          aggregationMethod: "sum",
          aggregationField: "amount",
        },
      }),
      createResolvedState(timestamp, {
        featureSlug: "feature_count",
        streamId: "stream_count",
        limit: 3,
        meterConfig: {
          eventId: "meter_count",
          eventSlug: "tokens_used",
          aggregationMethod: "count",
        },
      }),
      createResolvedState(timestamp, {
        featureSlug: "feature_max",
        streamId: "stream_max",
        meterConfig: {
          eventId: "meter_max",
          eventSlug: "tokens_used",
          aggregationMethod: "max",
          aggregationField: "peak",
        },
      }),
      createResolvedState(timestamp, {
        featureSlug: "feature_latest",
        streamId: "stream_latest",
        meterConfig: {
          eventId: "meter_latest",
          eventSlug: "tokens_used",
          aggregationMethod: "latest",
          aggregationField: "current",
        },
      }),
      createResolvedState(timestamp, {
        featureSlug: "feature_sum_text",
        streamId: "stream_sum_text",
        meterConfig: {
          eventId: "meter_sum_text",
          eventSlug: "tokens_used",
          aggregationMethod: "sum",
          aggregationField: "creditsText",
        },
      }),
    ]
    const { consumer, service, mocks } = createServiceHarness({
      grants: states.map((state) =>
        createUsageGrant({
          featureSlug: state.featureSlug,
        })
      ),
      resolvedStates: states,
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug(states),
    })
    const message = createBatchMessage({
      id: "evt_fan_out",
      idempotencyKey: "idem_fan_out",
      timestamp,
      properties: {
        amount: 7,
        peak: 11,
        current: 9,
        creditsText: "4.5",
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    expect(mocks.apply).toHaveBeenCalledTimes(5)
    for (const call of mocks.apply.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          enforceLimit: false,
        })
      )
    }

    const [sumFeature, countFeature, maxFeature, latestFeature, sumTextFeature] = await Promise.all(
      [
        service.verifyFeatureStatus({
          customerId: "cus_123",
          featureSlug: "feature_sum",
          projectId: "proj_123",
          timestamp,
        }),
        service.verifyFeatureStatus({
          customerId: "cus_123",
          featureSlug: "feature_count",
          projectId: "proj_123",
          timestamp,
        }),
        service.verifyFeatureStatus({
          customerId: "cus_123",
          featureSlug: "feature_max",
          projectId: "proj_123",
          timestamp,
        }),
        service.verifyFeatureStatus({
          customerId: "cus_123",
          featureSlug: "feature_latest",
          projectId: "proj_123",
          timestamp,
        }),
        service.verifyFeatureStatus({
          customerId: "cus_123",
          featureSlug: "feature_sum_text",
          projectId: "proj_123",
          timestamp,
        }),
      ]
    )

    expect(sumFeature).toEqual(expect.objectContaining({ status: "usage", usage: 7 }))
    expect(countFeature).toEqual(expect.objectContaining({ status: "usage", usage: 1 }))
    expect(maxFeature).toEqual(expect.objectContaining({ status: "usage", usage: 11 }))
    expect(latestFeature).toEqual(expect.objectContaining({ status: "usage", usage: 9 }))
    expect(sumTextFeature).toEqual(expect.objectContaining({ status: "usage", usage: 4.5 }))
    // batch ingest populates the shared cache; verify calls within the same bucket reuse it
    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(1)
  })

  it("reloads grant context when verify crosses the in-memory cache bucket", async () => {
    const baseTimestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const state = createResolvedState(baseTimestamp)
    const { service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
      resolvedStates: [state],
      now: () => baseTimestamp,
    })

    await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: baseTimestamp,
    })

    await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp: baseTimestamp + 300_000,
    })

    expect(mocks.getGrantsForCustomer).toHaveBeenCalledTimes(2)
  })

  it("keeps async ingestion non-blocking when usage exceeds limits and verify reports limit reached", async () => {
    const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
    const state = createResolvedState(timestamp, {
      limit: 5,
      meterConfig: {
        eventId: "meter_async_limit",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
    })
    const { consumer, service, mocks } = createServiceHarness({
      grants: [createUsageGrant()],
      resolvedStates: [state],
      resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
    })
    const message = createBatchMessage({
      id: "evt_async_limit",
      idempotencyKey: "idem_async_limit",
      timestamp,
      properties: {
        amount: 10,
      },
    })

    await consumer.consumeBatch({
      messages: [message.message],
    } as unknown as IngestionQueueBatch)

    const verifyResult = await service.verifyFeatureStatus({
      customerId: "cus_123",
      featureSlug: "api_calls",
      projectId: "proj_123",
      timestamp,
    })

    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
    expect(mocks.commit).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "processed",
      }),
    ])
    expect(verifyResult).toEqual(
      expect.objectContaining({
        allowed: false,
        status: "usage",
        usage: 10,
        limit: 5,
        isLimitReached: true,
      })
    )
  })

  it.each([
    {
      aggregationMethod: "sum" as const,
      aggregationField: "amount",
      expectedUsage: 4.25,
      properties: {
        amount: "4.25",
      },
    },
    {
      aggregationMethod: "count" as const,
      aggregationField: undefined,
      expectedUsage: 1,
      properties: {},
    },
    {
      aggregationMethod: "max" as const,
      aggregationField: "peak",
      expectedUsage: 8,
      properties: {
        peak: 8,
      },
    },
    {
      aggregationMethod: "latest" as const,
      aggregationField: "current",
      expectedUsage: 6,
      properties: {
        current: 6,
      },
    },
  ])(
    "processes async payloads for $aggregationMethod meters and verify returns exact usage",
    async (scenario) => {
      const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
      const state = createResolvedState(timestamp, {
        featureSlug: "feature_matrix",
        streamId: `stream_${scenario.aggregationMethod}`,
        meterConfig: {
          eventId: `meter_${scenario.aggregationMethod}`,
          eventSlug: "tokens_used",
          aggregationMethod: scenario.aggregationMethod,
          ...(scenario.aggregationField ? { aggregationField: scenario.aggregationField } : {}),
        },
      })
      const { consumer, service } = createServiceHarness({
        grants: [
          createUsageGrant({
            featureSlug: "feature_matrix",
          }),
        ],
        resolvedStates: [state],
        resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
      })
      const message = createBatchMessage({
        id: `evt_matrix_${scenario.aggregationMethod}`,
        idempotencyKey: `idem_matrix_${scenario.aggregationMethod}`,
        timestamp,
        properties: scenario.properties,
      })

      await consumer.consumeBatch({
        messages: [message.message],
      } as unknown as IngestionQueueBatch)

      const verifyResult = await service.verifyFeatureStatus({
        customerId: "cus_123",
        featureSlug: "feature_matrix",
        projectId: "proj_123",
        timestamp,
      })

      expect(verifyResult).toEqual(
        expect.objectContaining({
          status: "usage",
          usage: scenario.expectedUsage,
        })
      )
    }
  )

  it.each([
    {
      aggregationMethod: "sum" as const,
      aggregationField: "amount",
      properties: {},
    },
    {
      aggregationMethod: "max" as const,
      aggregationField: "peak",
      properties: {
        peak: "invalid",
      },
    },
    {
      aggregationMethod: "latest" as const,
      aggregationField: "current",
      properties: {},
    },
  ])(
    "rejects invalid async aggregation payloads for $aggregationMethod with INVALID_AGGREGATION_PROPERTIES",
    async (scenario) => {
      const timestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
      const state = createResolvedState(timestamp, {
        featureSlug: "feature_invalid_payload",
        streamId: `stream_invalid_${scenario.aggregationMethod}`,
        meterConfig: {
          eventId: `meter_invalid_${scenario.aggregationMethod}`,
          eventSlug: "tokens_used",
          aggregationMethod: scenario.aggregationMethod,
          aggregationField: scenario.aggregationField,
        },
      })
      const { consumer, mocks } = createServiceHarness({
        grants: [
          createUsageGrant({
            featureSlug: "feature_invalid_payload",
          }),
        ],
        resolvedStates: [state],
        resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
      })
      const message = createBatchMessage({
        id: `evt_invalid_${scenario.aggregationMethod}`,
        idempotencyKey: `idem_invalid_${scenario.aggregationMethod}`,
        timestamp,
        properties: scenario.properties,
      })

      await consumer.consumeBatch({
        messages: [message.message],
      } as unknown as IngestionQueueBatch)

      expect(message.ack).toHaveBeenCalledTimes(1)
      expect(message.retry).not.toHaveBeenCalled()
      expect(mocks.apply).not.toHaveBeenCalled()
      expect(mocks.commit).toHaveBeenCalledWith([
        expect.objectContaining({
          status: "rejected",
          rejectionReason: "INVALID_AGGREGATION_PROPERTIES",
        }),
      ])
    }
  )

  it.each([
    {
      aggregationMethod: "sum" as const,
      aggregationField: "amount",
      events: [
        { id: "evt_sum_1", offsetMs: 2_000, properties: { amount: 2 } },
        { id: "evt_sum_2", offsetMs: 0, properties: { amount: 3 } },
        { id: "evt_sum_3", offsetMs: 1_000, properties: { amount: 1 } },
      ],
      expectedUsage: 6,
    },
    {
      aggregationMethod: "count" as const,
      aggregationField: undefined,
      events: [
        { id: "evt_count_1", offsetMs: 2_000, properties: {} },
        { id: "evt_count_2", offsetMs: 0, properties: {} },
        { id: "evt_count_3", offsetMs: 1_000, properties: {} },
      ],
      expectedUsage: 3,
    },
    {
      aggregationMethod: "max" as const,
      aggregationField: "peak",
      events: [
        { id: "evt_max_1", offsetMs: 2_000, properties: { peak: 3 } },
        { id: "evt_max_2", offsetMs: 0, properties: { peak: 9 } },
        { id: "evt_max_3", offsetMs: 1_000, properties: { peak: 4 } },
      ],
      expectedUsage: 9,
    },
    {
      aggregationMethod: "latest" as const,
      aggregationField: "current",
      events: [
        { id: "evt_latest_1", offsetMs: 2_000, properties: { current: 5 } },
        { id: "evt_latest_2", offsetMs: 0, properties: { current: 2 } },
        { id: "evt_latest_3", offsetMs: 1_000, properties: { current: 7 } },
      ],
      expectedUsage: 5,
    },
  ])(
    "keeps verify usage consistent with ingested async stream for $aggregationMethod",
    async (scenario) => {
      const baseTimestamp = Date.UTC(2026, 2, 19, 12, 0, 0)
      const state = createResolvedState(baseTimestamp, {
        featureSlug: `feature_consistency_${scenario.aggregationMethod}`,
        streamId: `stream_consistency_${scenario.aggregationMethod}`,
        meterConfig: {
          eventId: `meter_consistency_${scenario.aggregationMethod}`,
          eventSlug: "tokens_used",
          aggregationMethod: scenario.aggregationMethod,
          ...(scenario.aggregationField ? { aggregationField: scenario.aggregationField } : {}),
        },
      })
      const { consumer, service, mocks } = createServiceHarness({
        grants: [
          createUsageGrant({
            featureSlug: `feature_consistency_${scenario.aggregationMethod}`,
          }),
        ],
        resolvedStates: [state],
        resolvedFeatureStatesBySlug: mapFeatureStatesBySlug([state]),
      })
      const batchMessages = scenario.events.map(
        (event, index) =>
          createBatchMessage({
            id: event.id,
            idempotencyKey: `idem_consistency_${scenario.aggregationMethod}_${index}`,
            timestamp: baseTimestamp + event.offsetMs,
            properties: event.properties,
          }).message
      )

      await consumer.consumeBatch({
        messages: batchMessages,
      } as unknown as IngestionQueueBatch)

      const verifyResult = await service.verifyFeatureStatus({
        customerId: "cus_123",
        featureSlug: `feature_consistency_${scenario.aggregationMethod}`,
        projectId: "proj_123",
        timestamp: baseTimestamp + 2_000,
      })

      expect(mocks.commit).toHaveBeenCalled()
      expect(verifyResult).toEqual(
        expect.objectContaining({
          status: "usage",
          usage: scenario.expectedUsage,
        })
      )
    }
  )

  it("builds the same payload hash when property order changes", async () => {
    const message = createBatchMessage({
      id: "evt_hash_order_a",
      properties: {
        b: 2,
        nested: {
          y: 2,
          x: 1,
        },
        a: 1,
      },
    }).message.body
    const reorderedMessage = createBatchMessage({
      id: "evt_hash_order_b",
      properties: {
        a: 1,
        nested: {
          x: 1,
          y: 2,
        },
        b: 2,
      },
    }).message.body

    const [leftHash, rightHash] = await Promise.all([
      computePayloadHash(message),
      computePayloadHash(reorderedMessage),
    ])

    expect(leftHash).toBe(rightHash)
  })

  it("ignores generated event id differences when hashing the same event payload", async () => {
    const baseMessage = createBatchMessage({
      id: "evt_generated_a",
      properties: {
        amount: 5,
      },
    }).message.body
    const retriedMessage = createBatchMessage({
      id: "evt_generated_b",
      properties: {
        amount: 5,
      },
    }).message.body

    const [leftHash, rightHash] = await Promise.all([
      computePayloadHash(baseMessage),
      computePayloadHash(retriedMessage),
    ])

    expect(leftHash).toBe(rightHash)
  })

  it("changes the payload hash when business payload changes", async () => {
    const original = createBatchMessage({
      properties: {
        amount: 5,
      },
    }).message.body
    const changed = createBatchMessage({
      properties: {
        amount: 6,
      },
    }).message.body

    const [leftHash, rightHash] = await Promise.all([
      computePayloadHash(original),
      computePayloadHash(changed),
    ])

    expect(leftHash).not.toBe(rightHash)
  })
})

function findIdempotencyKeysForSameAuditShard(): [string, string] {
  const keysByShard = new Map<number, string>()

  for (let index = 0; index < 1_000; index++) {
    const candidate = `idem_same_shard_${index}`
    const shardIndex = selectIngestionAuditShardIndex(candidate)
    const existing = keysByShard.get(shardIndex)

    if (existing) {
      return [existing, candidate]
    }

    keysByShard.set(shardIndex, candidate)
  }

  throw new Error("Unable to find two idempotency keys on the same audit shard")
}
