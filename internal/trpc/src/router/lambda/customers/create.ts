import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { customerInsertBaseSchema, customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(customerInsertBaseSchema)
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const {
      description,
      name,
      email,
      metadata,
      defaultCurrency,
      stripeCustomerId,
      timezone,
      externalId,
    } = opts.input
    const { project } = opts.ctx
    const { customers } = opts.ctx.services

    // remove ip from geolocation
    const { ip, ...geolocation } = opts.ctx.geolocation
    const metadataWithGeolocation = metadata ? { ...metadata, ...geolocation } : geolocation

    const { val: customerData, err } = await customers.createCustomerRecord({
      projectId: project.id,
      description,
      name,
      email,
      metadata: metadataWithGeolocation,
      defaultCurrency,
      stripeCustomerId,
      timezone,
      externalId,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return {
      customer: customerData,
    }
  })
