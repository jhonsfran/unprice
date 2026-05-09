import { describe, expect, it } from "vitest"
import { serializeError } from "./log"

describe("serializeError", () => {
  it("keeps Error details in JSON-safe fields", () => {
    const error = new TypeError("Missing PIPELINE_EVENTS binding")

    expect(serializeError(error)).toMatchObject({
      type: "TypeError",
      message: "Missing PIPELINE_EVENTS binding",
    })
    expect(JSON.stringify(serializeError(error))).toContain("Missing PIPELINE_EVENTS binding")
  })

  it("normalizes non-Error throws", () => {
    expect(serializeError("bad env")).toEqual({
      type: "Error",
      message: "bad env",
    })
  })
})
