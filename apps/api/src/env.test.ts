import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeEnv, resolveRealtimeTicketSecret, warnIfAxiomUnconfigured } from "./env"

const authSecret = "a".repeat(32)
const realtimeSecret = "b".repeat(32)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("resolveRealtimeTicketSecret", () => {
  it("falls back to AUTH_SECRET in development", () => {
    expect(
      resolveRealtimeTicketSecret({
        APP_ENV: "development",
        AUTH_SECRET: authSecret,
      })
    ).toBe(authSecret)
  })

  it("uses REALTIME_TICKET_SECRET in development when provided", () => {
    expect(
      resolveRealtimeTicketSecret({
        APP_ENV: "development",
        AUTH_SECRET: authSecret,
        REALTIME_TICKET_SECRET: realtimeSecret,
      })
    ).toBe(realtimeSecret)
  })

  it("requires REALTIME_TICKET_SECRET outside development", () => {
    expect(() =>
      resolveRealtimeTicketSecret({
        APP_ENV: "production",
        AUTH_SECRET: authSecret,
      })
    ).toThrow("REALTIME_TICKET_SECRET binding is required outside development")
  })

  it("rejects realtime ticket secrets that reuse AUTH_SECRET outside development", () => {
    expect(() =>
      resolveRealtimeTicketSecret({
        APP_ENV: "preview",
        AUTH_SECRET: authSecret,
        REALTIME_TICKET_SECRET: authSecret,
      })
    ).toThrow("REALTIME_TICKET_SECRET must be distinct from AUTH_SECRET")
  })
})

describe("warnIfAxiomUnconfigured", () => {
  it("names the token when it is missing", () => {
    const warn = vi.fn()
    warnIfAxiomUnconfigured(
      { APP_ENV: "production", AXIOM_API_TOKEN: undefined, AXIOM_DATASET: "api" },
      warn
    )
    expect(warn).toHaveBeenCalledWith(
      "Axiom log drain is not configured for APP_ENV=production; missing bindings: AXIOM_API_TOKEN; wide events and DO diagnostics will not be exported"
    )
  })

  it("names the dataset when it is missing", () => {
    const warn = vi.fn()
    warnIfAxiomUnconfigured(
      { APP_ENV: "preview", AXIOM_API_TOKEN: "tok", AXIOM_DATASET: undefined },
      warn
    )
    expect(warn).toHaveBeenCalledWith(
      "Axiom log drain is not configured for APP_ENV=preview; missing bindings: AXIOM_DATASET; wide events and DO diagnostics will not be exported"
    )
  })

  it("names both bindings when both are missing", () => {
    const warn = vi.fn()
    warnIfAxiomUnconfigured(
      { APP_ENV: "production", AXIOM_API_TOKEN: undefined, AXIOM_DATASET: undefined },
      warn
    )
    expect(warn).toHaveBeenCalledWith(
      "Axiom log drain is not configured for APP_ENV=production; missing bindings: AXIOM_API_TOKEN, AXIOM_DATASET; wide events and DO diagnostics will not be exported"
    )
  })

  it("stays silent in development", () => {
    const warn = vi.fn()
    warnIfAxiomUnconfigured(
      { APP_ENV: "development", AXIOM_API_TOKEN: undefined, AXIOM_DATASET: undefined },
      warn
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("stays silent when fully configured", () => {
    const warn = vi.fn()
    warnIfAxiomUnconfigured(
      { APP_ENV: "production", AXIOM_API_TOKEN: "tok", AXIOM_DATASET: "api" },
      warn
    )
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("createRuntimeEnv", () => {
  it("warns only once per isolate when Axiom is unconfigured", () => {
    vi.stubEnv("SKIP_ENV_VALIDATION", "true")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const workerEnv = {
      APP_ENV: "production",
      AUTH_SECRET: authSecret,
      REALTIME_TICKET_SECRET: realtimeSecret,
      PIPELINE_EVENTS: { send: vi.fn() },
      AXIOM_DATASET: "api",
    }

    createRuntimeEnv(workerEnv)
    createRuntimeEnv(workerEnv)

    expect(error).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      "Axiom log drain is not configured for APP_ENV=production; missing bindings: AXIOM_API_TOKEN; wide events and DO diagnostics will not be exported"
    )
  })
})
