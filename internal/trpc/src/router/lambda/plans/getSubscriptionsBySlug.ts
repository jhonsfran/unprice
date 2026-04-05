import { TRPCError } from "@trpc/server"
import { z } from "zod"

import {
  customerSelectSchema,
  planSelectBaseSchema,
  projectExtendedSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const getSubscriptionsBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema,
      subscriptions: subscriptionSelectSchema
        .extend({
          customer: customerSelectSchema,
        })
        .array(),
      project: projectExtendedSelectSchema,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val } = await plans.getPlanSubscriptionsBySlug({
      slug,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    const { plan, subscriptions } = val

    if (!plan) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    return {
      plan,
      project,
      subscriptions,
    }
  })
