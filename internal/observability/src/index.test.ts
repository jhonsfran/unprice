import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStandaloneRequestLogger, emitWideEvent, initObservability } from "./index"

describe("@unprice/observability", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    initObservability({
      env: {
        service: "test",
        environment: "test",
      },
      pretty: false,
      stringify: false,
      sampling: {
        rates: {
          debug: 100,
          info: 100,
          warn: 100,
          error: 100,
        },
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("promotes nested request metadata into evlog summary fields", () => {
    const { logger, requestLogger } = createStandaloneRequestLogger({
      method: "UNKNOWN",
      path: "/",
      requestId: "req_test",
    })

    logger.set({
      request: {
        method: "GET",
        path: "unknown",
        route: "/trpc/analytics.getRealtimeTicket",
        status: 200,
      },
    })

    const event = emitWideEvent(requestLogger)

    expect(event).toMatchObject({
      method: "GET",
      path: "/trpc/analytics.getRealtimeTicket",
      route: "/trpc/analytics.getRealtimeTicket",
      requestId: "req_test",
      status: 200,
      request: {
        id: "req_test",
        method: "GET",
        path: "unknown",
        route: "/trpc/analytics.getRealtimeTicket",
        status: 200,
      },
    })
  })

  it("keeps the transport method while replacing the summary path with the logical route", () => {
    const { logger, requestLogger } = createStandaloneRequestLogger({
      method: "POST",
      path: "/api/trpc/lambda",
      requestId: "req_transport",
    })

    logger.set({
      request: {
        method: "POST",
        path: "/api/trpc/lambda",
        route: "/trpc/analytics.getRealtimeTicket",
      },
    })

    const event = emitWideEvent(requestLogger)

    expect(event).toMatchObject({
      method: "POST",
      path: "/trpc/analytics.getRealtimeTicket",
      route: "/trpc/analytics.getRealtimeTicket",
      requestId: "req_transport",
    })
  })
})
