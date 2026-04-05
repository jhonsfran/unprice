import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const exists = protectedWorkspaceProcedure
  .input(z.object({ domain: z.string() }))
  .output(z.object({ exist: z.boolean() }))
  .mutation(async (opts) => {
    const { domains } = opts.ctx.services

    const { err, val: exists } = await domains.domainExistsByName({
      name: opts.input.domain,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      exist: exists,
    }
  })
