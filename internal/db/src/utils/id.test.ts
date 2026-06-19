import { describe, expect, it } from "vitest"
import { newId, randomId } from "./id"

describe("randomId", () => {
  it("generates distinct edge-safe owner tokens", () => {
    const tokens = Array.from({ length: 64 }, () => randomId())

    expect(new Set(tokens).size).toBe(tokens.length)
    for (const token of tokens) {
      expect(token).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
      expect(token.length).toBeGreaterThanOrEqual(22)
    }
  })

  it("generates unique tokens even within the same millisecond", () => {
    // Generate a burst of tokens as fast as possible to stress the internal
    // counter. Date.now() may return the same value for multiple calls.
    const burstSize = 256
    const tokens = Array.from({ length: burstSize }, () => randomId())
    const unique = new Set(tokens)

    expect(unique.size).toBe(burstSize)
  })
})

describe("newId budget_run prefix", () => {
  it("generates sortable ids for budget runs", () => {
    expect(newId("budget_run")).toMatch(/^brun_[1-9A-HJ-NP-Za-km-z]{22}$/)
  })
})
