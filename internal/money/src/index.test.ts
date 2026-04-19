import { type Dinero, dinero, equal } from "dinero.js"
import { EUR, USD } from "dinero.js/currencies"
import { describe, expect, it } from "vitest"
import {
  calculatePercentage,
  currencySymbol,
  diffLedgerMinor,
  formatAmountForProvider,
  formatMoney,
  fromLedgerAmount,
  fromLedgerMinor,
  toLedgerAmount,
  toLedgerMinor,
} from "./index"

// All assertions encode LEDGER_SCALE=8. Bumping the scale is a deliberate
// data-model change: if a test here breaks after editing LEDGER_SCALE, that's
// the fixtures telling you every ledger row, outbox payload, and Tinybird
// column interprets amounts at the new scale.
describe("money", () => {
  describe("toLedgerAmount", () => {
    it("normalizes scale-2 USD to scale-8 decimal string", () => {
      const amount = dinero({ amount: 1234, currency: USD })
      expect(toLedgerAmount(amount)).toBe("12.34000000")
    })

    it("preserves sub-cent precision when input is already scale-8", () => {
      const amount = dinero({ amount: 3, currency: USD, scale: 8 })
      expect(toLedgerAmount(amount)).toBe("0.00000003")
    })

    it("formats zero as 0.00000000", () => {
      const amount = dinero({ amount: 0, currency: USD })
      expect(toLedgerAmount(amount)).toBe("0.00000000")
    })

    it("preserves $9.99999999 sub-cent precision exactly", () => {
      const amount = dinero({ amount: 999_999_999, currency: USD, scale: 8 })
      expect(toLedgerAmount(amount)).toBe("9.99999999")
    })
  })

  describe("fromLedgerAmount", () => {
    it("rebuilds Dinero from scale-8 decimal string", () => {
      const reconstructed = fromLedgerAmount("12.34000000", "USD")
      const expected = dinero({ amount: 1_234_000_000, currency: USD, scale: 8 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("handles negative values", () => {
      const reconstructed = fromLedgerAmount("-5.12345678", "EUR")
      const expected = dinero({ amount: -512_345_678, currency: EUR, scale: 8 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("treats fewer-than-8 fractional digits as zero-padded", () => {
      const reconstructed = fromLedgerAmount("3.14", "USD")
      const expected = dinero({ amount: 314_000_000, currency: USD, scale: 8 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("truncates more-than-8 fractional digits", () => {
      const reconstructed = fromLedgerAmount("3.1415926535", "USD")
      const expected = dinero({ amount: 314_159_265, currency: USD, scale: 8 })
      expect(equal(reconstructed, expected)).toBe(true)
    })

    it("throws on unknown currency", () => {
      expect(() => fromLedgerAmount("1.00", "XYZ")).toThrow(/Unsupported currency/)
    })
  })

  describe("round-trip (decimal string)", () => {
    const cases: Array<{ name: string; value: Dinero<number> }> = [
      { name: "zero USD", value: dinero({ amount: 0, currency: USD }) },
      { name: "1 minor unit USD", value: dinero({ amount: 1, currency: USD }) },
      {
        name: "sub-cent USD ($0.00000003)",
        value: dinero({ amount: 3, currency: USD, scale: 8 }),
      },
      {
        name: "$9.99999999",
        value: dinero({ amount: 999_999_999, currency: USD, scale: 8 }),
      },
      { name: "EUR scale-2", value: dinero({ amount: 4250, currency: EUR }) },
      {
        name: "large value",
        value: dinero({ amount: 1_234_567_890, currency: USD, scale: 8 }),
      },
    ]

    for (const { name, value } of cases) {
      it(`preserves ${name}`, () => {
        const decimal = toLedgerAmount(value)
        const currency = value.toJSON().currency.code === "USD" ? "USD" : "EUR"
        const reconstructed = fromLedgerAmount(decimal, currency)
        expect(equal(reconstructed, value)).toBe(true)
      })
    }
  })

  describe("toLedgerMinor", () => {
    it("rounds up sub-ledger-scale values", () => {
      const amount = dinero({ amount: 32, currency: USD, scale: 9 }) // $0.000000032
      expect(toLedgerMinor(amount)).toBe(4) // rounds up to 4 at scale 8
    })

    it("returns 3 for exact $0.00000003", () => {
      const amount = dinero({ amount: 3, currency: USD, scale: 8 })
      expect(toLedgerMinor(amount)).toBe(3)
    })

    it("upscales scale-2 cents to scale-8 minor", () => {
      const amount = dinero({ amount: 100, currency: USD }) // $1.00
      expect(toLedgerMinor(amount)).toBe(100_000_000)
    })

    it("returns 0 for zero", () => {
      expect(toLedgerMinor(dinero({ amount: 0, currency: USD }))).toBe(0)
    })
  })

  describe("fromLedgerMinor", () => {
    it("round-trips through toLedgerMinor", () => {
      const original = dinero({ amount: 3, currency: USD, scale: 8 })
      const minor = toLedgerMinor(original)
      const reconstructed = fromLedgerMinor(minor, "USD")
      expect(equal(reconstructed, original)).toBe(true)
    })
  })

  describe("diffLedgerMinor", () => {
    it("returns precise sub-cent delta", () => {
      const before = dinero({ amount: 3, currency: USD, scale: 8 }) // $0.00000003
      const after = dinero({ amount: 6, currency: USD, scale: 8 }) // $0.00000006
      expect(diffLedgerMinor(after, before)).toBe(3)
    })

    it("does NOT clamp negative results (refund/correction)", () => {
      const before = dinero({ amount: 100_000_000, currency: USD, scale: 8 }) // $1.00
      const after = dinero({ amount: 50_000_000, currency: USD, scale: 8 }) // $0.50
      expect(diffLedgerMinor(after, before)).toBe(-50_000_000)
    })

    it("sum of per-event deltas on sub-cent pricing is precise", () => {
      // 1000 events priced at $0.00000003 each = $0.00003 total.
      // At scale 8 that's exactly 3000 minor units, with zero rounding loss
      // — where scale-2 quantization would drop every event to 0 cents.
      let total = 0
      let cumulative = 0
      for (let i = 0; i < 1000; i++) {
        const before = dinero({ amount: cumulative * 3, currency: USD, scale: 8 })
        cumulative += 1
        const after = dinero({ amount: cumulative * 3, currency: USD, scale: 8 })
        total += diffLedgerMinor(after, before)
      }
      expect(total).toBe(3000)
    })
  })

  describe("formatAmountForProvider", () => {
    it("rounds up to currency minor units", () => {
      const amount = dinero({ amount: 3, currency: USD, scale: 8 }) // $0.00000003
      expect(formatAmountForProvider(amount)).toEqual({ amount: 1, currency: "usd" })
    })

    it("preserves exact cent amounts", () => {
      const amount = dinero({ amount: 1234, currency: USD }) // $12.34
      expect(formatAmountForProvider(amount)).toEqual({ amount: 1234, currency: "usd" })
    })
  })

  describe("calculatePercentage", () => {
    it("multiplies by a fractional percentage", () => {
      const price = dinero({ amount: 1000, currency: USD }) // $10.00
      const result = calculatePercentage(price, 0.25)
      expect(formatAmountForProvider(result).amount).toBe(250)
    })

    it("rejects out-of-range percentages", () => {
      const price = dinero({ amount: 100, currency: USD })
      expect(() => calculatePercentage(price, -0.01)).toThrow()
      expect(() => calculatePercentage(price, 1.01)).toThrow()
    })
  })

  describe("formatMoney", () => {
    it("renders USD with $ symbol", () => {
      expect(formatMoney("1234.5", "USD")).toMatch(/\$1,234/)
    })
  })

  describe("currencySymbol", () => {
    it("returns the symbol for known currencies", () => {
      expect(currencySymbol("USD")).toBe("$")
      expect(currencySymbol("EUR")).toBe("€")
      expect(currencySymbol("GBP")).toBe("£")
    })

    it("falls back to the code for unknown currencies", () => {
      expect(currencySymbol("JPY")).toBe("JPY")
    })
  })
})
