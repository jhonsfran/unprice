import { TRPCError } from "@trpc/server"
import { planVersionSelectBaseSchema, versionInsertBaseSchema } from "@unprice/db/validators"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const create = protectedProjectProcedure
  .input(versionInsertBaseSchema)
  .output(
    z.object({
      planVersion: planVersionSelectBaseSchema,
    })
  )
  .mutation(async (opts) => {
    const {
      planId,
      metadata,
      description,
      currency,
      billingConfig,
      gracePeriod,
      title,
      tags,
      whenToBill,
      status,
      paymentProvider,
      trialUnits,
      autoRenew,
      collectionMethod,
      dueBehaviour,
      paymentMethodRequired,
    } = opts.input
    const project = opts.ctx.project
    const { plans } = opts.ctx.services

    // only owner and admin can create a plan version
    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await plans.createPlanVersionRecord({
      projectId: project.id,
      planId,
      metadata: metadata ?? null,
      description,
      currency,
      billingConfig: {
        ...billingConfig,
        billingAnchor: billingConfig.billingAnchor ?? "dayOfCreation",
      },
      gracePeriod: gracePeriod ?? 0,
      title,
      tags: tags ?? [],
      whenToBill,
      status: status ?? null,
      paymentProvider,
      trialUnits: trialUnits ?? 0,
      autoRenew,
      collectionMethod: collectionMethod ?? "charge_automatically",
      dueBehaviour: dueBehaviour ?? "cancel",
      paymentMethodRequired,
    })

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "plan_not_found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "plan not found",
      })
    }

    return {
      planVersion: val.planVersion,
    }
  })
