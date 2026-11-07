import { TRPCError } from "@trpc/server"
import {
  planInsertBaseSchema,
  planSelectBaseSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"
import { createPlanWithDraft } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

/** Creates a plan with its first draft version, so the caller can open the editor at once. */
export const createWithDraft = protectedProjectProcedure
  .input(planInsertBaseSchema.extend({ trialUnits: z.number().int().min(0).optional() }))
  .output(z.object({ plan: planSelectBaseSchema, planVersion: planVersionSelectBaseSchema }))
  .mutation(async (opts) => {
    const project = opts.ctx.project
    opts.ctx.verifyRole(["OWNER", "ADMIN"])
    const { trialUnits, ...input } = opts.input

    const { err, val } = await createPlanWithDraft(
      { services: opts.ctx.services, db: opts.ctx.db, logger: opts.ctx.logger },
      { input, projectId: project.id, currency: project.defaultCurrency, trialUnits }
    )
    if (err) throw new TRPCError({ code: "CONFLICT", message: err.message })
    return val
  })
