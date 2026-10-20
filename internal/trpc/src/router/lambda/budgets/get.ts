import { TRPCError } from "@trpc/server"
import { budgetCatalogRowSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

/** The catalog row behind a budget page's header, read without waking the budget. */
export const get = protectedProjectProcedure
  .input(z.object({ id: z.string() }))
  .output(budgetCatalogRowSchema)
  .query(async (opts) => {
    const result = await opts.ctx.services.budgetCatalog.get(opts.ctx.project.id, {
      id: opts.input.id,
    })

    if (result.err) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.err.message })
    }
    if (!result.val) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Budget not found" })
    }

    return result.val
  })
