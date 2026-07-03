import { TRPCError } from "@trpc/server"
import { selectApiKeySchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const rollDefaultSdkExample = protectedProjectProcedure
  .output(
    z.object({
      apikey: selectApiKeySchema.extend({
        key: z.string(),
        state: z.enum(["created", "rolled"]),
      }),
    })
  )
  .mutation(async (opts) => {
    const { project } = opts.ctx
    const { apikeys } = opts.ctx.services

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { val: apikey, err } = await apikeys.rollDefaultSdkExampleApiKey({
      projectId: project.id,
      isRoot: project.workspace.isMain,
      timezone: project.timezone,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return { apikey }
  })
