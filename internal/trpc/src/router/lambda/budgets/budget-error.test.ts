import type { BudgetReleaseRejectionCode } from "@unprice/db/validators"
import { FetchError } from "@unprice/error"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import { describe, expect, it } from "vitest"
import { budgetTrpcError, releaseRejectedTrpcError } from "./budget-error"

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

describe("releaseRejectedTrpcError", () => {
  const rejected = (rejectionCode: BudgetReleaseRejectionCode) =>
    releaseRejectedTrpcError({
      id: "bga_1",
      budgetId: "bgt_1",
      action: "release_hold",
      subject: "h_7",
      actorUserId: "usr_1",
      reason: "worker crashed before the call",
      status: "rejected",
      rejectionCode,
      createdAt: 1,
      updatedAt: 1,
    })

  it("maps a closed or retired hold to CONFLICT and a missing one to NOT_FOUND", () => {
    const answers = (["HOLD_CLOSED", "HOLD_RETIRED", "HOLD_NOT_FOUND"] as const).map((code) => {
      const error = rejected(code)
      return [error.code, error.message]
    })

    expect(answers).toEqual([
      [
        "CONFLICT",
        "h_7 already closed. Its caller settled it, or it expired and was charged in full. Nothing was released.",
      ],
      [
        "CONFLICT",
        "h_7 closed more than 24 hours ago and its record is gone. Nothing was released.",
      ],
      ["NOT_FOUND", "h_7 does not exist on this budget."],
    ])
  })
})
