import { subscriptionInsertSchema, subscriptionSelectSchema } from "@unprice/db/validators"
import { createSubscription } from "@unprice/services/use-cases"
import { z } from "zod"

import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(subscriptionInsertSchema)
  .output(
    z.object({
      subscription: subscriptionSelectSchema,
    })
  )
  .mutation(async (opts) => {
    // only owner and admin can create a subscription
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // create the subscription
    const { err, val } = await createSubscription(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        input: opts.input,
        projectId: opts.ctx.project.id,
      }
    )

    if (err) {
      throw domainErrorToTrpcError(err, "Failed to create subscription")
    }

    return {
      subscription: val,
    }
  })
