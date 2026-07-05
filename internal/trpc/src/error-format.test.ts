import { describe, expect, it } from "vitest"
import {
  INTERNAL_SERVER_ERROR_MESSAGE,
  getPublicTrpcErrorMessage,
  isInternalTrpcError,
} from "./error-format"

describe("tRPC error formatting", () => {
  it("uses a generic message for internal errors", () => {
    expect(
      getPublicTrpcErrorMessage({
        code: "INTERNAL_SERVER_ERROR",
        message: "database connection string rejected",
      })
    ).toBe(INTERNAL_SERVER_ERROR_MESSAGE)
  })

  it("keeps expected client error messages specific", () => {
    expect(
      getPublicTrpcErrorMessage({
        code: "BAD_REQUEST",
        message: "Invalid input",
      })
    ).toBe("Invalid input")
  })

  it("classifies unknown tRPC codes as internal", () => {
    expect(isInternalTrpcError("SOME_UNKNOWN_CODE")).toBe(true)
  })
})
