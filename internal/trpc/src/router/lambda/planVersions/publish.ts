import { and, eq, inArray } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { calculateFlatPricePlan, planVersionSelectBaseSchema } from "@unprice/db/validators"
import { isZero } from "dinero.js"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { FEATURE_SLUGS } from "@unprice/config"
import { CustomerService } from "@unprice/services/customers"
import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const publish = protectedProjectProcedure
  .input(planVersionSelectBaseSchema.partial().required({ id: true }))
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id } = opts.input

    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace

    // only owner and admin can publish a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    // check if the customer has access to the feature
    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: FEATURE_SLUGS.PLANS.SLUG,
      isMain: workspace.isMain,
      metadata: {
        action: "publish",
        module: "planVersion",
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
        planFeatures: {
          with: {
            feature: true,
          },
        },
        project: true,
        plan: true,
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
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Version already published",
      })
    }

    if (planVersionData.planFeatures.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot publish a version without features",
      })
    }

    // verify if the payment method is required
    const { err, val: totalPricePlan } = calculateFlatPricePlan({
      planVersion: planVersionData,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error calculating price plan",
      })
    }

    const paymentMethodRequired = !isZero(totalPricePlan.dinero)

    if (paymentMethodRequired) {
      const customerService = new CustomerService({
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        analytics: opts.ctx.analytics,
        waitUntil: opts.ctx.waitUntil,
        cache: opts.ctx.cache,
        metrics: opts.ctx.metrics,
      })

      const { err: validatePaymentMethodErr } = await customerService.validatePaymentMethod({
        customerId: workspace.unPriceCustomerId,
        projectId: project.id,
        paymentProvider: planVersionData.paymentProvider,
        requiredPaymentMethod: true,
      })

      if (validatePaymentMethodErr) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: validatePaymentMethodErr.message,
        })
      }
    }

    // update the plan version in a transaction
    const planVersionDataUpdated = await opts.ctx.db.transaction(async (tx) => {
      try {
        const flatFeaturesIds = planVersionData.planFeatures
          .filter((feature) => ["flat", "package", "tier"].includes(feature.featureType))
          .map((feature) => feature.id)

        if (flatFeaturesIds.length > 0) {
          // make sure the billing config for flat features in this plan is the same
          const planVersionFeaturesUpdated = await tx
            .update(schema.planVersionFeatures)
            .set({
              billingConfig: planVersionData.billingConfig,
            })
            .where(
              and(
                inArray(schema.planVersionFeatures.id, flatFeaturesIds),
                eq(schema.planVersionFeatures.projectId, project.id),
                inArray(schema.planVersionFeatures.featureType, ["flat", "package", "tier"])
              )
            )
            .returning()
            .then((re) => re[0])

          if (!planVersionFeaturesUpdated) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Error publishing version",
            })
          }
        }

        // set the latest version to false if there is a latest version for this plan
        await tx
          .update(schema.versions)
          .set({
            latest: false,
          })
          .where(
            and(
              eq(schema.versions.projectId, project.id),
              eq(schema.versions.latest, true),
              eq(schema.versions.planId, planVersionData.planId)
            )
          )
          .returning()
          .then((re) => re[0])

        const versionUpdated = await tx
          .update(schema.versions)
          .set({
            status: "published",
            updatedAtM: Date.now(),
            publishedAt: Date.now(),
            publishedBy: opts.ctx.userId,
            latest: true,
            paymentMethodRequired,
          })
          .where(and(eq(schema.versions.id, planVersionData.id)))
          .returning()
          .then((re) => re[0])

        if (!versionUpdated) {
          opts.ctx.logger.error("Version not updated", {
            planVersionData,
          })

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Error publishing version",
          })
        }

        return versionUpdated
      } catch (error) {
        const e = error as Error
        opts.ctx.logger.error("Error publishing version", {
          error: e.toString(),
        })

        tx.rollback()

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "error publishing version",
        })
      }
    })

    // ingest the plan version to tinybird
    opts.ctx.waitUntil(
      Promise.all([
        opts.ctx.analytics.ingestPlanVersions({
          id: planVersionDataUpdated.id,
          project_id: planVersionDataUpdated.projectId,
          plan_id: planVersionDataUpdated.planId,
          plan_slug: planVersionData.plan.slug,
          plan_version: planVersionDataUpdated.version,
          currency: planVersionDataUpdated.currency,
          payment_provider: planVersionDataUpdated.paymentProvider,
          billing_interval: planVersionDataUpdated.billingConfig.billingInterval,
          billing_interval_count: planVersionDataUpdated.billingConfig.billingIntervalCount,
          billing_anchor: planVersionDataUpdated.billingConfig.billingAnchor.toString(),
          plan_type: planVersionDataUpdated.billingConfig.planType,
          trial_units: planVersionDataUpdated.trialUnits,
          payment_method_required: planVersionDataUpdated.paymentMethodRequired,
          timestamp: new Date(planVersionDataUpdated.publishedAt ?? Date.now()).toISOString(),
        }),

        // ingest the plan version features
        opts.ctx.analytics.ingestPlanVersionFeatures(
          planVersionData.planFeatures.map((feature) => ({
            id: feature.id,
            project_id: feature.projectId,
            plan_version_id: feature.planVersionId,
            feature_id: feature.id,
            feature_type: feature.featureType,
            config: JSON.stringify(feature.config),
            metadata: feature.metadata,
            aggregation_method: feature.aggregationMethod,
            default_quantity: feature.defaultQuantity,
            limit: feature.limit,
            timestamp: new Date(feature.createdAtM).toISOString(),
          }))
        ),
      ])
    )

    return {
      planVersion: planVersionDataUpdated,
    }
  })
