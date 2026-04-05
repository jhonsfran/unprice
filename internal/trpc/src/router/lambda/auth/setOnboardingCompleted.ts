import { TRPCError } from "@trpc/server"
import { setOnboardingCompleted as setOnboardingCompletedUseCase } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProcedure } from "#trpc"

export const setOnboardingCompleted = protectedProcedure
  .input(z.object({ onboardingCompleted: z.boolean() }))
  .output(z.object({ success: z.boolean() }))
  .mutation(async (opts) => {
    const { onboardingCompleted } = opts.input
    const userId = opts.ctx.userId

    const { err } = await setOnboardingCompletedUseCase(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        userId,
        onboardingCompleted,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      success: true,
    }
  })
