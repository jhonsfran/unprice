import { OpenAPIHono } from "@hono/zod-openapi"
import type { Analytics } from "@unprice/analytics"
import { FetchError } from "@unprice/error"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UnpriceApiError } from "~/errors"
import type { HonoEnv } from "~/hono/env"

const authMocks = vi.hoisted(() => ({
  keyAuth: vi.fn(),
}))

vi.mock("~/auth/key", () => ({
  keyAuth: authMocks.keyAuth,
}))

import { registerGetIngestionStatusV1 } from "./getIngestionStatusV1"

const fromTs = 1_780_000_000_000
const toTs = 1_780_000_010_000
const now = 1_780_000_006_500

const verifiedKey = {
  id: "key_123",
  projectId: "proj_123",
  project: {
    id: "proj_123",
    workspaceId: "ws_123",
    defaultCurrency: "USD",
    isInternal: false,
    isMain: false,
    workspace: {
      isMain: false,
      unPriceCustomerId: null,
    },
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  authMocks.keyAuth.mockResolvedValue(verifiedKey)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("getIngestionStatusV1 route", () => {
  it("returns computed customer ingestion status", async () => {
    const { app, env, executionCtx, getIngestionLive, getIngestionRejections, getIngestionRecent } =
      createTestApp({
        liveRows: [
          {
            second: "2026-06-05 12:00:00",
            processed: 2,
            rejected: 1,
            failed: 0,
            total: 3,
          },
          {
            second: "2026-06-05 12:00:01",
            processed: 1,
            rejected: 0,
            failed: 0,
            total: 1,
          },
        ],
        rejectionRows: [
          {
            rejection_reason: "missing_entitlement",
            event_slug: "usage.recorded",
            source_id: "src_1",
            source_type: "api_key",
            event_count: 1,
            last_seen_at: fromTs + 5_000,
          },
          {
            rejection_reason: "wrong_source",
            event_slug: "usage.recorded",
            source_id: "src_2",
            source_type: "api_key",
            event_count: 4,
            last_seen_at: fromTs + 4_000,
          },
        ],
        recentRows: [
          makeRecentEvent({
            event_id: "evt_1",
            canonical_audit_id: "audit_1",
            state: "processed",
            rejection_reason: null,
            handled_at: fromTs + 5_500,
          }),
          makeRecentEvent({
            event_id: "evt_2",
            canonical_audit_id: "audit_2",
            source_id: "src_2",
            state: "rejected",
            rejection_reason: "wrong_source",
            handled_at: fromTs + 5_250,
          }),
          makeRecentEvent({
            event_id: "evt_3",
            canonical_audit_id: "audit_3",
            handled_at: fromTs - 1,
          }),
        ],
      })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        from_ts: fromTs,
        to_ts: toTs,
        source_id: "src_1",
        event_slug: "usage.recorded",
        limit: 2,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      window: {
        from: fromTs,
        to: toTs,
      },
      totals: {
        processed: 3,
        rejected: 1,
        failed: 0,
        total: 4,
      },
      successRate: 0.75,
      freshness: {
        generatedAt: now,
        dataFrom: fromTs,
        dataTo: fromTs + 5_500,
        latestHandledAt: fromTs + 5_500,
        secondsSinceLatest: 1,
      },
      live: [
        {
          second: "2026-06-05 12:00:00",
          processed: 2,
          rejected: 1,
          failed: 0,
          total: 3,
        },
        {
          second: "2026-06-05 12:00:01",
          processed: 1,
          rejected: 0,
          failed: 0,
          total: 1,
        },
      ],
      rejections: [
        {
          rejectionReason: "missing_entitlement",
          eventSlug: "usage.recorded",
          sourceId: "src_1",
          sourceType: "api_key",
          eventCount: 1,
          lastSeenAt: fromTs + 5_000,
        },
      ],
      recentEvents: [
        {
          eventId: "evt_1",
          canonicalAuditId: "audit_1",
          customerId: "cus_123",
          eventSlug: "usage.recorded",
          sourceType: "api_key",
          sourceId: "src_1",
          state: "processed",
          rejectionReason: null,
          failureStage: null,
          failureReason: null,
          failureMessage: null,
          replayable: false,
          timestamp: fromTs - 100,
          receivedAt: fromTs + 100,
          handledAt: fromTs + 5_500,
        },
      ],
      nextCursor: null,
      answer:
        "4 events were observed in the requested window for customer cus_123 (1780000000000 to 1780000010000). 3 were processed, 1 were rejected, and 0 failed, for a 75% success rate.",
      confidence: "high",
      evidence: [
        {
          type: "ingestion_status",
          id: "proj_123:cus_123:1780000000000:1780000010000",
          source: "tinybird",
          timestamp: fromTs + 5_500,
        },
        {
          type: "ingestion_status",
          id: "live:2026-06-05 12:00:00",
          source: "tinybird",
          timestamp: Date.parse("2026-06-05T12:00:00Z"),
        },
        {
          type: "ingestion_status",
          id: "live:2026-06-05 12:00:01",
          source: "tinybird",
          timestamp: Date.parse("2026-06-05T12:00:01Z"),
        },
        {
          type: "ingestion_status",
          id: "rejection:src_1:usage.recorded:missing_entitlement:1780000005000",
          source: "tinybird",
          timestamp: fromTs + 5_000,
        },
        {
          type: "event",
          id: "evt_1",
          source: "tinybird",
          timestamp: fromTs + 5_500,
        },
      ],
      warnings: ["Some ingestion events were rejected or failed in the requested window."],
      nextActions: [
        "Inspect rejected or failed events and fix the reported reasons: missing_entitlement",
      ],
    })
    expect(getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
    })
    expect(getIngestionRejections).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
      limit: 2,
    })
    expect(getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      from_ts: fromTs,
      to_ts: toTs,
      source_id: "src_1",
      event_slug: "usage.recorded",
      limit: 3,
    })
  })

  it("returns zeros and a no-events answer for an empty requested window", async () => {
    const { app, env, executionCtx, getIngestionRejections } = createTestApp({
      recentRows: [
        makeRecentEvent({
          event_id: "evt_outside_window",
          canonical_audit_id: "audit_outside_window",
          handled_at: fromTs - 1,
        }),
      ],
    })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_empty",
        from_ts: fromTs,
        to_ts: toTs,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      window: {
        from: fromTs,
        to: toTs,
      },
      totals: {
        processed: 0,
        rejected: 0,
        failed: 0,
        total: 0,
      },
      successRate: 0,
      freshness: {
        generatedAt: now,
        dataFrom: fromTs,
        dataTo: toTs,
        latestHandledAt: null,
        secondsSinceLatest: null,
      },
      live: [],
      rejections: [],
      recentEvents: [],
      nextCursor: null,
      answer: "No events were observed in the requested window for customer cus_empty.",
      confidence: "low",
      evidence: [
        {
          type: "ingestion_status",
          id: "proj_123:cus_empty:1780000000000:1780000010000",
          source: "tinybird",
          timestamp: null,
        },
      ],
      warnings: ["No ingestion events were observed in the requested window."],
      nextActions: ["Verify the customer_id, source_id, event_slug, and time window."],
    })
    expect(body.answer).toContain("No events were observed in the requested window")
    expect(getIngestionRejections).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_empty",
      from_ts: fromTs,
      to_ts: toTs,
      limit: 50,
    })
  })

  it("rejects invalid windows before auth", async () => {
    const { app, env, executionCtx, getIngestionLive } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_invalid",
        from_ts: toTs,
        to_ts: fromTs,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(400)
    expect(authMocks.keyAuth).not.toHaveBeenCalled()
    expect(getIngestionLive).not.toHaveBeenCalled()
  })

  it("maps Tinybird failures to internal server errors", async () => {
    const { app, env, executionCtx } = createTestApp({
      liveError: new Error("tinybird unavailable"),
    })

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        from_ts: fromTs,
        to_ts: toTs,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        code: "INTERNAL_SERVER_ERROR",
        message: "tinybird unavailable",
      })
    )
  })

  it("returns project-wide ingestion status when customer_id is omitted", async () => {
    const { app, env, executionCtx, getIngestionLive, getIngestionRecent } = createTestApp({
      liveRows: [
        {
          second: "2026-06-05 12:00:00",
          processed: 1,
          rejected: 0,
          failed: 0,
          total: 1,
        },
      ],
      recentRows: [
        makeRecentEvent({
          event_id: "evt_project",
          customer_id: "cus_456",
          state: "processed",
          handled_at: fromTs + 5_500,
        }),
      ],
    })

    const response = await app.fetch(
      buildRequest({
        from_ts: fromTs,
        to_ts: toTs,
        state: "processed",
        cursor: {
          handledAt: fromTs + 8_000,
          canonicalAuditId: "audit_cursor",
        },
        limit: 5,
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.recentEvents).toEqual([
      expect.objectContaining({
        eventId: "evt_project",
        customerId: "cus_456",
        state: "processed",
      }),
    ])
    expect(body.answer).toContain("project proj_123")
    expect(getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_123",
      from_ts: fromTs,
      to_ts: toTs,
      state: "processed",
    })
    expect(getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_123",
      from_ts: fromTs,
      to_ts: toTs,
      state: "processed",
      cursor_handled_at: fromTs + 8_000,
      cursor_canonical_audit_id: "audit_cursor",
      limit: 6,
    })
  })

  it("accepts failed state filters", async () => {
    const { app, env, executionCtx, getIngestionLive, getIngestionRecent } = createTestApp()

    const response = await app.fetch(
      buildRequest({
        customer_id: "cus_123",
        from_ts: fromTs,
        to_ts: toTs,
        state: "failed",
      }),
      env,
      executionCtx
    )

    expect(response.status).toBe(200)
    expect(getIngestionLive).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      from_ts: fromTs,
      to_ts: toTs,
      state: "failed",
    })
    expect(getIngestionRecent).toHaveBeenCalledWith({
      project_id: "proj_123",
      customer_id: "cus_123",
      from_ts: fromTs,
      to_ts: toTs,
      state: "failed",
      limit: 51,
    })
  })
})

