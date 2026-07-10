import {
  getWorkspaceUpgradeOptions,
  getWorkspaceUpgradeOptionsOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
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
      throw domainErrorToTrpcError(result.err, "Failed to fetch workspace upgrade options")
    }

    return result.val
  })
