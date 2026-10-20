import { budgetKeyInputSchema } from "@unprice/db/validators"
import { openBudgetByKey } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { budgetTrpcError } from "./budget-error"

/** The catalog id of the budget at a key, registering it if the catalog missed it. */
export const openByKey = protectedProjectProcedure
  .input(z.object({ key: budgetKeyInputSchema }))
  .output(z.object({ id: z.string() }))
  .mutation(async (opts) => {
    const result = await openBudgetByKey(
      {
        services: {
          budgetCatalog: opts.ctx.services.budgetCatalog,
          budgetOperator: opts.ctx.services.budgetOperator,
        },
        logger: opts.ctx.logger,
      },
      { projectId: opts.ctx.project.id, key: opts.input.key }
    )

    if (result.err) throw budgetTrpcError(result.err)
    return result.val
  })
