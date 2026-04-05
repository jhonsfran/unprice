import { TRPCError } from "@trpc/server"
import {
  planSelectBaseSchema,
  planVersionSelectBaseSchema,
  projectExtendedSelectSchema,
} from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getVersionsBySlug = protectedProjectProcedure
  .input(z.object({ slug: z.string() }))
  .output(
    z.object({
      plan: planSelectBaseSchema.extend({
        versions: z.array(
          planVersionSelectBaseSchema.extend({
            subscriptions: z.number(),
            plan: planSelectBaseSchema.pick({ defaultPlan: true }),
          })
        ),
      }),
      project: projectExtendedSelectSchema,
    })
  )
  .query(async (opts) => {
    const { slug } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    const { err, val: planWithVersions } = await plans.getPlanWithVersionsBySlug({
      slug,
      projectId: project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!planWithVersions) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan not found",
      })
    }

    return {
      plan: planWithVersions,
      project: project,
    }
  })
