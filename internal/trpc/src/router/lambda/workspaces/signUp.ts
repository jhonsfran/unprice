import { newId } from "@unprice/db/utils"
import { signUpResponseSchema, workspaceSignupSchema } from "@unprice/db/validators"

import { TRPCError } from "@trpc/server"
import { protectedProcedure } from "#trpc"
import { unprice } from "#utils/unprice"

export const signUp = protectedProcedure
  .input(workspaceSignupSchema)
  .output(signUpResponseSchema)
  .mutation(async (opts) => {
    const { name, planVersionId, config, successUrl, cancelUrl, sessionId } = opts.input
    const user = opts.ctx.session?.user
    const workspaceId = newId("workspace")

    // TODO: need to validate if the user has access to PRO feature in order to validate
    // if he can create a workspace

    // sign up the customer
    const { error, result } = await unprice.customers.signUp({
      email: user.email,
      name: name,
      planVersionId,
      config,
      creditLinePolicy: "uncapped",
      successUrl,
      cancelUrl,
      externalId: workspaceId,
      sessionId,
      metadata: {
        country: opts.ctx.geolocation.country,
        region: opts.ctx.geolocation.region,
        city: opts.ctx.geolocation.city,
      },
    })

    if (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error.message,
      })
    }

    // TODO: send welcome email
    // opts.ctx.waitUntil(
    //   sendEmail({
    //     subject: "Welcome to Unprice 👋",
    //     to: [user.email],
    //     react: WelcomeEmail({ firstName: user.name ?? user.email }),
    //   })
    // )

    return result
  })
