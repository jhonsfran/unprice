import { TRPCError } from "@trpc/server"
import { Unprice } from "@unprice/api"
import {
  runPaidActionProof,
  runPaidActionProofOutputSchema,
  runPaidActionProofRequestSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { env } from "#env"
import { protectedProjectProcedure } from "#trpc"

// projectSlug/workspaceSlug let the project middleware resolve the Sandbox the
// client just created without depending on the active-project cookie landing
// first.
const provePaidActionInputSchema = runPaidActionProofRequestSchema.extend({
  projectSlug: z.string().optional(),
  workspaceSlug: z.string().optional(),
})

export const provePaidAction = protectedProjectProcedure
  .input(provePaidActionInputSchema)
  .output(runPaidActionProofOutputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const project = opts.ctx.project
    const { err, val } = await runPaidActionProof(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        userId: opts.ctx.userId,
        createApiClient: (token) =>
          new Unprice({
            token,
            baseUrl: env.UNPRICE_API_URL,
          }),
      },
      {
        paidAction: opts.input.paidAction,
        projectId: project.id,
        projectTimezone: project.timezone,
        projectDefaultCurrency: project.defaultCurrency,
        workspaceIsMain: project.workspace.isMain,
        workspaceUnPriceCustomerId: project.workspace.unPriceCustomerId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: err.message,
      })
    }

    return val
  })
