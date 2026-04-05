import type { Entitlement } from "@unprice/db/validators"
import { describe, expect, it } from "vitest"
import type { IngestionResolvedState, RawEvent } from "../entitlements"
import {
  type IngestionQueueConsumerMessage,
  buildEntitlementWindowName,
  computeEntitlementPeriodKey,
  computeResolvedStatePeriodKey,
  filterEntitlementsWithValidAggregationPayload,
  filterMatchingEntitlements,
  filterMatchingResolvedStates,
  filterResolvedStatesWithValidAggregationPayload,
  ingestionQueueMessageSchema,
  partitionDuplicateQueuedMessages,
  sortQueuedMessages,
} from "./message"

describe("ingestion message helpers", () => {
  it("builds a stable entitlement window name", () => {
    expect(
      buildEntitlementWindowName({
        appEnv: "development",
        projectId: "proj_123",
        customerId: "cus_123",
        entitlementId: "ent_123",
        periodKey: "month:1740787200000",
      })
    ).toBe("development:proj_123:cus_123:ent_123:month:1740787200000")
  })

  it("returns null period keys outside the entitlement window", () => {
    const entitlement = createEntitlement({
      effectiveAt: Date.UTC(2026, 2, 10),
      expiresAt: Date.UTC(2026, 2, 20),
    })

    expect(computeEntitlementPeriodKey(entitlement, Date.UTC(2026, 2, 9))).toBeNull()
    expect(computeEntitlementPeriodKey(entitlement, Date.UTC(2026, 2, 20))).toBeNull()
  })

  it("uses the entitlement business window start as the period anchor after a trial boundary", () => {
    const paidWindowStart = Date.UTC(2026, 2, 15)
    const entitlement = createEntitlement({
      effectiveAt: paidWindowStart,
      expiresAt: Date.UTC(2026, 3, 15),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })

    expect(computeEntitlementPeriodKey(entitlement, Date.UTC(2026, 2, 20))).toBe(
      `month:${paidWindowStart}`
    )
  })

  it("returns null resolved-state period keys outside the stream window", () => {
    const state = createResolvedState({
      streamStartAt: Date.UTC(2026, 2, 10),
      streamEndAt: Date.UTC(2026, 2, 20),
    })

    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 2, 9))).toBeNull()
    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 2, 20))).toBeNull()
  })

  it("uses one-time period keys when resolved state has no reset config", () => {
    const streamStartAt = Date.UTC(2026, 2, 10, 8, 0, 0)
    const state = createResolvedState({
      streamStartAt,
      streamEndAt: Date.UTC(2026, 2, 20, 8, 0, 0),
      resetConfig: null,
    })

    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 2, 15, 12, 0, 0))).toBe(
      `onetime:${streamStartAt}`
    )
  })

  it("computes monthly resolved-state keys and rotates exactly at the monthly anchor", () => {
    const state = createResolvedState({
      streamStartAt: Date.UTC(2026, 2, 15, 0, 0, 0),
      streamEndAt: Date.UTC(2026, 4, 15, 0, 0, 0),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })

    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 3, 14, 23, 59, 59, 999))).toBe(
      `month:${Date.UTC(2026, 2, 15, 0, 0, 0)}`
    )
    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 3, 15, 0, 0, 0, 0))).toBe(
      `month:${Date.UTC(2026, 3, 15, 0, 0, 0)}`
    )
  })

  it("computes daily resolved-state keys using the configured reset hour", () => {
    const state = createResolvedState({
      streamStartAt: Date.UTC(2026, 2, 1, 0, 0, 0),
      resetConfig: {
        name: "daily",
        resetInterval: "day",
        resetIntervalCount: 1,
        resetAnchor: 9,
        planType: "recurring",
      },
    })

    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 2, 2, 8, 59, 59, 999))).toBe(
      `day:${Date.UTC(2026, 2, 1, 9, 0, 0)}`
    )
    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 2, 2, 9, 0, 0, 0))).toBe(
      `day:${Date.UTC(2026, 2, 2, 9, 0, 0)}`
    )
  })

  it("supports custom reset intervals from grant state (every two months)", () => {
    const state = createResolvedState({
      streamStartAt: Date.UTC(2026, 0, 1, 0, 0, 0),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 2,
        resetAnchor: 5,
        planType: "recurring",
      },
    })

    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 3, 10, 0, 0, 0))).toBe(
      `month:${Date.UTC(2026, 2, 5, 0, 0, 0)}`
    )
    expect(computeResolvedStatePeriodKey(state, Date.UTC(2026, 4, 5, 0, 0, 0))).toBe(
      `month:${Date.UTC(2026, 4, 5, 0, 0, 0)}`
    )
  })

  it("matches resolved states against grant-derived stream windows and reset config", () => {
    const historical = createResolvedState({
      streamId: "stream_historical",
      streamStartAt: Date.UTC(2026, 1, 15),
      streamEndAt: Date.UTC(2026, 2, 15),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })
    const current = createResolvedState({
      streamId: "stream_current",
      streamStartAt: Date.UTC(2026, 2, 15),
      streamEndAt: Date.UTC(2026, 3, 15),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })
    const wrongSlug = createResolvedState({
      streamId: "stream_wrong_slug",
      meterConfig: {
        eventId: "meter_wrong_slug",
        eventSlug: "other_event",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
    })

    expect(
      filterMatchingResolvedStates({
        states: [historical, current, wrongSlug],
        event: createRawEvent({
          slug: "tokens_used",
          timestamp: Date.UTC(2026, 2, 10),
        }),
      }).map((state) => state.streamId)
    ).toEqual(["stream_historical"])
  })

  it("filters matching entitlements by feature type, slug, and active period", () => {
    const event = createRawEvent({
      slug: "tokens_used",
      timestamp: Date.UTC(2026, 2, 18, 12, 0, 0),
    })
    const matching = createEntitlement({
      id: "ent_matching",
      meterConfig: {
        eventId: "meter_matching",
        eventSlug: "tokens_used",
        aggregationMethod: "count",
      },
    })
    const wrongSlug = createEntitlement({
      id: "ent_wrong_slug",
      meterConfig: {
        eventId: "meter_wrong_slug",
        eventSlug: "different_event",
        aggregationMethod: "count",
      },
    })
    const wrongType = createEntitlement({
      id: "ent_wrong_type",
      featureType: "flat",
      meterConfig: null,
    })
    const expired = createEntitlement({
      id: "ent_expired",
      expiresAt: Date.UTC(2026, 2, 18, 11, 0, 0),
      meterConfig: {
        eventId: "meter_expired",
        eventSlug: "tokens_used",
        aggregationMethod: "count",
      },
    })

    expect(
      filterMatchingEntitlements({
        entitlements: [matching, wrongSlug, wrongType, expired],
        event,
      }).map((entitlement) => entitlement.id)
    ).toEqual(["ent_matching"])
  })

  it("keeps historical entitlement windows routable for late events after a newer snapshot exists", () => {
    const historical = createEntitlement({
      id: "ent_historical",
      isCurrent: false,
      effectiveAt: Date.UTC(2026, 1, 15),
      expiresAt: Date.UTC(2026, 2, 15),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })
    const current = createEntitlement({
      id: "ent_current",
      effectiveAt: Date.UTC(2026, 2, 15),
      expiresAt: Date.UTC(2026, 3, 15),
      resetConfig: {
        name: "billing",
        resetInterval: "month",
        resetIntervalCount: 1,
        resetAnchor: 15,
        planType: "recurring",
      },
    })

    expect(
      filterMatchingEntitlements({
        entitlements: [historical, current],
        event: createRawEvent({
          timestamp: Date.UTC(2026, 2, 10),
        }),
      }).map((entitlement) => entitlement.id)
    ).toEqual(["ent_historical"])
  })

  it("accepts count meters without aggregation properties and rejects invalid numeric payloads", () => {
    const event = createRawEvent({
      slug: "api_keys",
      properties: {
        amount: 1,
      },
    })
    const countMeter = createEntitlement({
      id: "ent_count",
      meterConfig: {
        eventId: "meter_count",
        eventSlug: "api_keys",
        aggregationMethod: "count",
      },
    })
    const validSumMeter = createEntitlement({
      id: "ent_sum_valid",
      meterConfig: {
        eventId: "meter_sum_valid",
        eventSlug: "api_keys",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
    })
    const missingFieldMeter = createEntitlement({
      id: "ent_sum_missing",
      meterConfig: {
        eventId: "meter_sum_missing",
        eventSlug: "api_keys",
        aggregationMethod: "sum",
        aggregationField: "value",
      },
    })
    const nonNumericMeter = createEntitlement({
      id: "ent_sum_not_numeric",
      meterConfig: {
        eventId: "meter_sum_not_numeric",
        eventSlug: "api_keys",
        aggregationMethod: "sum",
        aggregationField: "label",
      },
    })
    const parseableStringMeter = createEntitlement({
      id: "ent_sum_string_valid",
      meterConfig: {
        eventId: "meter_sum_string_valid",
        eventSlug: "api_keys",
        aggregationMethod: "sum",
        aggregationField: "amountText",
      },
    })

    expect(
      filterEntitlementsWithValidAggregationPayload({
        entitlements: [
          countMeter,
          validSumMeter,
          missingFieldMeter,
          nonNumericMeter,
          parseableStringMeter,
        ],
        event: {
          ...event,
          properties: {
            amount: 1,
            amountText: "2.5",
            label: "one",
          },
        },
      }).map((entitlement) => entitlement.id)
    ).toEqual(["ent_count", "ent_sum_valid", "ent_sum_string_valid"])
  })

  it("accepts parseable numeric strings for resolved states and rejects non-numeric payloads", () => {
    const countState = createResolvedState({
      streamId: "stream_count",
      meterConfig: {
        eventId: "meter_count",
        eventSlug: "tokens_used",
        aggregationMethod: "count",
      },
    })
    const validStringState = createResolvedState({
      streamId: "stream_string_valid",
      meterConfig: {
        eventId: "meter_string_valid",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "amount",
      },
    })
    const validNumberState = createResolvedState({
      streamId: "stream_number_valid",
      meterConfig: {
        eventId: "meter_number_valid",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "tokens",
      },
    })
    const invalidStringState = createResolvedState({
      streamId: "stream_string_invalid",
      meterConfig: {
        eventId: "meter_string_invalid",
        eventSlug: "tokens_used",
        aggregationMethod: "sum",
        aggregationField: "label",
      },
    })

    expect(
      filterResolvedStatesWithValidAggregationPayload({
        states: [countState, validStringState, validNumberState, invalidStringState],
        event: createRawEvent({
          properties: {
            amount: " 3.5 ",
            tokens: 2,
            label: "three",
          },
        }),
      }).map((state) => state.streamId)
    ).toEqual(["stream_count", "stream_string_valid", "stream_number_valid"])
  })

  it("sorts queued messages by timestamp and then idempotency key", () => {
    const later = createQueueMessage({
      timestamp: 20,
      idempotencyKey: "idem_b",
    })
    const earlier = createQueueMessage({
      timestamp: 10,
      idempotencyKey: "idem_c",
    })
    const sameTimeLowerKey = createQueueMessage({
      timestamp: 20,
      idempotencyKey: "idem_a",
    })

    expect([later, earlier, sameTimeLowerKey].sort(sortQueuedMessages)).toEqual([
      earlier,
      sameTimeLowerKey,
      later,
    ])
  })

  it("partitions same-batch duplicates by project, customer, and idempotency key", () => {
    const first = createQueueMessage({
      projectId: "proj_123",
      customerId: "cus_123",
      idempotencyKey: "idem_shared",
      id: "evt_first",
    })
    const duplicate = createQueueMessage({
      projectId: "proj_123",
      customerId: "cus_123",
      idempotencyKey: "idem_shared",
      id: "evt_duplicate",
    })
    const otherCustomer = createQueueMessage({
      projectId: "proj_123",
      customerId: "cus_other",
      idempotencyKey: "idem_shared",
      id: "evt_other_customer",
    })
    const otherProject = createQueueMessage({
      projectId: "proj_other",
      customerId: "cus_123",
      idempotencyKey: "idem_shared",
      id: "evt_other_project",
    })

    const partitioned = partitionDuplicateQueuedMessages([
      first,
      duplicate,
      otherCustomer,
      otherProject,
    ])

    expect(partitioned.unique).toEqual([first, otherCustomer, otherProject])
    expect(partitioned.duplicates).toEqual([duplicate])
  })

  it("requires a flat queue payload with idempotencyKey", () => {
    expect(
      ingestionQueueMessageSchema.parse({
        version: 1,
        projectId: "proj_123",
        customerId: "cus_123",
        requestId: "req_123",
        receivedAt: 1,
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "tokens_used",
        timestamp: 2,
        properties: {
          amount: 1,
        },
      })
    ).toEqual(
      expect.objectContaining({
        idempotencyKey: "idem_123",
        id: "evt_123",
        slug: "tokens_used",
      })
    )

    expect(
      ingestionQueueMessageSchema.safeParse({
        version: 1,
        projectId: "proj_123",
        customerId: "cus_123",
        requestId: "req_123",
        receivedAt: 1,
        id: "evt_123",
        slug: "tokens_used",
        timestamp: 2,
        properties: {},
      }).success
    ).toBe(false)
  })
})

function createRawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: "evt_123",
    slug: "tokens_used",
    timestamp: Date.UTC(2026, 2, 18, 12, 0, 0),
    properties: {},
    ...overrides,
  }
}

function createQueueMessage(overrides: Partial<IngestionQueueConsumerMessage["body"]> = {}) {
  const body: IngestionQueueConsumerMessage["body"] = {
    version: 1,
    projectId: "proj_123",
    customerId: "cus_123",
    requestId: "req_123",
    receivedAt: Date.UTC(2026, 2, 18, 12, 0, 0),
    idempotencyKey: "idem_123",
    id: "evt_123",
    slug: "tokens_used",
    timestamp: Date.UTC(2026, 2, 18, 12, 0, 0),
    properties: {},
    ...overrides,
  }

  return {
    ack: () => {},
    retry: () => {},
    body,
  } satisfies IngestionQueueConsumerMessage
}

function createEntitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  const defaults: Entitlement = {
    id: "ent_default",
    projectId: "proj_123",
    customerId: "cus_123",
    featureSlug: "feature_default",
    featureType: "usage",
    unitOfMeasure: "units",
    resetConfig: null,
    meterConfig: {
      eventId: "meter_default",
      eventSlug: "tokens_used",
      aggregationMethod: "count",
    },
    isCurrent: true,
    mergingPolicy: "sum",
    limit: 100,
    effectiveAt: Date.UTC(2026, 0, 1),
    expiresAt: null,
    grants: [],
    metadata: {
      realtime: false,
      notifyUsageThreshold: 95,
      overageStrategy: "none",
      blockCustomer: false,
      hidden: false,
    },
    createdAtM: Date.UTC(2026, 0, 1),
    updatedAtM: Date.UTC(2026, 0, 1),
  }

  return {
    ...defaults,
    ...overrides,
    meterConfig: overrides.meterConfig ?? defaults.meterConfig,
    metadata: overrides.metadata
      ? { ...defaults.metadata, ...overrides.metadata }
      : defaults.metadata,
    resetConfig: overrides.resetConfig ?? defaults.resetConfig,
  }
}

function createResolvedState(
  overrides: Partial<IngestionResolvedState> = {}
): IngestionResolvedState {
  const defaults: IngestionResolvedState = {
    activeGrantIds: ["grant_123"],
    customerId: "cus_123",
    featureSlug: "api_calls",
    limit: 100,
    meterConfig: {
      eventId: "meter_123",
      eventSlug: "tokens_used",
      aggregationMethod: "sum",
      aggregationField: "amount",
    },
    overageStrategy: "none",
    projectId: "proj_123",
    resetConfig: null,
    streamEndAt: null,
    streamId: "stream_123",
    streamStartAt: Date.UTC(2026, 2, 18, 0, 0, 0),
  }

  return {
    ...defaults,
    ...overrides,
    meterConfig: overrides.meterConfig ?? defaults.meterConfig,
    resetConfig: overrides.resetConfig ?? defaults.resetConfig,
  }
}
