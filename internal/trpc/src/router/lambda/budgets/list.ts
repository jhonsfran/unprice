import { TRPCError } from "@trpc/server"
import { budgetCatalogRowSchema, listBudgetsInputSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const list = protectedProjectProcedure
  .input(listBudgetsInputSchema)
  .output(z.object({ budgets: z.array(budgetCatalogRowSchema), pageCount: z.number() }))
  .query(async (opts) => {
    const result = await opts.ctx.services.budgetCatalog.list(opts.ctx.project.id, opts.input)

    if (result.err) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.err.message })
    }

    return { budgets: result.val.rows, pageCount: result.val.pageCount }
  })
