import { describe, expect, it } from "vitest"
import { MESSAGE_OVERHEAD_TOKENS, REQUEST_OVERHEAD_TOKENS, inputBound } from "./input-bound"

describe("input bound", () => {
  it("is the UTF-8 byte length of the request body plus a fixed overhead per message", () => {
    expect(REQUEST_OVERHEAD_TOKENS).toBe(32)
    expect(MESSAGE_OVERHEAD_TOKENS).toBe(8)
    expect(inputBound('{"input":"Hello"}', 1)).toBe(17 + 8 + 32)
    expect(inputBound("", 0)).toBe(32)
    expect(inputBound("x", 3)).toBe(1 + 24 + 32)
  })

  it("counts bytes, not characters, so multibyte text is bounded", () => {
    expect(inputBound('{"input":"日本語"}', 1)).toBe(21 + 8 + 32)
    expect(inputBound('{"input":"😀"}', 1)).toBe(16 + 8 + 32)
    expect(inputBound('{"input":"héllo"}', 1)).toBe(18 + 8 + 32)
  })

  it("rejects a message count that is not a nonnegative integer", () => {
    expect(() => inputBound("{}", -1)).toThrow("message count")
    expect(() => inputBound("{}", 1.5)).toThrow("message count")
  })
})
