import { TRPCError } from "@trpc/server"
import { UnPriceBudgetError } from "@unprice/services/budgets"

/** A budget the object or the catalog does not have is NOT_FOUND; anything else failed on our side. */
export function budgetTrpcError(error: Error): TRPCError {
  if (error instanceof UnPriceBudgetError && error.code === "BUDGET_NOT_FOUND") {
    return new TRPCError({ code: "NOT_FOUND", message: "Budget not found" })
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message })
}
