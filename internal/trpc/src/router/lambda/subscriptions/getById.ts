import { TRPCError } from "@trpc/server"
import { subscriptionPhaseExtendedSchema, subscriptionSelectSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

const getByIdOutputSchema = z.object({
  subscription: subscriptionSelectSchema.extend({
    phases: subscriptionPhaseExtendedSchema.array(),
  }),
})

export const getById = protectedProjectProcedure
  .input(
    subscriptionSelectSchema.pick({ id: true }).extend({
      projectSlug: z.string().optional(),
    })
  )
  .output(getByIdOutputSchema)
  .query(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx
    const { subscriptions } = opts.ctx.services

    const { err, val: subscriptionData } = await subscriptions.getSubscriptionById({
      subscriptionId: id,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!subscriptionData) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Subscription not found",
      })
    }

    const subscription = subscriptionData as {
      phases: Array<{
        items: unknown[]
        planVersion: unknown
      }>
    } & Record<string, unknown>

    return getByIdOutputSchema.parse({
      subscription: {
        ...subscription,
        phases: subscription.phases.map((phase) => ({
          ...phase,
          items: phase.items,
          planVersion: phase.planVersion,
        })),
      },
    })
  })
