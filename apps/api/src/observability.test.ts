import { describe, expect, it, vi } from "vitest"

const metricsLogger = {
  set: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  flush: vi.fn(async () => {}),
}

async function loadObservability() {
  vi.resetModules()
  vi.clearAllMocks()

  vi.doMock("cloudflare:workers", () => ({
    env: {
      APP_ENV: "preview",
      AXIOM_API_TOKEN: "token",
      AXIOM_DATASET: "dataset",
      VERSION: "test",
    },
  }))

  vi.doMock("@unprice/observability", () => ({
    createLogger: vi.fn(),
    createMetricsLogger: vi.fn(() => metricsLogger),
    createUnpriceDrain: vi.fn(() => ({
      flush: vi.fn(async () => {}),
      pending: 0,
    })),
    initObservability: vi.fn(),
    runDoOperation: vi.fn(),
    sharedSamplingConfig: vi.fn(() => ({})),
  }))

  vi.doMock("evlog/hono", () => ({
    evlog: vi.fn(() => vi.fn()),
  }))

  return import("~/observability")
}

describe("createDoLogger", () => {
  it("emits DO info logs as first-class log events with durable object context", async () => {
    const { createDoLogger } = await loadObservability()
    const logger = createDoLogger("do_123")

    logger.set({
      business: { operation: "apply_batch" },
      operation: "apply_batch",
      request: { path: "/durable-objects/entitlementwindow/apply_batch" },
      service: "entitlementwindow",
    })
    logger.info("entitlement apply_batch", {
      customer_id: "cus_123",
      mode: "optimized",
      project_id: "proj_123",
    })

    expect(metricsLogger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        customer_id: "cus_123",
        mode: "optimized",
        operation: "apply_batch",
        project_id: "proj_123",
        requestId: "do_123",
        service: "entitlementwindow",
        type: "log",
      })
    )
    expect(metricsLogger.info).toHaveBeenCalledWith(
      "entitlement apply_batch",
      expect.objectContaining({
        business: { operation: "apply_batch" },
        cloud: {
          durable_object_id: "do_123",
          platform: "cloudflare",
        },
        request: {
          id: "do_123",
          path: "/durable-objects/entitlementwindow/apply_batch",
        },
      })
    )
  })

  it("preserves debug logs as first-class debug events", async () => {
    const { createDoLogger } = await loadObservability()
    const logger = createDoLogger("do_123")

    logger.debug("entitlement debug", { operation: "apply" })

    expect(metricsLogger.info).toHaveBeenCalledWith(
      "entitlement debug",
      expect.objectContaining({
        level: "debug",
        operation: "apply",
        type: "log",
      })
    )
  })

  it("normalizes error objects into queryable error fields", async () => {
    const { createDoLogger } = await loadObservability()
    const logger = createDoLogger("do_123")
    const error = new Error("wallet refill failed")

    logger.error(error, {
      operation: "flush_refill",
      project_id: "proj_123",
    })

    expect(metricsLogger.error).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        error: expect.objectContaining({
          message: "wallet refill failed",
          name: "Error",
          stack: expect.any(String),
        }),
        operation: "flush_refill",
        project_id: "proj_123",
        type: "log",
      })
    )
  })
})
