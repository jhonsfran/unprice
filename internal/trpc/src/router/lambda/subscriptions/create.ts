import { subscriptionInsertSchema, subscriptionSelectSchema } from "@unprice/db/validators"
import { BillingService } from "@unprice/services/billing"
import { CustomerService } from "@unprice/services/customers"
import { GrantsManager } from "@unprice/services/entitlements"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(subscriptionInsertSchema)
  .output(
    z.object({
      subscription: subscriptionSelectSchema,
    })
  )
  .mutation(async (opts) => {
    const { phases, ...rest } = opts.input
    // only owner and admin can create a subscription
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const customerService = new CustomerService(opts.ctx)
    const grantsManager = new GrantsManager(opts.ctx)
    const billingService = new BillingService({ ...opts.ctx, customerService, grantsManager })
    const subscriptionService = new SubscriptionService({ ...opts.ctx, customerService, billingService })

    // create the subscription
    const { err, val } = await subscriptionService.createSubscription({
      input: rest,
      projectId: opts.ctx.project.id,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    // create the phases
    const phasesResult = await Promise.all(
      phases.map((phase) =>
        subscriptionService.createPhase({
          input: {
            ...phase,
            subscriptionId: val.id,
            customerId: val.customerId,
            paymentMethodRequired: phase.paymentMethodRequired ?? false,
          },
          projectId: opts.ctx.project.id,
          db: opts.ctx.db,
          now: Date.now(),
        })
      )
    )

    const phaseErr = phasesResult.find((r) => r.err)

    if (phaseErr?.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: phaseErr.err.message,
      })
    }

    return {
      subscription: val,
    }
  })
