import { subscriptionChangePlanSchema } from "@unprice/db/validators"
import {
  changeSubscriptionPhasePlan,
  subscriptionChangePhasePlanOutputSchema,
} from "@unprice/services/use-cases"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const changePhasePlan = protectedProjectProcedure
  .input(subscriptionChangePlanSchema)
  .output(subscriptionChangePhasePlanOutputSchema)
  .mutation(async (opts) => {
    // only owner and admin can schedule a phase change
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await changeSubscriptionPhasePlan(
      {
        services: {
          billing: opts.ctx.services.billing,
          plans: opts.ctx.services.plans,
          subscriptions: opts.ctx.services.subscriptions,
        },
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        ...opts.input,
        projectId: opts.ctx.project.id,
      }
    )

    if (result.err) {
      throw domainErrorToTrpcError(result.err, "Failed to schedule subscription phase")
    }

    return result.val
  })
