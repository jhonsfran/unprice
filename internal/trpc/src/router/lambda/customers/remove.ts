import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { and, eq } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const remove = protectedProjectProcedure
  .meta({
    span: "customers.remove",
    openapi: {
      method: "POST",
      path: "/lambda/customers.remove",
      protect: true,
    },
  })
  .input(customerSelectSchema.pick({ id: true }))
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const { project } = opts.ctx
    const unPriceCustomerId = project.workspace.unPriceCustomerId

    const result = await featureGuard({
      customerId: unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.CUSTOMERS.SLUG,
      isMain: project.workspace.isMain,
      metadata: {
        action: "remove",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const deletedCustomer = await opts.ctx.db
      .delete(customers)
      .where(and(eq(customers.projectId, project.id), eq(customers.id, id)))
      .returning()
      .then((re) => re[0])

    if (!deletedCustomer) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deleting customer",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        reportUsageFeature({
          customerId: unPriceCustomerId,
          featureSlug: "customers",
          usage: -1,
          isMain: project.workspace.isMain,
          metadata: {
            action: "remove",
          },
        })
      )
    }

    return {
      customer: deletedCustomer,
    }
  })
