import { TRPCError } from "@trpc/server"
import {
  appliedPlanTemplateSchema,
  applyPlanTemplate,
  applyPlanTemplateRequestSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const applyTemplate = protectedProjectProcedure
  .input(applyPlanTemplateRequestSchema)
  .output(
    z.object({
      planVersionId: z.string(),
      appliedTemplates: z.array(appliedPlanTemplateSchema),
    })
  )
  .mutation(async (opts) => {
    const project = opts.ctx.project
    const workspace = opts.ctx.project.workspace

    opts.ctx.verifyRole(["OWNER", "ADMIN"])

    const { err, val } = await applyPlanTemplate(
      {
        services: opts.ctx.services,
        db: opts.ctx.db,
        logger: opts.ctx.logger,
        userId: opts.ctx.userId,
      },
      {
        ...opts.input,
        projectId: project.id,
        workspaceUnPriceCustomerId: workspace.unPriceCustomerId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (val.state === "payment_provider_error") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error validating payment provider",
      })
    }

    if (val.state === "usage_meter_config_required" || val.state === "invalid_reset_config") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Template contains invalid usage feature configuration",
      })
    }

    if (val.state !== "ok") {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Error applying plan template",
      })
    }

    return {
      planVersionId: val.primaryPlanVersionId,
      appliedTemplates: val.appliedTemplates,
    }
  })
