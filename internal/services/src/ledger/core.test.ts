import { EUR, USD } from "@dinero.js/currencies"
import { dinero } from "dinero.js"
import { describe, expect, it } from "vitest"
import { assertCurrencyMatch, assertPositiveAmount } from "./core"

describe("core validators", () => {
  describe("assertPositiveAmount", () => {
    it("accepts a positive amount", () => {
      const result = assertPositiveAmount(dinero({ amount: 100, currency: USD }))
      expect(result.err).toBeUndefined()
    })

    it("rejects zero", () => {
      const result = assertPositiveAmount(dinero({ amount: 0, currency: USD }))
      expect(result.err?.message).toBe("LEDGER_INVALID_AMOUNT")
    })

    it("rejects negative", () => {
      const result = assertPositiveAmount(dinero({ amount: -1, currency: USD }))
      expect(result.err?.message).toBe("LEDGER_INVALID_AMOUNT")
    })
  })

  describe("assertCurrencyMatch", () => {
    it("accepts matching currency", () => {
      const result = assertCurrencyMatch(dinero({ amount: 100, currency: USD }), "USD")
      expect(result.err).toBeUndefined()
    })

    it("rejects mismatched currency", () => {
      const result = assertCurrencyMatch(dinero({ amount: 100, currency: EUR }), "USD")
      expect(result.err?.message).toBe("LEDGER_CURRENCY_MISMATCH")
    })
  })
})
