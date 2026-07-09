import type { Database } from "@unprice/db"
import { BaseError, Err, Ok, type Result } from "@unprice/error"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { EntitlementWindowController } from "../../ingestion"
import type { RunBudgetClient } from "../runs"

export const flushReservationsForInvoicingInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
  statementKey: z.string(),
  subscriptionId: z.string(),
  subscriptionPhaseId: z.string(),
})

export const flushReservationsForInvoicingOutputSchema = z.object({
  flushed: z.number().int().min(0),
  skipped: z.number().int().min(0),
})

export const flushReservationsForInvoicingErrorReasonSchema = z.enum([
  "deferred",
  "entitlements_unavailable",
  "flush_failed",
])

export type FlushReservationsForInvoicingInput = z.infer<
  typeof flushReservationsForInvoicingInputSchema
>
export type FlushReservationsForInvoicingOutput = z.infer<
  typeof flushReservationsForInvoicingOutputSchema
>
export type FlushReservationsForInvoicingErrorReason = z.infer<
  typeof flushReservationsForInvoicingErrorReasonSchema
>

export type InvoicingEntitlementWindowClient = {
  getEntitlementWindowStub(params: {
    customerEntitlementId: string
    customerId: string
    projectId: string
  }): Pick<EntitlementWindowController, "flushReservationForInvoicing">
}

export type FlushReservationsForInvoicingDeps = {
  db: Database
  entitlementWindowClient: InvoicingEntitlementWindowClient
  runBudgetClient: Pick<RunBudgetClient, "flushCapturesForInvoicing">
  services: {
    entitlements: Pick<ServiceContext["entitlements"], "getCustomerEntitlementsForCustomer">
  }
}

export class FlushReservationsForInvoicingError extends BaseError<{
  reason: FlushReservationsForInvoicingErrorReason
}> {
  public override readonly name = "FlushReservationsForInvoicingError"
  public readonly retry = true
  public readonly reason: FlushReservationsForInvoicingErrorReason

  constructor(params: {
    message: string
    reason: FlushReservationsForInvoicingErrorReason
    cause?: BaseError
  }) {
    super({
      message: params.message,
      cause: params.cause,
      context: { reason: params.reason },
    })
    this.reason = params.reason
  }
}

export async function flushReservationsForInvoicing(
  deps: FlushReservationsForInvoicingDeps,
  rawInput: FlushReservationsForInvoicingInput
): Promise<Result<FlushReservationsForInvoicingOutput, FlushReservationsForInvoicingError>> {
  const input = flushReservationsForInvoicingInputSchema.parse(rawInput)

  const billingPeriodRows = await deps.db.query.billingPeriods.findMany({
    where: (table, { and: andOp, eq: eqOp }) =>
      andOp(
        eqOp(table.projectId, input.projectId),
        eqOp(table.customerId, input.customerId),
        eqOp(table.subscriptionId, input.subscriptionId),
        eqOp(table.statementKey, input.statementKey)
      ),
    columns: { cycleStartAt: true, id: true },
  })
  const billingPeriodIds = billingPeriodRows.map((row) => row.id)
  const earliestCycleStartAt =
    billingPeriodRows.length === 0
      ? null
      : Math.min(...billingPeriodRows.map((period) => period.cycleStartAt))

  const entitlementsResult = await deps.services.entitlements.getCustomerEntitlementsForCustomer({
    customerId: input.customerId,
    projectId: input.projectId,
    now: Date.now(),
    db: deps.db,
  })

  if (entitlementsResult.err) {
    return Err(
      new FlushReservationsForInvoicingError({
        reason: "entitlements_unavailable",
        message: `Failed to resolve customer entitlements: ${entitlementsResult.err.message}`,
        cause: entitlementsResult.err,
      })
    )
  }

  const phaseEntitlements = entitlementsResult.val.filter(
    (entitlement) =>
      entitlement.subscriptionId === input.subscriptionId &&
      entitlement.subscriptionPhaseId === input.subscriptionPhaseId
  )

  let flushed = 0
  let skipped = 0

  for (const entitlement of phaseEntitlements) {
    const stub = deps.entitlementWindowClient.getEntitlementWindowStub({
      customerEntitlementId: entitlement.id,
      customerId: input.customerId,
      projectId: input.projectId,
    })

    if (!stub.flushReservationForInvoicing) {
      skipped++
      continue
    }

    const result = await stub.flushReservationForInvoicing({
      statementKey: input.statementKey,
      billingPeriodIds,
    })

    switch (result.outcome) {
      case "flushed":
        if (!result.ok) {
          return Err(inconsistentSuccessfulFlushResult(result.outcome))
        }
        flushed++
        break
      case "no_reservation":
      case "no_unflushed_usage":
        if (!result.ok) {
          return Err(inconsistentSuccessfulFlushResult(result.outcome))
        }
        skipped++
        break
      case "statement_mismatch":
        skipped++
        break
      case "deferred":
        return Err(
          new FlushReservationsForInvoicingError({
            reason: "deferred",
            message: result.errorMessage ?? "Reservation flush deferred, retry later",
          })
        )
      case "recovery_required":
      case "wallet_error":
        return Err(
          new FlushReservationsForInvoicingError({
            reason: "flush_failed",
            message: result.errorMessage ?? `Reservation flush failed: ${result.outcome}`,
          })
        )
      default:
        assertNever(result.outcome)
    }
  }

  const budgetRunRows =
    earliestCycleStartAt === null
      ? []
      : await deps.db.query.budgetRuns.findMany({
          where: (table, { and: andOp, eq: eqOp, gt: gtOp, gte: gteOp, ne: neOp }) =>
            andOp(
              eqOp(table.projectId, input.projectId),
              eqOp(table.customerId, input.customerId),
              neOp(table.status, "failed"),
              gtOp(table.consumedAmount, 0),
              gteOp(table.updatedAt, new Date(earliestCycleStartAt))
            ),
          columns: { id: true },
        })

  for (const run of budgetRunRows) {
    const result = await deps.runBudgetClient.flushCapturesForInvoicing({
      projectId: input.projectId,
      customerId: input.customerId,
      runId: run.id,
      statementKey: input.statementKey,
      billingPeriodIds,
    })

    if (result.err) {
      return Err(
        new FlushReservationsForInvoicingError({
          reason: "flush_failed",
          message: `Run budget reservation flush failed: ${result.err.message}`,
          cause: result.err,
        })
      )
    }

    flushed += result.val.flushed
    skipped += result.val.skipped
  }

  return Ok(flushReservationsForInvoicingOutputSchema.parse({ flushed, skipped }))
}

function inconsistentSuccessfulFlushResult(
  outcome: "flushed" | "no_reservation" | "no_unflushed_usage"
): FlushReservationsForInvoicingError {
  return new FlushReservationsForInvoicingError({
    reason: "flush_failed",
    message: `Reservation flush returned inconsistent result: ${outcome} with ok=false`,
  })
}

function assertNever(value: never): never {
  throw new Error(`Unexpected reservation flush outcome: ${String(value)}`)
}
