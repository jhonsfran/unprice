import { TRPCError } from "@trpc/server"
import { planSelectBaseSchema, planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"

export const listByActiveProject = protectedProjectProcedure
  .input(
    z.object({
      fromDate: z.number().optional(),
      toDate: z.number().optional(),
      published: z.boolean().optional(),
      active: z.boolean().optional(),
    })
  )
  .output(
    z.object({
      plans: z.array(
        planSelectBaseSchema.extend({
          versions: z.array(
            planVersionSelectBaseSchema.pick({
              id: true,
              status: true,
              title: true,
              currency: true,
              version: true,
            })
          ),
        })
      ),
    })
  )
  .query(async (opts) => {
    const { fromDate, toDate, published, active } = opts.input
    const project = opts.ctx.project
    const { plans: plansService } = opts.ctx.services

    const { err, val: plans } = await plansService.listPlansByProject({
      projectId: project.id,
      fromDate,
      toDate,
      published,
      active,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      plans,
    }
  })
