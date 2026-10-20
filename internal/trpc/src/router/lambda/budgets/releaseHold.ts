import { budgetAuditRowSchema, releaseBudgetHoldInputSchema } from "@unprice/db/validators"
import { releaseHoldAsOperator } from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"
import { budgetTrpcError, releaseRejectedTrpcError } from "./budget-error"

/** Releases one open hold for an OWNER or ADMIN who attested the work used nothing. */
export const releaseHold = protectedProjectProcedure
  .input(releaseBudgetHoldInputSchema)
  .output(budgetAuditRowSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { id, holdId, reason } = opts.input
    const { budgetCatalog, budgetAudit, budgetOperator } = opts.ctx.services
    const result = await releaseHoldAsOperator(
      { services: { budgetCatalog, budgetAudit, budgetOperator } },
      { projectId: opts.ctx.project.id, budgetId: id, holdId, actorUserId: opts.ctx.userId, reason }
    )

    if (result.err) throw budgetTrpcError(result.err)
    if (result.val.status === "rejected") throw releaseRejectedTrpcError(result.val)
    return result.val
  })
