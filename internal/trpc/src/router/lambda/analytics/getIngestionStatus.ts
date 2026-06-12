import { TRPCError } from "@trpc/server"
import {
  getIngestionStatusOutputSchema,
  getIngestionStatus as getIngestionStatusUseCase,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getIngestionStatus = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string().optional(),
      window: z
        .object({
          from: z.number().int(),
          to: z.number().int(),
        })
        .refine((window) => window.from < window.to, {
          message: "window.to must be greater than window.from",
          path: ["to"],
        }),
      filter: z
        .object({
          sourceId: z.string().optional(),
          eventSlug: z.string().optional(),
          state: z.enum(["processed", "rejected"]).optional(),
        })
        .optional()
        .default({}),
      limit: z.number().int().min(1).max(100).optional().default(100),
    })
  )
  .output(getIngestionStatusOutputSchema)
  .query(async (opts) => {
    const result = await getIngestionStatusUseCase(
      {
        analytics: opts.ctx.analytics,
      },
      {
        projectId: opts.ctx.project.id,
        customerId: opts.input.customerId,
        window: opts.input.window,
        filter: opts.input.filter,
        limit: opts.input.limit,
      }
    )

    if (result.err) {
      opts.ctx.logger.error(result.err, {
        context: "getIngestionStatus failed",
        project_id: opts.ctx.project.id,
        ...(opts.input.customerId ? { customer_id: opts.input.customerId } : {}),
      })

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return result.val
  })
