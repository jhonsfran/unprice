import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { and, eq } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { unprice } from "#utils/unprice"

export const update = protectedProjectProcedure
  .meta({
    span: "customers.update",
    openapi: {
      method: "POST",
      path: "/lambda/customers.update",
      protect: true,
    },
  })
  .input(
    customerSelectSchema
      .pick({
        id: true,
        name: true,
        description: true,
        email: true,
        metadata: true,
        timezone: true,
        active: true,
      })
      .partial({
        description: true,
        metadata: true,
        timezone: true,
      })
  )
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { email, id, description, metadata, name, timezone, active } = opts.input
    const { project } = opts.ctx

    const unPriceCustomerId = project.workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.CUSTOMERS.SLUG

    const result = await featureGuard({
      customerId: unPriceCustomerId,
      featureSlug,
      isMain: project.workspace.isMain,
      metadata: {
        action: "update",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    const customerData = await opts.ctx.db.query.customers.findFirst({
      where: (feature, { eq, and }) => and(eq(feature.id, id), eq(feature.projectId, project.id)),
    })

    if (!customerData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const updatedCustomer = await opts.ctx.db
      .update(customers)
      .set({
        ...(email && { email }),
        ...(description && { description }),
        ...(name && { name }),
        ...(metadata && {
          metadata: {
            ...customerData.metadata,
            ...metadata,
          },
        }),
        ...(timezone && { timezone }),
        ...(active !== undefined && { active }),
        updatedAtM: Date.now(),
      })
      .where(and(eq(customers.id, id), eq(customers.projectId, project.id)))
      .returning()
      .then((data) => data[0])

    if (!updatedCustomer) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating customer",
      })
    }

    // if the customer is disabled, update the ACL
    if (updatedCustomer.active === false) {
      await unprice.customers.updateACL({
        customerId: id,
        updates: { customerDisabled: true },
      })
    }

    // if the customer is enabled, update the ACL
    if (updatedCustomer.active === true) {
      await unprice.customers.updateACL({
        customerId: id,
        updates: { customerDisabled: false },
      })
    }

    return {
      customer: updatedCustomer,
    }
  })
