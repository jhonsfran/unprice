import { TRPCError } from "@trpc/server"
import {
  listIngestionEvents as listEvents,
  listIngestionEventsInputSchema,
  listIngestionEventsOutputSchema,
} from "@unprice/services/use-cases"
import { protectedProjectProcedure } from "#trpc"

export const listIngestionEvents = protectedProjectProcedure
  .input(
    listIngestionEventsInputSchema.extend({
      scope: listIngestionEventsInputSchema.shape.scope.omit({ projectId: true }),
    })
  )
  .output(listIngestionEventsOutputSchema)
  .query(async ({ ctx, input }) => {
    const result = await listEvents(
      { budgetJournal: ctx.services.budgetJournal },
      { ...input, scope: { ...input.scope, projectId: ctx.project.id } }
    )
    if (result.err)
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.err.message })
    return result.val
  })
