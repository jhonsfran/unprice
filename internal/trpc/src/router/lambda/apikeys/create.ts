import { TRPCError } from "@trpc/server"
import { createApiKeySchema, selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(createApiKeySchema)
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
      }),
    })
  )
  .mutation(async (opts) => {
    const { name, expiresAt } = opts.input
    const project = opts.ctx.project
    const isRoot = project.workspace.isMain
    const { apikeys } = opts.ctx.services

    // only owner and admin
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: newApiKey, err } = await apikeys.createApiKey({
      projectId: project.id,
      isRoot,
      name,
      expiresAt,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return { apikey: newApiKey }
  })
