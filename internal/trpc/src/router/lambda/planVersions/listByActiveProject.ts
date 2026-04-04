import { TRPCError } from "@trpc/server"
import { getPlanVersionApiResponseSchema, getPlanVersionListSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"


export const listByActiveProject = protectedProjectProcedure
  .input(getPlanVersionListSchema)
  .output(
    z.object({
      planVersions: getPlanVersionApiResponseSchema.array(),
    })
  )
  .query(async (opts) => {
    const { plans } = opts.ctx.services

    const { err, val: planVersionData } = await plans.listPlanVersions({
      projectId: opts.ctx.project.id,
      query: {
        published: opts.input.onlyPublished,
        enterprise: opts.input.onlyEnterprisePlan,
        latest: opts.input.onlyLatest,
        currency: opts.input.currency,
        billingInterval: opts.input.billingInterval,
      },
      opts: {
        skipCache: true,
      },
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      planVersions: planVersionData ?? [],
    }
  })
