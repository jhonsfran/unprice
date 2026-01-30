import { TRPCError } from "@trpc/server"
import { and, eq, sql } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import * as utils from "@unprice/db/utils"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"
import { reportUsageFeature } from "#utils/shared"

export const duplicate = protectedProjectProcedure
  .input(
    z.object({
      id: z.string(),
    })
  )
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace

    // only owner and admin can duplicate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: "plans",
      isMain: workspace.isMain,
      metadata: {
        action: "duplicate",
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
      where: (version, { and, eq }) => and(eq(version.id, id), eq(version.projectId, project.id)),
      with: {
        planFeatures: true,
        plan: true,
      },
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    // default plan shouldn't have a required payment method
    if (planVersionData.plan.defaultPlan && planVersionData.paymentMethodRequired) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "default plan can't have a required payment method",
      })
    }

    const planVersionId = utils.newId("plan_version")

    // this should happen in a transaction because we need to create every feature version
    const duplicatedVersion = await opts.ctx.db.transaction(async (tx) => {
      try {
        // get the count of versions for this plan
        const countVersionsPlan = await tx
          .select({ count: sql<number>`count(*)` })
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.projectId, project.id),
              eq(schema.versions.planId, planVersionData.planId)
            )
          )
          .then((res) => res[0]?.count ?? 0)

        // duplicate the plan version
        const planVersionDataDuplicated = await tx
          .insert(schema.versions)
          .values({
            ...planVersionData,
            id: planVersionId,
            trialUnits: planVersionData.trialUnits,
            billingConfig: planVersionData.billingConfig,
            autoRenew: planVersionData.autoRenew,
            paymentMethodRequired: planVersionData.paymentMethodRequired,
            metadata: {
              // external Id shouldn't be duplicated
            },
            latest: false,
            active: true,
            status: "draft",
            createdAtM: Date.now(),
            updatedAtM: Date.now(),
            version: Number(countVersionsPlan) + 1,
          })
          .returning()
          .catch((err) => {
            opts.ctx.logger.error(err.message)
            tx.rollback()
            throw err
          })
          .then((re) => re[0])

        if (!planVersionDataDuplicated?.id) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "error creating version",
          })
        }

        // duplicate the plan version features
        await Promise.all(
          planVersionData.planFeatures.map(async (feature) => {
            const planVersionFeatureId = utils.newId("feature_version")

            try {
              await tx
                .insert(schema.planVersionFeatures)
                .values({
                  ...feature,
                  id: planVersionFeatureId,
                  planVersionId: planVersionId,
                  metadata: feature.metadata,
                  createdAtM: Date.now(),
                  updatedAtM: Date.now(),
                })
                .returning()
            } catch (err) {
              console.error(err)
              tx.rollback()
              throw err
            }
          })
        )

        return planVersionDataDuplicated
      } catch (error) {
        if (error instanceof Error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          })
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "error creating version",
        })
      }
    })

    if (!duplicatedVersion) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error duplicating version",
      })
    }

    // avoid reporting usage for flat features
    if (result.featureType !== "flat") {
      opts.ctx.waitUntil(
        // report usage
        reportUsageFeature({
          customerId: workspace.unPriceCustomerId,
          featureSlug: "plans",
          usage: 1,
          isMain: workspace.isMain,
          metadata: {
            action: "duplicate",
            module: "planVersion",
          },
        })
      )
    }

    return {
      planVersion: duplicatedVersion,
    }
  })
