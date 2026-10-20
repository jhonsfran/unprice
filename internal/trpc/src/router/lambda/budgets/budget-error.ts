import { TRPCError } from "@trpc/server"
import type { BudgetAuditRow, BudgetReleaseRejectionCode } from "@unprice/db/validators"
import { UnPriceBudgetError } from "@unprice/services/budgets"

/** A budget the object or the catalog does not have is NOT_FOUND; anything else failed on our side. */
export function budgetTrpcError(error: Error): TRPCError {
  if (error instanceof UnPriceBudgetError && error.code === "BUDGET_NOT_FOUND") {
    return new TRPCError({ code: "NOT_FOUND", message: "Budget not found" })
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message })
}

const RELEASE_REJECTED: Record<
  BudgetReleaseRejectionCode,
  { code: "CONFLICT" | "NOT_FOUND"; message: (holdId: string) => string }
> = {
  HOLD_CLOSED: {
    code: "CONFLICT",
    message: (holdId) =>
      `${holdId} already closed. Its caller settled it, or it expired and was charged in full. Nothing was released.`,
  },
  HOLD_RETIRED: {
    code: "CONFLICT",
    message: (holdId) =>
      `${holdId} closed more than 24 hours ago and its record is gone. Nothing was released.`,
  },
  HOLD_NOT_FOUND: {
    code: "NOT_FOUND",
    message: (holdId) => `${holdId} does not exist on this budget.`,
  },
  BUDGET_NOT_FOUND: { code: "NOT_FOUND", message: () => "Budget not found" },
}

/** The error a rejected release answers, from what its audit row recorded. */
export function releaseRejectedTrpcError(
  row: Extract<BudgetAuditRow, { status: "rejected" }>
): TRPCError {
  const { code, message } = RELEASE_REJECTED[row.rejectionCode]
  return new TRPCError({ code, message: message(row.subject) })
}