function createTestApp(
  options: {
    liveRows?: Array<Record<string, unknown>>
    rejectionRows?: Array<Record<string, unknown>>
    recentRows?: Array<Record<string, unknown>>
    liveError?: Error
  } = {}
) {
  const app = new OpenAPIHono<HonoEnv>()
  const getIngestionLive = vi.fn(() => {
    if (options.liveError) {
      return Promise.reject(
        new FetchError({
          message: options.liveError.message,
          retry: true,
        })
      )
    }

    return Promise.resolve({ data: options.liveRows ?? [] })
  })
  const getIngestionRejections = vi.fn().mockResolvedValue({ data: options.rejectionRows ?? [] })
  const getIngestionRecent = vi.fn().mockResolvedValue({ data: options.recentRows ?? [] })

  app.use(timing())

  app.onError((error, c) => {
    if (error instanceof UnpriceApiError) {
      return c.json({ code: error.code, message: error.message }, error.status)
    }

    throw error
  })

  app.use("*", async (c, next) => {
    c.set("analytics", {
      getIngestionLive,
      getIngestionRejections,
      getIngestionRecent,
    } as unknown as Analytics)

    await next()
  })

  registerGetIngestionStatusV1(app)

  const env = {
    APP_ENV: "development",
  }

  const executionCtx = {
    passThroughOnException: vi.fn(),
    waitUntil: vi.fn(),
  } as unknown as ExecutionContext

  return { app, env, executionCtx, getIngestionLive, getIngestionRejections, getIngestionRecent }
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("https://example.com/v1/ingestion-events/status", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

function makeRecentEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_1",
    canonical_audit_id: "audit_1",
    customer_id: "cus_123",
    event_slug: "usage.recorded",
    source_type: "api_key",
    source_id: "src_1",
    state: "processed",
    rejection_reason: null,
    failure_stage: null,
    failure_reason: null,
    failure_message: null,
    replayable: false,
    timestamp: fromTs - 100,
    received_at: fromTs + 100,
    handled_at: fromTs + 1_000,
    ...overrides,
  }
}
