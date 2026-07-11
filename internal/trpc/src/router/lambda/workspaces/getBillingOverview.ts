import { analyticsIntervalSchema } from "@unprice/analytics"
import {
  getWorkspaceBillingOverview,
  getWorkspaceBillingOverviewOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedWorkspaceProcedure } from "#trpc"

const getBillingOverviewInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  range: analyticsIntervalSchema,
})

export const getBillingOverview = protectedWorkspaceProcedure
  .input(getBillingOverviewInputSchema)
  .output(getWorkspaceBillingOverviewOutputSchema)
  .query(async (opts) => {
    const result = await getWorkspaceBillingOverview(
      {
        services: {
          customers: opts.ctx.services.customers,
          wallet: opts.ctx.services.wallet,
        },
        db: opts.ctx.db,
        analytics: opts.ctx.analytics,
        logger: opts.ctx.logger,
      },
      {
        workspace: opts.ctx.workspace,
        range: opts.input.range,
      }
    )

    if (result.err) {
      throw domainErrorToTrpcError(result.err, "Failed to fetch workspace billing overview")
    }

    return result.val
  })
