import { describe, expect, it, vi } from "vitest"
import { resolveMetricsSampleRate } from "./init"

vi.mock("cloudflare:workers", () => ({ env: {} }))

describe("resolveMetricsSampleRate", () => {
  it("defaults to 0.1 when unset", () => {
    expect(resolveMetricsSampleRate(undefined)).toBe(0.1)
  })

  it("uses the configured rate when valid", () => {
    expect(resolveMetricsSampleRate(0.25)).toBe(0.25)
    expect(resolveMetricsSampleRate(1)).toBe(1)
    expect(resolveMetricsSampleRate(0)).toBe(0)
  })

  it("falls back to the default for invalid rates", () => {
    expect(resolveMetricsSampleRate(-1)).toBe(0.1)
    expect(resolveMetricsSampleRate(2)).toBe(0.1)
    expect(resolveMetricsSampleRate(Number.NaN)).toBe(0.1)
  })
})
