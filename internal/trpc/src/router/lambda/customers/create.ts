import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { customers } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import { customerInsertBaseSchema, customerSelectSchema } from "@unprice/db/validators"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const create = protectedProjectProcedure
  .meta({
    span: "customers.create",
    openapi: {
      method: "POST",
      path: "/lambda/customers.create",
      protect: true,
    },
  })
  .input(customerInsertBaseSchema)
  .output(z.object({ customer: customerSelectSchema }))
  .mutation(async (opts) => {
    const { description, name, email, metadata, defaultCurrency, stripeCustomerId, timezone } =
      opts.input
    const { project } = opts.ctx

    const unPriceCustomerId = project.workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.CUSTOMERS.SLUG

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId: unPriceCustomerId,
      featureSlug,
      isMain: project.workspace.isMain,
      metadata: {
        action: "create",
      },
    })

    if (!result.success) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: `This feature is not available on your current plan${result.deniedReason ? `: ${result.deniedReason}` : ""}`,
      })
    }

    // remove ip from geolocation
    const { ip, ...geolocation } = opts.ctx.geolocation
    const metadataWithGeolocation = metadata ? { ...metadata, ...geolocation } : geolocation

    const customerId = newId("customer")

    // TODO: check what happens when the currency changes?
    const customerData = await opts.ctx.db
      .insert(customers)
      .values({
        id: customerId,
        name,
        email,
        projectId: project.id,
        description,
        timezone: timezone || "UTC",
        active: true,
        ...(metadataWithGeolocation && { metadata: metadataWithGeolocation }),
        ...(defaultCurrency && { defaultCurrency }),
        ...(stripeCustomerId && { stripeCustomerId }),
      })
      .returning()
      .then((data) => data[0])

    if (!customerData) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error creating customer",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        // report usage for the new project in background
        reportUsageFeature({
          customerId: unPriceCustomerId,
          featureSlug,
          usage: 1,
          isMain: project.workspace.isMain,
          metadata: {
            action: "create",
          },
        })
      )
    }

    return {
      customer: customerData,
    }
  })
