import { describe, expect, it } from "vitest"
import { resolveSampleRate } from "./sampling"

describe("resolveSampleRate", () => {
  it("defaults to 0.1 when unset", () => {
    expect(resolveSampleRate(undefined)).toBe(0.1)
    expect(resolveSampleRate(null)).toBe(0.1)
  })

  it("accepts finite rates from zero through one", () => {
    expect(resolveSampleRate(0)).toBe(0)
    expect(resolveSampleRate(0.25)).toBe(0.25)
    expect(resolveSampleRate(0.5)).toBe(0.5)
    expect(resolveSampleRate(1)).toBe(1)
  })

  it("falls back to the default (or provided fallback) for out-of-range values", () => {
    expect(resolveSampleRate(-0.001)).toBe(0.1)
    expect(resolveSampleRate(1.001)).toBe(0.1)
    expect(resolveSampleRate(Number.NaN)).toBe(0.1)
    expect(resolveSampleRate(Number.POSITIVE_INFINITY)).toBe(0.1)
    expect(resolveSampleRate(-1, 0.3)).toBe(0.3)
  })

  it("coerces string bindings (Cloudflare env arrives as strings at runtime)", () => {
    expect(resolveSampleRate("0.5")).toBe(0.5)
    expect(resolveSampleRate("1")).toBe(1)
    expect(resolveSampleRate("nonsense")).toBe(0.1)
    expect(resolveSampleRate("Infinity")).toBe(0.1)
  })
})
