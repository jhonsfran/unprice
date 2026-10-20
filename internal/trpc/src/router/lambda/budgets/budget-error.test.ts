import { FetchError } from "@unprice/error"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import { describe, expect, it } from "vitest"
import { budgetTrpcError } from "./budget-error"

describe("budgetTrpcError", () => {
  it("maps a missing budget to NOT_FOUND and a gateway failure to INTERNAL_SERVER_ERROR", () => {
    const missing = budgetTrpcError(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" }))
    const failed = budgetTrpcError(new FetchError({ message: "timeout", retry: true }))

    expect([missing.code, failed.code, failed.message]).toEqual([
      "NOT_FOUND",
      "INTERNAL_SERVER_ERROR",
      "timeout",
    ])
  })
})
