import { TRPCError } from "@trpc/server"
import { and, eq } from "@unprice/db"
import * as schema from "@unprice/db/schema"
import { planVersionSelectBaseSchema } from "@unprice/db/validators"
import { z } from "zod"

import { protectedProjectProcedure } from "#trpc"
import { featureGuard } from "#utils/feature-guard"

export const deactivate = protectedProjectProcedure
  .input(
    planVersionSelectBaseSchema
      .pick({
        id: true,
      })
      .required({ id: true })
  )
  .output(z.object({ planVersion: planVersionSelectBaseSchema }))
  .mutation(async (opts) => {
    const { id } = opts.input
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace
    // only owner and admin can deactivate a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const result = await featureGuard({
      customerId: workspace.unPriceCustomerId,
      featureSlug: "plans",
      isMain: workspace.isMain,
      metadata: {
        action: "deactivate",
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
    })

    if (!planVersionData?.id) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "version not found",
      })
    }

    if (planVersionData?.status !== "published") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "You can only deactivate a published version",
      })
    }

    if (!planVersionData.active) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Version is already deactivated",
      })
    }

    // if the current version is the latest, we need to deactivate it and set the latest to the previous version
    const deactivatedVersion = await opts.ctx.db.transaction(async (tx) => {
      try {
        let promise = undefined

        if (planVersionData.latest) {
          // get the previous latest published version
          const previousVersion = await tx.query.versions
            .findMany({
              where: (version, { and, eq }) =>
                and(
                  eq(version.projectId, project.id),
                  eq(version.planId, planVersionData.planId),
                  eq(version.status, "published"),
                  eq(version.latest, false),
                  eq(version.active, true)
                ),
              orderBy(fields, operators) {
                // get the latest published version
                return operators.desc(fields.publishedAt)
              },
            })
            .then((data) => data[0])

          if (previousVersion?.id) {
            promise = tx
              .update(schema.versions)
              .set({
                latest: true,
              })
              .where(
                and(
                  eq(schema.versions.projectId, project.id),
                  eq(schema.versions.id, previousVersion.id)
                )
              )
          }
        }

        // deactivate the current version, change the latest to false and update the updatedAtM
        // if the current version is the latest, we need to deactivate it and set the latest to the previous version
        const [planVersionDataDuplicated] = await Promise.all([
          tx
            .update(schema.versions)
            .set({
              active: false,
              latest: false,
              updatedAtM: Date.now(),
            })
            .where(and(eq(schema.versions.id, planVersionData.id)))
            .returning()
            .then((data) => data[0]),
          // update the previous version to be the latest only if the current version is the latest
          promise,
        ])

        return planVersionDataDuplicated
      } catch (error) {
        if (error instanceof Error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: error.message,
          })
        }
      }
    })

    if (!deactivatedVersion?.id) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error deactivating version",
      })
    }

    return {
      planVersion: deactivatedVersion,
    }
  })
