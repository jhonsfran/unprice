import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createLogger,
  createStandaloneRequestLogger,
  createUnpriceDrain,
  initObservability,
  sharedSamplingConfig,
} from "./index"

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
        rates: { debug: 100, info: 100, warn: 100, error: 100 },
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not create a drain when token and dataset are missing", () => {
    const drain = createUnpriceDrain({ environment: "production" })
    expect(drain).toBeUndefined()
  })

  it("creates a drain when token and dataset are present outside development", () => {
    const drain = createUnpriceDrain({
      environment: "production",
      token: "xaat_test",
      dataset: "unprice-tests",
    })

    expect(drain).toBeTypeOf("function")
    expect(typeof drain?.flush).toBe("function")
  })

  it("does not create a drain in development", () => {
    const drain = createUnpriceDrain({
      environment: "development",
      token: "xaat_test",
      dataset: "unprice-tests",
    })

    expect(drain).toBeUndefined()
  })

  it("createStandaloneRequestLogger produces a working logger", () => {
    const { logger, requestLogger } = createStandaloneRequestLogger({
      method: "GET",
      path: "/health",
      requestId: "req_test",
    })

    expect(logger).toHaveProperty("set")
    expect(logger).toHaveProperty("info")
    expect(logger).toHaveProperty("warn")
    expect(logger).toHaveProperty("error")
    expect(logger).toHaveProperty("debug")
    expect(logger).toHaveProperty("flush")
    expect(requestLogger).toHaveProperty("set")
    expect(requestLogger).toHaveProperty("emit")
  })

  it("logger.flush resolves when no drain is provided", async () => {
    const { logger } = createStandaloneRequestLogger({
      method: "GET",
      path: "/health",
      requestId: "req_flush_noop",
    })

    await expect(logger.flush()).resolves.toBeUndefined()
  })

  it("sharedSamplingConfig returns correct config for development", () => {
    const config = sharedSamplingConfig("development")
    expect(config.rates?.info).toBe(100)
    expect(config.rates?.debug).toBe(100)
  })

  it("sharedSamplingConfig returns correct config for production", () => {
    const config = sharedSamplingConfig("production")
    expect(config.rates?.info).toBe(10)
    expect(config.rates?.debug).toBe(0)
    expect(config.rates?.error).toBe(100)
  })

  it("createLogger wraps a request logger into the Logger interface", () => {
    const { requestLogger } = createStandaloneRequestLogger({
      requestId: "req_wrap",
    })

    const logger = createLogger(requestLogger)

    expect(logger.set).toBeTypeOf("function")
    expect(logger.info).toBeTypeOf("function")
    expect(logger.warn).toBeTypeOf("function")
    expect(logger.error).toBeTypeOf("function")
    expect(logger.debug).toBeTypeOf("function")
    expect(logger.flush).toBeTypeOf("function")

    // Should not throw
    logger.set({ business: { operation: "test" } })
    logger.info("test message", { key: "value" })
    logger.warn("warning")
    logger.error(new Error("test error"))
    logger.error("string error")
    logger.error({ message: "object error" })
  })
})
