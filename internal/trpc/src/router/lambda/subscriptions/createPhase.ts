import { TRPCError } from "@trpc/server"
import {
  subscriptionPhaseInsertSchema,
  subscriptionPhaseSelectSchema,
} from "@unprice/db/validators"
import { BillingService } from "@unprice/services/billing"
import { CustomerService } from "@unprice/services/customers"
import { GrantsManager } from "@unprice/services/entitlements"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const createPhase = protectedProjectProcedure
  .input(subscriptionPhaseInsertSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async ({ input, ctx }) => {
    const projectId = ctx.project.id

    const customerService = new CustomerService(ctx)
    const grantsManager = new GrantsManager(ctx)
    const billingService = new BillingService({ ...ctx, customerService, grantsManager })
    const subscriptionService = new SubscriptionService({ ...ctx, customerService, billingService })

    const { err, val } = await subscriptionService.createPhase({
      input,
      projectId,
      now: Date.now(),
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      phase: val,
    }
  })
