import {
  customerSelectSchema,
  searchParamsSchemaDataTable,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

import { TRPCError } from "@trpc/server"

const listByActiveProjectOutputSchema = z.object({
  subscriptions: subscriptionSelectSchema
    .extend({
      customer: customerSelectSchema,
    })
    .array(),
  pageCount: z.number(),
})

export const listByActiveProject = protectedProjectProcedure
  .input(searchParamsSchemaDataTable)
  .output(listByActiveProjectOutputSchema)
  .query(async (opts) => {
    const { page, page_size, from, to } = opts.input
    const project = opts.ctx.project
    const { subscriptions } = opts.ctx.services

    const { err, val } = await subscriptions.listSubscriptionsByProject({
      projectId: project.id,
      page,
      pageSize: page_size,
      from: from ?? undefined,
      to: to ?? undefined,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return listByActiveProjectOutputSchema.parse(val)
  })
