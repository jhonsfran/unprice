import { TRPCError } from "@trpc/server"
import {
  type DomainVerificationStatusProps,
  domainVerificationStatusSchema,
} from "@unprice/db/validators"
import type { Domain } from "@unprice/vercel"
import { Vercel } from "@unprice/vercel"
import { z } from "zod"
import { env } from "#env"
import { protectedWorkspaceProcedure } from "#trpc"

export const verify = protectedWorkspaceProcedure
  .input(z.object({ domain: z.string() }))
  .output(
    z.object({
      status: domainVerificationStatusSchema,
      domainProvider: z.custom<Domain>().optional(),
    })
  )
  .query(async (opts) => {
    let status: DomainVerificationStatusProps = "Valid Configuration"
    const workspace = opts.ctx.workspace
    const { domains } = opts.ctx.services

    const vercel = new Vercel({
      accessToken: env.VERCEL_TOKEN,
      teamId: env.VERCEL_TEAM_ID,
    })

    const [domainVercel, configDomain] = await Promise.all([
      vercel.getProjectDomain(env.VERCEL_PROJECT_UNPRICE_ID, opts.input.domain),
      vercel.getDomainConfig(opts.input.domain),
    ])

    if (domainVercel?.err?.code === "not_found") {
      status = "Domain Not Found"
    } else if (domainVercel?.err) {
      status = "Unknown Error"
    } else if (!domainVercel?.val.verified) {
      status = "Pending Verification"

      const domainVerification = await vercel.verifyProjectDomain(
        env.VERCEL_PROJECT_UNPRICE_ID,
        opts.input.domain
      )

      if (domainVerification.val?.verified) {
        status = "Valid Configuration"
      } else {
        status = "Pending Verification"
      }
    } else if (configDomain.val?.misconfigured) {
      status = "Invalid Configuration"
    }

    const { err } = await domains.setDomainVerifiedStatus({
      workspaceId: workspace.id,
      name: opts.input.domain,
      verified: status === "Valid Configuration",
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      status,
      domainProvider: domainVercel.val,
    }
  })
