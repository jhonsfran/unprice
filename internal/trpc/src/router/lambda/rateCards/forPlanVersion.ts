import { getPlanVersionPricing } from "@unprice/services/use-cases"
import { z } from "zod"
import { domainErrorToTrpcError } from "#domain-error"
import { protectedProjectProcedure } from "#trpc"

export const forPlanVersion = protectedProjectProcedure
  .input(z.object({ planVersionId: z.string().min(1) }))
  .query(async (opts) => {
    const result = await getPlanVersionPricing(
      { services: opts.ctx.services },
      {
        projectId: opts.ctx.project.id,
        planVersionId: opts.input.planVersionId,
        now: Date.now(),
      }
    )
    if (result.err) throw domainErrorToTrpcError(result.err)
    return result.val
  })
