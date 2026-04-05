import { TRPCError } from "@trpc/server"
import { getPlanVersionApiResponseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProcedure } from "#trpc"

// global endpoint, no need to check for feature access
export const listByProjectUnprice = protectedProcedure
  .input(
    z.object({
      published: z.boolean().optional(),
      enterprisePlan: z.boolean().optional(),
      active: z.boolean().optional(),
    })
  )
  .output(
    z.object({
      planVersions: getPlanVersionApiResponseSchema.array(),
    })
  )
  .query(async (opts) => {
    const { published, enterprisePlan } = opts.input

    // find unprice project
    const mainProject = await opts.ctx.db.query.projects.findFirst({
      where: (project, { eq, and }) =>
        and(eq(project.isMain, true), eq(project.slug, "unprice-admin")),
    })

    if (!mainProject) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" })
    }

    const { plans } = opts.ctx.services

    const { err, val: planVersionData } = await plans.listPlanVersions({
      projectId: mainProject.id,
      query: {
        published,
        enterprise: enterprisePlan,
      },
      opts: {
        skipCache: true,
      },
    })

    if (err) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message })
    }

    return {
      planVersions: planVersionData ?? [],
    }
  })
