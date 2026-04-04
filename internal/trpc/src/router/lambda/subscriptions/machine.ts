import { TRPCError } from "@trpc/server"
import { BillingService } from "@unprice/services/billing"
import { CustomerService } from "@unprice/services/customers"
import { GrantsManager } from "@unprice/services/entitlements"
import { SubscriptionService } from "@unprice/services/subscriptions"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const machine = protectedProjectProcedure
  .input(
    z.object({
      event: z.enum(["invoice", "renew", "billing_period", "finalize_invoice", "collect_payment"]),
      subscriptionId: z.string(),
      invoiceId: z.string().optional(),
    })
  )
  .output(z.object({ status: z.string() }))
  .mutation(async ({ input, ctx }) => {
    const projectId = ctx.project.id

    const customerService = new CustomerService(ctx)
    const grantsManager = new GrantsManager(ctx)
    const billingService = new BillingService({ ...ctx, customerService, grantsManager })
    const subscriptionService = new SubscriptionService({ ...ctx, customerService, billingService })

    switch (input.event) {
      case "collect_payment": {
        if (!input.invoiceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice ID is required",
          })
        }

        const { err, val } = await billingService.billingInvoice({
          subscriptionId: input.subscriptionId,
          invoiceId: input.invoiceId,
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
          status: val.status,
        }
      }

      case "finalize_invoice": {
        if (!input.invoiceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice ID is required",
          })
        }

        const { err, val } = await billingService.finalizeInvoice({
          subscriptionId: input.subscriptionId,
          projectId,
          invoiceId: input.invoiceId,
          now: Date.now(),
        })

        if (err) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: err.message,
          })
        }
        return {
          providerInvoiceId: val.providerInvoiceId,
          providerInvoiceUrl: val.providerInvoiceUrl,
          invoiceId: val.invoiceId,
          status: val.status,
        }
      }

      case "invoice": {
        const { err, val } = await subscriptionService.invoiceSubscription({
          subscriptionId: input.subscriptionId,
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
          status: val.status,
        }
      }

      case "renew": {
        const { err, val } = await subscriptionService.renewSubscription({
          subscriptionId: input.subscriptionId,
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
          status: val.status,
        }
      }

      case "billing_period": {
        const { err } = await billingService.generateBillingPeriods({
          subscriptionId: input.subscriptionId,
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
          status: "success",
        }
      }

      default:
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid event",
        })
    }
  })
