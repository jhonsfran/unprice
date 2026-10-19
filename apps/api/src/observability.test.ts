import type { TailSamplingContext } from "evlog"
import { afterEach, describe, expect, it, vi } from "vitest"

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

afterEach(() => {
  vi.restoreAllMocks()
})

describe("shouldAlwaysKeepDoLogEvent", () => {
  it("keeps error outcomes", async () => {
    const { shouldAlwaysKeepDoLogEvent } = await loadObservability()

    expect(shouldAlwaysKeepDoLogEvent({ outcome: "error" })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ error_message: "boom" })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ error: new Error("x") })).toBe(true)
  })

  it("keeps denials and recovery states", async () => {
    const { shouldAlwaysKeepDoLogEvent } = await loadObservability()

    expect(shouldAlwaysKeepDoLogEvent({ allowed: false })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ denied_reason: "WALLET_EMPTY" })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ denied_count: 3 })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ recovery_required: true })).toBe(true)
    expect(shouldAlwaysKeepDoLogEvent({ cold_start: true })).toBe(true)
  })

  it("keeps a budget alarm that filled its batch", async () => {
    const { shouldAlwaysKeepDoLogEvent } = await loadObservability()

    expect(shouldAlwaysKeepDoLogEvent({ budget: { expired: 256, purged: 0, capped: true } })).toBe(
      true
    )
    expect(shouldAlwaysKeepDoLogEvent({ budget: { expired: 3, purged: 1, capped: false } })).toBe(
      false
    )
  })

  it("samples happy-path events", async () => {
    const { shouldAlwaysKeepDoLogEvent } = await loadObservability()

    expect(shouldAlwaysKeepDoLogEvent({ outcome: "success", allowed: true })).toBe(false)
    expect(shouldAlwaysKeepDoLogEvent({})).toBe(false)
    expect(shouldAlwaysKeepDoLogEvent(undefined)).toBe(false)
  })
})

describe("createDoLogger", () => {
  it("emits DO info logs as first-class log events with durable object context", async () => {
    const { createDoLogger } = await loadObservability()
    vi.spyOn(Math, "random").mockReturnValue(0)
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
        sample_rate: 0.1,
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
    vi.spyOn(Math, "random").mockReturnValue(0)
    const logger = createDoLogger("do_123")

    logger.debug("entitlement debug", { operation: "apply" })

    expect(metricsLogger.info).toHaveBeenCalledWith(
      "entitlement debug",
      expect.objectContaining({
        level: "debug",
        operation: "apply",
        sample_rate: 0.1,
        type: "log",
      })
    )
  })

  it("suppresses happy-path debug and info logs above the sample rate", async () => {
    const { createDoLogger } = await loadObservability()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const logger = createDoLogger("do_123")

    logger.debug("entitlement debug", { outcome: "success" })
    logger.info("entitlement apply", { allowed: true })

    expect(metricsLogger.info).not.toHaveBeenCalled()
  })

  it("keeps debug and info logs when context contains an always-keep signal", async () => {
    const { createDoLogger } = await loadObservability()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const logger = createDoLogger("do_123")

    logger.set({ denied_reason: "WALLET_EMPTY" })
    logger.debug("entitlement debug")
    logger.info("entitlement apply")

    expect(metricsLogger.info).toHaveBeenCalledTimes(2)
    expect(metricsLogger.info).toHaveBeenNthCalledWith(
      1,
      "entitlement debug",
      expect.objectContaining({ denied_reason: "WALLET_EMPTY", level: "debug" })
    )
    expect(metricsLogger.info).toHaveBeenNthCalledWith(
      2,
      "entitlement apply",
      expect.objectContaining({ denied_reason: "WALLET_EMPTY" })
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

describe("keepFailedRequest", () => {
  function keeps(
    keep: (ctx: TailSamplingContext) => void,
    status: number | undefined,
    path: string
  ) {
    const ctx: TailSamplingContext = { status, path, context: {} }
    keep(ctx)
    return ctx.shouldKeep === true
  }

  it("keeps every failed request except a budget denial", async () => {
    const { keepFailedRequest: keep } = await loadObservability()

    expect(keeps(keep, 402, "/v1/budgets/authorize")).toBe(false)
    expect(keeps(keep, 402, "/v1/budgets/charge")).toBe(false)
    expect(keeps(keep, 409, "/v1/budgets/authorize")).toBe(true)
    expect(keeps(keep, 500, "/v1/budgets/settle")).toBe(true)
    expect(keeps(keep, 402, "/v1/usage/consume")).toBe(true)
    expect(keeps(keep, 400, "/v1/access/check")).toBe(true)
    expect(keeps(keep, 200, "/v1/budgets/authorize")).toBe(false)
    expect(keeps(keep, undefined, "/v1/budgets/authorize")).toBe(false)
  })
})

describe("keepSlowBudgetCall", () => {
  const budgetCall = (doMs: number | undefined, status = 200): TailSamplingContext => ({
    status,
    path: "/v1/budgets/record",
    context: { budget: { command: "record", outcome: "ok", do_ms: doMs } },
  })
  function keeps(keep: (ctx: TailSamplingContext) => void, ctx: TailSamplingContext) {
    keep(ctx)
    return ctx.shouldKeep === true
  }

  it("keeps a budget call whose Durable Object round trip took 300 ms or more", async () => {
    const { keepSlowBudgetCall: keep } = await loadObservability()

    expect(keeps(keep, budgetCall(300))).toBe(true)
    expect(keeps(keep, budgetCall(1_170))).toBe(true)
    expect(keeps(keep, budgetCall(450, 402))).toBe(true)
    expect(keeps(keep, budgetCall(299.9))).toBe(false)
    expect(keeps(keep, budgetCall(undefined))).toBe(false)
    expect(keeps(keep, { status: 200, path: "/v1/access/check", context: {} })).toBe(false)
  })

  it("joins the failed-request rule as the request middleware's tail sampler", async () => {
    await loadObservability()
    const { evlog } = await import("evlog/hono")
    const keep = vi.mocked(evlog).mock.calls[0]?.[0]?.keep
    if (!keep) throw new Error("the request middleware has no tail sampler")

    expect(keeps(keep, budgetCall(300))).toBe(true)
    expect(keeps(keep, budgetCall(20, 500))).toBe(true)
    expect(keeps(keep, budgetCall(20, 402))).toBe(false)
    expect(keeps(keep, budgetCall(20))).toBe(false)
  })
})
