import { inspectBudgetQuerySchema } from "@unprice/db/validators"
import { inspectBudget, inspectBudgetOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { budgetTrpcError } from "./budget-error"

/** The budget's live state from its object, with the catalog row read-repair left behind. */
export const inspect = protectedProjectProcedure
  .input(inspectBudgetQuerySchema.extend({ id: z.string() }))
  .output(inspectBudgetOutputSchema)
  .query(async (opts) => {
    const { id, ...query } = opts.input
    const result = await inspectBudget(
      {
        services: {
          budgetCatalog: opts.ctx.services.budgetCatalog,
          budgetOperator: opts.ctx.services.budgetOperator,
        },
        logger: opts.ctx.logger,
      },
      { projectId: opts.ctx.project.id, id, query }
    )

    if (result.err) throw budgetTrpcError(result.err)
    return result.val
  })
