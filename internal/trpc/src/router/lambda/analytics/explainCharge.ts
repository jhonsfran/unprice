import { TRPCError } from "@trpc/server"
import {
  ExplainChargeError,
  explainChargeOutputSchema,
  explainCharge as explainChargeUseCase,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const explainCharge = protectedProjectProcedure
  .input(
    z.object({
      invoiceId: z.string(),
      entryId: z.string(),
      limit: z.number().int().min(1).max(500).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
    })
  )
  .output(explainChargeOutputSchema)
  .query(async (opts) => {
    const result = await explainChargeUseCase(
      {
        db: opts.ctx.db,
        ledger: opts.ctx.services.ledger,
        analytics: opts.ctx.analytics,
      },
      {
        projectId: opts.ctx.project.id,
        invoiceId: opts.input.invoiceId,
        entryId: opts.input.entryId,
        limit: opts.input.limit,
        offset: opts.input.offset,
      }
    )

    if (result.err) {
      throw explainChargeErrorToTrpcError(result.err)
    }

    return result.val
  })

function explainChargeErrorToTrpcError(error: unknown): TRPCError {
  if (error instanceof ExplainChargeError) {
    switch (error.code) {
      case "INVOICE_NOT_FOUND":
      case "LEDGER_LINE_NOT_FOUND":
      case "BILLING_PERIOD_NOT_FOUND":
      case "FEATURE_NOT_FOUND":
        return new TRPCError({ code: "NOT_FOUND", message: error.message })
      case "BILLING_PERIOD_CONTEXT_MISMATCH":
      case "BILLING_PERIOD_METADATA_MISSING":
      case "PERIOD_KEY_NOT_DERIVED":
        return new TRPCError({ code: "BAD_REQUEST", message: error.message })
    }
  }

  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "Failed to explain charge",
  })
}
