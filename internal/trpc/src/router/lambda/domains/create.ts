import { TRPCError } from "@trpc/server"
import { newId } from "@unprice/db/utils"
import { domainCreateBaseSchema, domainSelectBaseSchema } from "@unprice/db/validators"
import { Vercel } from "@unprice/vercel"
import { z } from "zod"
import { env } from "#env"
import { protectedWorkspaceProcedure } from "#trpc"

export const create = protectedWorkspaceProcedure
  .input(domainCreateBaseSchema.pick({ name: true }))
  .output(z.object({ domain: domainSelectBaseSchema }))
  .mutation(async (opts) => {
    const workspace = opts.ctx.workspace
    const domain = opts.input.name
    const { domains } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err: domainExistsErr, val: domainExist } = await domains.domainExistsByName({
      name: domain,
    })

    if (domainExistsErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: domainExistsErr.message,
      })
    }

    if (domainExist) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Domain already exists",
      })
    }

    const vercel = new Vercel({
      accessToken: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
    })

    const response = await vercel.addProjectDomain(env.VERCEL_PROJECT_UNPRICE_ID, domain)

    if (response.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: response.err.message,
      })
    }

    const domainVercel = response.val

    if (!domainVercel.apexName || !domainVercel.name) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error adding domain to domain provider",
      })
    }

    const domainId = newId("domain")

    const { err: createErr, val: domainData } = await domains.createDomain({
      domainId,
      name: domainVercel.name,
      apexName: domainVercel.apexName,
      workspaceId: workspace.id,
    })

    if (createErr) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: createErr.message,
      })
    }

    if (!domainData) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error adding domain",
      })
    }

    return { domain: domainData }
  })
