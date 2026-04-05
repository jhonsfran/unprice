import { TRPCError } from "@trpc/server"
import { domainSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

export const getAllByActiveWorkspace = protectedWorkspaceProcedure
  .input(z.void())
  .output(
    z.object({
      domains: z.array(domainSelectBaseSchema),
    })
  )
  .query(async (opts) => {
    const workspace = opts.ctx.workspace
    const { domains: domainsService } = opts.ctx.services

    const { err, val: domains } = await domainsService.listDomainsByWorkspace({
      workspaceId: workspace.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      domains,
    }
  })
