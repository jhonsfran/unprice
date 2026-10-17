import { describe, expect, it } from "vitest"
import { AMOUNT_PATTERN, formatAmount, parseAmount } from "./amount"

describe("parseAmount", () => {
  it.each([
    ["44.95", { ok: true, amount: BigInt(4_495_000_000) }],
    ["0.00000001", { ok: true, amount: BigInt(1) }],
    ["92233720368.54775807", { ok: true, amount: BigInt("9223372036854775807") }],
    ["92233720368.54775808", { ok: false, reason: "too_large" }],
    ["1.123456789", { ok: false, reason: "not_decimal" }],
    ["1e5", { ok: false, reason: "not_decimal" }],
    [".5", { ok: false, reason: "not_decimal" }],
    ["-1", { ok: false, reason: "not_decimal" }],
  ] as const)("parses %s", (input, expected) => {
    expect(parseAmount(input)).toEqual(expected)
  })

  it("accepts exactly the wire pattern", () => {
    expect(AMOUNT_PATTERN.source).toBe("^\\d{1,19}(\\.\\d{1,8})?$")
  })

  it("formats canonical decimals", () => {
    expect([BigInt(4_495_000_000), BigInt(-1), BigInt(0)].map(formatAmount)).toEqual([
      "44.95",
      "-0.00000001",
      "0",
    ])
  })
})
