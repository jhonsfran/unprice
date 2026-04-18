import { EUR, USD } from "@dinero.js/currencies"
import { type Dinero, dinero, equal } from "dinero.js"
import { describe, expect, it } from "vitest"
import { fromLedgerAmount, toLedgerAmount } from "./money"

describe("money", () => {
  describe("toLedgerAmount", () => {
    it("normalizes scale-2 USD to scale-6 decimal string", () => {
      const amount = dinero({ amount: 1234, currency: USD })
      expect(toLedgerAmount(amount)).toBe("12.340000")
    })

    it("preserves sub-cent precision when input is already scale-6", () => {
      const amount = dinero({ amount: 3, currency: USD, scale: 6 })
      expect(toLedgerAmount(amount)).toBe("0.000003")
    })

    it("formats zero as 0.000000", () => {
      const amount = dinero({ amount: 0, currency: USD })
      expect(toLedgerAmount(amount)).toBe("0.000000")
    })

    it("preserves $999.999999 sub-cent precision exactly", () => {
      const amount = dinero({ amount: 999_999_999, currency: USD, scale: 6 })
      expect(toLedgerAmount(amount)).toBe("999.999999")
    })
  })

  describe("fromLedgerAmount", () => {
    it("rebuilds Dinero from scale-6 decimal string", () => {
      const reconstructed = fromLedgerAmount("12.340000", "USD")
      const expected = dinero({ amount: 12_340_000, currency: USD, scale: 6 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("handles negative values", () => {
      const reconstructed = fromLedgerAmount("-5.123456", "EUR")
      const expected = dinero({ amount: -5_123_456, currency: EUR, scale: 6 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("treats fewer-than-6 fractional digits as zero-padded", () => {
      const reconstructed = fromLedgerAmount("3.14", "USD")
      const expected = dinero({ amount: 3_140_000, currency: USD, scale: 6 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("truncates more-than-6 fractional digits", () => {
      const reconstructed = fromLedgerAmount("3.14159265", "USD")
      const expected = dinero({ amount: 3_141_592, currency: USD, scale: 6 })
      expect(equal(reconstructed, expected)).toBe(true)
    })
  })

  describe("round-trip", () => {
    const cases: Array<{ name: string; value: Dinero<number> }> = [
      { name: "zero USD", value: dinero({ amount: 0, currency: USD }) },
      { name: "1 minor unit USD", value: dinero({ amount: 1, currency: USD }) },
      {
        name: "sub-cent USD ($0.000003)",
        value: dinero({ amount: 3, currency: USD, scale: 6 }),
      },
      {
        name: "$999.999999",
        value: dinero({ amount: 999_999_999, currency: USD, scale: 6 }),
      },
      {
        name: "EUR scale-2",
        value: dinero({ amount: 4250, currency: EUR }),
      },
      {
        name: "large value",
        value: dinero({ amount: 1_234_567_890, currency: USD, scale: 6 }),
      },
    ]

    for (const { name, value } of cases) {
      it(`preserves ${name}`, () => {
        const decimal = toLedgerAmount(value)
        const currency =
          value.toJSON().currency.code === "USD" ? ("USD" as const) : ("EUR" as const)
        const reconstructed = fromLedgerAmount(decimal, currency)
        expect(equal(reconstructed, value)).toBe(true)
      })
    }
  })
})
