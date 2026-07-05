import { TRPCError } from "@trpc/server"
import {
  GetWorkspaceUpgradeOptionsError,
  getWorkspaceUpgradeOptions,
  getWorkspaceUpgradeOptionsOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

const getUpgradeOptionsInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  targetPlanVersionId: z.string().min(1).optional(),
})

export const getUpgradeOptions = protectedWorkspaceProcedure
  .input(getUpgradeOptionsInputSchema)
  .output(getWorkspaceUpgradeOptionsOutputSchema)
  .query(async (opts) => {
    const result = await getWorkspaceUpgradeOptions(
      {
        services: {
          customers: opts.ctx.services.customers,
          plans: opts.ctx.services.plans,
          subscriptions: opts.ctx.services.subscriptions,
        },
        db: opts.ctx.db,
        analytics: opts.ctx.analytics,
        logger: opts.ctx.logger,
      },
      {
        workspace: opts.ctx.workspace,
        targetPlanVersionId: opts.input.targetPlanVersionId,
      }
    )

    if (result.err) {
      throw getUpgradeOptionsErrorToTrpcError(result.err)
    }

    return result.val
  })

function getUpgradeOptionsErrorToTrpcError(error: unknown): TRPCError {
  if (error instanceof GetWorkspaceUpgradeOptionsError) {
    switch (error.code) {
      case "WORKSPACE_BILLING_CUSTOMER_ID_MISSING":
        return new TRPCError({ code: "BAD_REQUEST", message: error.message })
      case "WORKSPACE_BILLING_CUSTOMER_NOT_FOUND":
      case "WORKSPACE_BILLING_ACCESS_NOT_FOUND":
        return new TRPCError({ code: "NOT_FOUND", message: error.message })
      case "WORKSPACE_BILLING_CURRENCY_NOT_FOUND":
        return new TRPCError({ code: "PRECONDITION_FAILED", message: error.message })
    }
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Failed to fetch workspace upgrade options",
  })
}
