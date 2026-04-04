import { TRPCError } from "@trpc/server"
import { subscriptionPhaseSelectSchema } from "@unprice/db/validators"
import { BillingService } from "@unprice/services/billing"
import { CustomerService } from "@unprice/services/customers"
import { GrantsManager } from "@unprice/services/entitlements"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const updatePhase = protectedProjectProcedure
  .input(subscriptionPhaseSelectSchema)
  .output(z.object({ phase: subscriptionPhaseSelectSchema }))
  .mutation(async (opts) => {
    const projectId = opts.ctx.project.id

    const customerService = new CustomerService(opts.ctx)
    const grantsManager = new GrantsManager(opts.ctx)
    const billingService = new BillingService({ ...opts.ctx, customerService, grantsManager })
    const subscriptionService = new SubscriptionService({ ...opts.ctx, customerService, billingService })

    const { err, val } = await subscriptionService.updatePhase({
      input: opts.input,
      projectId,
      subscriptionId: opts.input.subscriptionId,
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
