import { formatAmount } from "@unprice/money"
import { describe, expect, it } from "vitest"
import { parseQuantity } from "./decimal"

function quantity(value: unknown): string {
  const parsed = parseQuantity(value)
  return parsed.ok ? formatAmount(parsed.quantity) : `invalid: ${parsed.reason}`
}

describe("parseQuantity", () => {
  it("parses numbers and numeric strings exactly to scale 8", () => {
    expect(quantity(1_000_000)).toBe("1000000")
    expect(quantity("12.5")).toBe("12.5")
    expect(quantity(0.1)).toBe("0.1")
    expect(quantity(0.00000001)).toBe("0.00000001")
    expect(quantity(1.5e-7)).toBe("0.00000015")
    expect(quantity(2e10)).toBe("20000000000")
    expect(quantity("0.123456780")).toBe("0.12345678")
    expect(quantity("007")).toBe("7")
  })

  it("counts a missing property as zero", () => {
    expect(quantity(undefined)).toBe("0")
    expect(quantity(null)).toBe("0")
  })

  it("rejects negative, non-finite, non-numeric, and over-precise values", () => {
    expect(quantity(-1)).toBe("invalid: negative")
    expect(quantity("-0.5")).toBe("invalid: negative")
    expect(quantity(Number.NaN)).toBe("invalid: not a finite number")
    expect(quantity(Number.POSITIVE_INFINITY)).toBe("invalid: not a finite number")
    expect(quantity("abc")).toBe("invalid: not a decimal number")
    expect(quantity("1e3")).toBe("invalid: not a decimal number")
    expect(quantity(" 1")).toBe("invalid: not a decimal number")
    expect(quantity(true)).toBe("invalid: not a number or numeric string")
    expect(quantity("0.123456789")).toBe("invalid: more than 8 decimal places")
    expect(quantity(1e-9)).toBe("invalid: more than 8 decimal places")
    expect(quantity(1e11)).toBe("invalid: too large")
    expect(quantity(1e21)).toBe("invalid: too large")
  })
})
