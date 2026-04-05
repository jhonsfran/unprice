import { TRPCError } from "@trpc/server"
import { domainSelectBaseSchema, domainUpdateBaseSchema } from "@unprice/db/validators"
import { Vercel } from "@unprice/vercel"
import { z } from "zod"
import { env } from "#env"
import { protectedWorkspaceProcedure } from "#trpc"

export const update = protectedWorkspaceProcedure
  .input(domainUpdateBaseSchema)
  .output(z.object({ domain: domainSelectBaseSchema }))
  .mutation(async (opts) => {
    const workspace = opts.ctx.workspace
    const { id, name: domain } = opts.input
    const { domains } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err: oldDomainErr, val: oldDomain } = await domains.getDomainById({
      domainId: id,
      workspaceId: workspace.id,
    })

    if (oldDomainErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: oldDomainErr.message,
      })
    }

    if (!oldDomain) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Domain not found",
      })
    }

    if (oldDomain.name === domain) {
      return { domain: oldDomain }
    }

    const { err: existsErr, val: newDomainExist } = await domains.domainExistsByName({
      name: domain,
    })

    if (existsErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: existsErr.message,
      })
    }

    if (newDomainExist) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "New Domain already register in the system",
      })
    }

    const vercel = new Vercel({
      accessToken: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
    })

    const removeData = await vercel.removeProjectDomain(
      env.VERCEL_PROJECT_UNPRICE_ID,
      oldDomain.name
    )

    if (removeData.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: removeData.err.message,
      })
    }

    const addData = await vercel.addProjectDomain(env.VERCEL_PROJECT_UNPRICE_ID, domain)

    if (addData.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: addData.err.message,
      })
    }

    const { err: updateErr, val: updateDomain } = await domains.updateDomainName({
      domainId: id,
      workspaceId: workspace.id,
      name: domain,
    })

    if (updateErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: updateErr.message,
      })
    }

    if (!updateDomain) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating domain",
      })
    }

    return { domain: updateDomain }
  })
