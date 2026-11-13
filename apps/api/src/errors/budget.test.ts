import { UnPriceBudgetError } from "@unprice/services/budgets"
import { expect, it } from "vitest"
import { toUnpriceApiError } from "./http"

it("maps a funding failure before the generic domain mapping", () => {
  const failure = new UnPriceBudgetError({
    code: "FUNDING_FAILED",
    statementKey: "stmt_1",
    seq: 1,
    intent: "reserve",
    walletCode: "WALLET_LEDGER_FAILED",
  })
  const error = toUnpriceApiError(failure)
  expect(error.status).toBe(500)
  expect(error.message).toBe("The customer's wallet could not fund this usage")
  expect(error.cause).toBe(failure)
})
