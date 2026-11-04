import { analyticsIntervalSchema } from "@unprice/analytics"
import { Err, FetchError, Ok } from "@unprice/error"
import {
  type CurrentEntitlementsReader,
  getCustomerCurrentEntitlementsOutputSchema,
  getWorkspaceBillingOverview,
  getWorkspaceBillingOverviewOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedWorkspaceProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

const getBillingOverviewInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  range: analyticsIntervalSchema,
})

/** Live metered usage from the payer budget, which only the API reaches. */
const currentEntitlements: CurrentEntitlementsReader = async ({ projectId, customerId }) => {
  const { result, error } = await unprice.access.entitlements.current({ projectId, customerId })
  if (error || !result) {
    return Err(
      new FetchError({
        message: error?.message ?? "access.entitlements.current answered nothing",
        retry: true,
        context: { url: "/v1/access/entitlements/current", method: "POST" },
      })
    )
  }
  return Ok(getCustomerCurrentEntitlementsOutputSchema.parse(result))
}

export const getBillingOverview = protectedWorkspaceProcedure
  .input(getBillingOverviewInputSchema)
  .output(getWorkspaceBillingOverviewOutputSchema)
  .query(async (opts) => {
    const result = await getWorkspaceBillingOverview(
      {
        services: {
          customers: opts.ctx.services.customers,
          wallet: opts.ctx.services.wallet,
          analytics: opts.ctx.services.analytics,
        },
        db: opts.ctx.db,
        currentEntitlements,
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
