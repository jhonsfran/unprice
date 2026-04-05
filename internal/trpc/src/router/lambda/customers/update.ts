import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"
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
    const { customers } = opts.ctx.services

    const _unPriceCustomerId = project.workspace.unPriceCustomerId

    const { err, val } = await customers.updateCustomerRecord({
      id,
      projectId: project.id,
      email,
      description,
      metadata,
      name,
      timezone,
      active,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    const updatedCustomer = val.customer

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
