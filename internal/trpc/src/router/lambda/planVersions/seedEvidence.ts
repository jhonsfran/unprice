import { TRPCError } from "@trpc/server"
import { Unprice } from "@unprice/api"
import {
  seedOnboardingEvidence,
  seedOnboardingEvidenceOutputSchema,
  seedOnboardingEvidenceRequestSchema,
} from "@unprice/services/use-cases"
import { env } from "#env"
import { protectedProjectProcedure } from "#trpc"

export const seedEvidence = protectedProjectProcedure
  .input(seedOnboardingEvidenceRequestSchema)
  .output(seedOnboardingEvidenceOutputSchema)
  .mutation(async (opts) => {
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const project = opts.ctx.project
    const { err, val } = await seedOnboardingEvidence(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        createApiClient: (token) =>
          new Unprice({
            token,
            baseUrl: env.UNPRICE_API_URL,
          }),
      },
      {
        planVersionId: opts.input.planVersionId,
        projectId: project.id,
        projectTimezone: project.timezone,
        projectDefaultCurrency: project.defaultCurrency,
        workspaceIsMain: project.workspace.isMain,
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
