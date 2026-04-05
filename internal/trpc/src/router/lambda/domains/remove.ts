import { TRPCError } from "@trpc/server"
import { domainSelectBaseSchema } from "@unprice/db/validators"
import { Vercel } from "@unprice/vercel"
import { z } from "zod"
import { env } from "#env"
import { protectedWorkspaceProcedure } from "#trpc"

export const remove = protectedWorkspaceProcedure
  .input(z.object({ id: z.string() }))
  .output(
    z.object({
      domain: domainSelectBaseSchema.optional(),
    })
  )
  .mutation(async (opts) => {
    const workspace = opts.ctx.workspace
    const { domains } = opts.ctx.services

    // only owner can remove a domain
    opts.ctx.verifyRole(["OWNER"])

    const { err: domainErr, val: domain } = await domains.getDomainById({
      domainId: opts.input.id,
      workspaceId: workspace.id,
    })

    if (domainErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: domainErr.message,
      })
    }

    if (!domain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Domain not found",
      })
    }

    // TODO: I also need to remove the domain from the vercel account
    // not that easy as delete it and we are done, but maybe that domain is used for another account
    // maybe with a cron job that verify if the domain is used by another account and then remove it from our account
    // for now, I will just remove it from the project
    const vercel = new Vercel({
      accessToken: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
    })

    // remove the old domain from vercel
    const removeData = await vercel.removeProjectDomain(env.VERCEL_PROJECT_UNPRICE_ID, domain.name)

    if (removeData.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: removeData.err.message,
      })
    }

    const { err: deleteErr, val: deletedDomain } = await domains.removeDomainById({
      domainId: domain.id,
    })

    if (deleteErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: deleteErr.message,
      })
    }

    return {
      domain: deletedDomain ?? undefined,
    }
  })
