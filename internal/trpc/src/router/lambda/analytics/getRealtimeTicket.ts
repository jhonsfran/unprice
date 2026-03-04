import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const getRealtimeTicket = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(
    z.object({
      ticket: z.string(),
      expiresAt: z.number().int(),
    })
  )
  .mutation(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const customer = await opts.ctx.db.query.customers.findFirst({
      where: (table, { and, eq }) => and(eq(table.id, customerId), eq(table.projectId, project.id)),
      columns: {
        id: true,
        projectId: true,
      },
    })

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const { result, error } = await unprice.analytics.getRealtimeTicket({
      customerId: customer.id,
      projectId: customer.projectId,
    })

    if (error || !result) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error?.message ?? "Failed to refresh realtime ticket",
      })
    }

    return {
      ticket: result.ticket,
      expiresAt: Math.floor(result.expiresAt / 1000),
    }
  })
