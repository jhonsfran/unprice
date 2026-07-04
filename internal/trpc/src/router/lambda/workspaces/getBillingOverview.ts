import { TRPCError } from "@trpc/server"
import { analyticsIntervalSchema } from "@unprice/analytics"
import { paymentProviderSchema } from "@unprice/db/validators"
import {
  emptyUsageDashboardOutput,
  getCustomerCurrentAccess,
  getCustomerCurrentAccessOutputSchema,
  getCustomerWallet,
  getCustomerWalletOutputSchema,
  getUsageDashboard,
  getUsageDashboardOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedWorkspaceProcedure } from "#trpc"

const getBillingOverviewInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  range: analyticsIntervalSchema,
})

const getBillingOverviewOutputSchema = z.object({
  customerId: z.string(),
  billingProjectId: z.string(),
  paymentProvider: paymentProviderSchema.nullable(),
  access: getCustomerCurrentAccessOutputSchema,
  customer: getCustomerWalletOutputSchema.shape.customer,
  wallet: getCustomerWalletOutputSchema.shape.wallet,
  usage: getUsageDashboardOutputSchema,
})

export const getBillingOverview = protectedWorkspaceProcedure
  .input(getBillingOverviewInputSchema)
  .output(getBillingOverviewOutputSchema)
  .query(async (opts) => {
    const customerId = opts.ctx.workspace.unPriceCustomerId
    const range = opts.input.range

    if (!customerId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace billing customer not found",
      })
    }

    const customerResult =
      await opts.ctx.services.customers.getCustomerByIdAcrossProjects(customerId)

    if (customerResult.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: customerResult.err.message,
      })
    }

    const customer = customerResult.val

    if (!customer) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace billing customer not found",
      })
    }

    const billingProjectId = customer.projectId

    const [accessResult, walletResult, usageResult] = await Promise.all([
      getCustomerCurrentAccess(
        {
          db: opts.ctx.db,
          analytics: opts.ctx.analytics,
          logger: opts.ctx.logger,
        },
        {
          projectId: billingProjectId,
          customerId,
        }
      ),
      getCustomerWallet(
        {
          services: {
            customers: opts.ctx.services.customers,
            wallet: opts.ctx.services.wallet,
          },
          logger: opts.ctx.logger,
        },
        {
          projectId: billingProjectId,
          customerId,
        }
      ),
      getUsageDashboard(
        {
          analytics: opts.ctx.analytics,
          db: opts.ctx.db,
        },
        {
          projectId: billingProjectId,
          customerId,
          range,
        }
      ),
    ])

    if (accessResult.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: accessResult.err.message,
      })
    }

    if (!accessResult.val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace billing access not found",
      })
    }

    if (walletResult.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: walletResult.err.message,
      })
    }

    if (!walletResult.val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace billing wallet not found",
      })
    }

    if (usageResult.err) {
      opts.ctx.logger.error(usageResult.err, {
        context: "workspace billing usage dashboard failed",
        project_id: billingProjectId,
        customer_id: customerId,
        range,
      })
    }

    return {
      customerId,
      billingProjectId,
      paymentProvider: accessResult.val.activePlan?.activePhase?.paymentProvider ?? null,
      access: accessResult.val,
      customer: walletResult.val.customer,
      wallet: walletResult.val.wallet,
      usage:
        usageResult.val ??
        emptyUsageDashboardOutput(
          range,
          usageResult.err instanceof Error ? usageResult.err.message : "Failed to fetch usage"
        ),
    }
  })
