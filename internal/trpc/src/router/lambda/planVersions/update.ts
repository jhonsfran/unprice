import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import {
  configFlatSchema,
  configPackageSchema,
  configTierSchema,
  configUsageSchema,
  planVersionSelectBaseSchema,
} from "@unprice/db/validators"

import { FEATURE_SLUGS } from "@unprice/config"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const update = protectedProjectProcedure
  .input(planVersionSelectBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      status,
      id,
      description,
      currency,
      billingConfig,
      gracePeriod,
      title,
      tags,
      whenToBill,
      paymentProvider,
      metadata,
      autoRenew,
      trialUnits,
    } = opts.input

    const project = opts.ctx.project

    // only owner and admin can update a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const workspace = opts.ctx.project.workspace
    const customerId = workspace.unPriceCustomerId
    const featureSlug = FEATURE_SLUGS.PLANS.SLUG

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId,
      featureSlug,
      isMain: workspace.isMain,
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

    const planVersionData = await opts.ctx.db.query.versions.findFirst({
      with: {
        plan: {
          columns: {
            slug: true,
          },
        },
      },
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, project.id)),
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version not found",
      })
    }

    if (planVersionData.status === "published") {
      // only allow to update the status && description
      const data = await opts.ctx.db
        .update(schema.versions)
        .set({
          ...(description && { description }),
          ...(status && { status }),
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.versions.id, planVersionData.id)))
        .returning()
        .then((re) => re[0])

      if (!data) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Error updating version",
        })
      }

      return {
        planVersion: data,
      }
    }

    // Very costly operation -- this only happens when the currency is updated and the plan is not published
    // if the user wants to update the currency, we have to go over all the features and update the currency
    const versionUpdated = await opts.ctx.db.transaction(async (tx) => {
      if (currency && currency !== planVersionData.currency) {
        await tx.query.planVersionFeatures
          .findMany({
            where: (feature, { and, eq }) =>
              and(eq(feature.planVersionId, planVersionData.id), eq(feature.projectId, project.id)),
          })
          .then(async (features) => {
            await Promise.all(
              features.map(async (feature) => {
                // here we have to take into account the feature type
                switch (feature.featureType) {
                  case "flat": {
                    const config = configFlatSchema.parse(feature.config)

                    return await tx
                      .update(schema.planVersionFeatures)
                      .set({
                        config: {
                          ...config,
                          price: {
                            ...config.price,
                            dinero: {
                              ...config.price.dinero,
                              currency: {
                                ...config.price.dinero.currency,
                                code: currency,
                              },
                            },
                          },
                        },
                      })
                      .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                  }

                  case "tier": {
                    const config = configTierSchema.parse(feature.config)

                    return await tx
                      .update(schema.planVersionFeatures)
                      .set({
                        config: {
                          ...config,
                          tiers: config.tiers.map((tier) => ({
                            ...tier,
                            unitPrice: {
                              ...tier.unitPrice,
                              dinero: {
                                ...tier.unitPrice.dinero,
                                currency: {
                                  ...tier.unitPrice.dinero.currency,
                                  code: currency,
                                },
                              },
                            },
                            flatPrice: {
                              ...tier.flatPrice,
                              dinero: {
                                ...tier.flatPrice.dinero,
                                currency: {
                                  ...tier.flatPrice.dinero.currency,
                                  code: currency,
                                },
                              },
                            },
                          })),
                        },
                      })
                      .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                  }

                  case "usage": {
                    const config = configUsageSchema.parse(feature.config)

                    if (config.tiers && config.tiers.length > 0) {
                      return await tx
                        .update(schema.planVersionFeatures)
                        .set({
                          config: {
                            ...config,
                            tiers: config.tiers.map((tier) => ({
                              ...tier,
                              unitPrice: {
                                ...tier.unitPrice,
                                dinero: {
                                  ...tier.unitPrice.dinero,
                                  currency: {
                                    ...tier.unitPrice.dinero.currency,
                                    code: currency,
                                  },
                                },
                              },
                              flatPrice: {
                                ...tier.flatPrice,
                                dinero: {
                                  ...tier.flatPrice.dinero,
                                  currency: {
                                    ...tier.flatPrice.dinero.currency,
                                    code: currency,
                                  },
                                },
                              },
                            })),
                          },
                        })
                        .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                    }

                    if (config.price) {
                      return await tx
                        .update(schema.planVersionFeatures)
                        .set({
                          config: {
                            ...config,
                            price: {
                              ...config.price,
                              dinero: {
                                ...config.price.dinero,
                                currency: {
                                  ...config.price.dinero.currency,
                                  code: currency,
                                },
                              },
                            },
                          },
                        })
                        .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                    }

                    break
                  }

                  case "package": {
                    const config = configPackageSchema.parse(feature.config)

                    return await tx
                      .update(schema.planVersionFeatures)
                      .set({
                        config: {
                          ...config,
                          price: {
                            ...config.price,
                            dinero: {
                              ...config.price.dinero,
                              currency: {
                                ...config.price.dinero.currency,
                                code: currency,
                              },
                            },
                          },
                        },
                      })
                      .where(and(eq(schema.planVersionFeatures.id, feature.id)))
                  }

                  default:
                    break
                }
              })
            )
          })
          .catch((err) => {
            console.error(err)
            tx.rollback()
            throw err
          })
      }

      const data = await tx
        .update(schema.versions)
        .set({
          ...(description && { description }),
          ...(currency && { currency }),
          ...(billingConfig && { billingConfig }),
          ...(gracePeriod !== undefined && { gracePeriod }),
          ...(title && { title }),
          ...(tags && { tags }),
          ...(whenToBill && { whenToBill }),
          ...(autoRenew && { autoRenew }),
          ...(status && { status }),
          ...(metadata && { metadata }),
          ...(paymentProvider && { paymentProvider }),
          ...(trialUnits !== undefined && { trialUnits }),
          updatedAtM: Date.now(),
        })
        .where(and(eq(schema.versions.id, planVersionData.id)))
        .returning()
        .then((re) => re[0])

      return data
    })

    if (!versionUpdated) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error updating version",
      })
    }

    return {
      planVersion: versionUpdated,
    }
  })
