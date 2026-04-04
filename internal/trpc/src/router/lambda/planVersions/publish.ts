import { and, eq, inArray } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { calculateFlatPricePlan, planVersionSelectBaseSchema } from "@unprice/db/validators"
import { isZero } from "dinero.js"
import { z } from "zod"

import { TRPCError } from "@trpc/server"
import { protectedProjectProcedure } from "#trpc"


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
      const { customers } = opts.ctx.services

      const { err: validatePaymentMethodErr } = await customers.getPaymentProvider({
        customerId: workspace.unPriceCustomerId,
        projectId: project.id,
        provider: planVersionData.paymentProvider,
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

    return {
      planVersion: planVersionDataUpdated,
    }
  })
