import {
  type BudgetAuditRow,
  budgetHoldIdSchema,
  budgetOperatorReasonSchema,
  budgetReleaseRejectionCodeSchema,
} from "@unprice/db/validators"
import { Err, type FetchError, type Result } from "@unprice/error"
import { z } from "zod"
import type { BudgetAuditServiceError } from "../../budget-audit"
import type { BudgetCatalogServiceError } from "../../budget-catalog"
import { UnPriceBudgetError } from "../../budgets"
import type { ServiceContext } from "../../context"

export const releaseHoldAsOperatorInputSchema = z.object({
  projectId: z.string(),
  budgetId: z.string(),
  holdId: budgetHoldIdSchema,
  holdCreatedAt: z.number().int(),
  actorUserId: z.string(),
  reason: budgetOperatorReasonSchema,
})

export type ReleaseHoldAsOperatorInput = z.infer<typeof releaseHoldAsOperatorInputSchema>

export type ReleaseHoldAsOperatorDeps = {
  services: Pick<ServiceContext, "budgetCatalog" | "budgetAudit" | "budgetOperator">
}

/**
 * Releases one open hold for an operator and audits it: the row is `requested` before the budget
 * is called, then `applied` or `rejected`. A transport failure leaves it `requested`, and the next
 * attempt reuses it and calls the budget again, which is safe because a release replays. A row
 * already resolved is returned without calling the budget.
 */
export async function releaseHoldAsOperator(
  deps: ReleaseHoldAsOperatorDeps,
  input: ReleaseHoldAsOperatorInput
): Promise<
  Result<
    BudgetAuditRow,
    BudgetCatalogServiceError | BudgetAuditServiceError | FetchError | UnPriceBudgetError
  >
> {
  const { budgetCatalog, budgetAudit, budgetOperator } = deps.services
  const { projectId, budgetId, holdId, holdCreatedAt, actorUserId, reason } = input
  const found = await budgetCatalog.get(projectId, { id: budgetId })
  if (found.err) return found
  if (!found.val) return Err(new UnPriceBudgetError({ code: "BUDGET_NOT_FOUND" }))

  const requested = await budgetAudit.request(projectId, {
    budgetId,
    action: "release_hold",
    subject: holdId,
    subjectCreatedAt: holdCreatedAt,
    actorUserId,
    reason,
  })
  if (requested.err || requested.val.status !== "requested") return requested
  const { id } = requested.val

  const released = await budgetOperator.release({
    projectId,
    key: found.val.key,
    holdId,
    holdCreatedAt,
  })
  if (!released.err) {
    return budgetAudit.resolve(projectId, id, {
      status: "applied",
      released: released.val.released,
    })
  }
  const rejection =
    released.err instanceof UnPriceBudgetError
      ? budgetReleaseRejectionCodeSchema.safeParse(released.err.code)
      : null
  if (!rejection?.success) return released
  return budgetAudit.resolve(projectId, id, { status: "rejected", rejectionCode: rejection.data })
}
