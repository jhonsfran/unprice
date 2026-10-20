import { TRPCError } from "@trpc/server"
import { budgetAuditRowSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

const AUDIT_ROWS = 20

/** The budget's latest operator actions, newest first. */
export const audit = protectedProjectProcedure
  .input(z.object({ id: z.string() }))
  .output(z.array(budgetAuditRowSchema))
  .query(async (opts) => {
    const result = await opts.ctx.services.budgetAudit.list(
      opts.ctx.project.id,
      opts.input.id,
      AUDIT_ROWS
    )

    if (result.err) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.err.message })
    }
    return result.val
  })
