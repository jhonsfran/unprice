import { TRPCError } from "@trpc/server"
import { Unprice } from "@unprice/api"
import { runTestBudget, runTestBudgetOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { env } from "#env"
import { protectedProjectProcedure } from "#trpc"

/**
 * Creates the project's sandbox test budget and runs one allowed and one denied spend against it,
 * through the public API with a short-lived runtime key, so the Budgets page can show the cap hold.
 */
export const createTestBudget = protectedProjectProcedure
  .input(z.object({}).optional())
  .output(runTestBudgetOutputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await runTestBudget(
      {
        services: { apikeys: opts.ctx.services.apikeys },
        logger: opts.ctx.logger,
        createApiClient: (token) => new Unprice({ token, baseUrl: env.UNPRICE_API_URL }),
      },
      {
        projectId: opts.ctx.project.id,
        workspaceIsMain: opts.ctx.project.workspace.isMain,
      }
    )

    if (result.err) {
      throw new TRPCError({ code: "BAD_REQUEST", message: result.err.message })
    }

    return result.val
  })
