import { createRoute } from "@hono/zod-openapi"
import { buildRunBudgetName } from "@unprice/services/ingestion"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["billingReservations"]

const requestSchema = z.object({
  customerId: z.string().openapi({ description: "Customer id", example: "cus_123" }),
  subscriptionId: z.string().openapi({ description: "Subscription id", example: "sub_123" }),
  subscriptionPhaseId: z
    .string()
    .openapi({ description: "Subscription phase id", example: "phase_123" }),
  statementKey: z.string().openapi({ description: "Statement key for the billing period" }),
})

const responseSchema = z.object({
  ok: z.boolean(),
  flushed: z.number(),
  skipped: z.number(),
})

export type FlushReservationsForInvoicingRequest = z.infer<typeof requestSchema>
export type FlushReservationsForInvoicingResponse = z.infer<typeof responseSchema>

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/billing-reservations/flush-for-invoicing",
      operationId: "billingReservations.flushForInvoicing",
      summary: "flush wallet reservation usage before invoicing",
      description:
        "Flushes unflushed consumed usage from active wallet reservations into the ledger for invoicing. Called by the billing service before invoice materialization.",
      method: "post",
      hide: true,
      tags,
      request: {
        body: jsonContentRequired(requestSchema, "Flush reservation request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(responseSchema, "Flush result"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)

export const registerFlushReservationsForInvoicingV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, subscriptionId, subscriptionPhaseId, statementKey } = c.req.valid("json")
    const key = await keyAuth(c)
    const projectId = key.projectId

    const { entitlement } = c.get("services")
    const db = c.get("db")

    // Query billing periods for this statement to get their IDs
    const billingPeriodRows = await db.query.billingPeriods.findMany({
      where: (table, { and: andOp, eq: eqOp }) =>
        andOp(
          eqOp(table.projectId, projectId),
          eqOp(table.customerId, customerId),
          eqOp(table.subscriptionId, subscriptionId),
          eqOp(table.statementKey, statementKey)
        ),
      columns: { cycleStartAt: true, id: true },
    })
    const billingPeriodIds = billingPeriodRows.map((r) => r.id)
    const earliestCycleStartAt =
      billingPeriodRows.length > 0
        ? Math.min(...billingPeriodRows.map((period) => period.cycleStartAt))
        : null

    // Find active customer entitlements for this subscription phase
    const entitlementsResult = await entitlement.getCustomerEntitlementsForCustomer({
      customerId,
      projectId,
      now: Date.now(),
      db,
    })

    if (entitlementsResult.err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to resolve customer entitlements: ${entitlementsResult.err.message}`,
      })
    }

    // Filter to entitlements owned by this subscription phase
    const phaseEntitlements = entitlementsResult.val.filter(
      (e) => e.subscriptionId === subscriptionId && e.subscriptionPhaseId === subscriptionPhaseId
    )

    const windowClient = new CloudflareEntitlementWindowClient({
      APP_ENV: c.env.APP_ENV,
      entitlementwindow: c.env.entitlementwindow,
    })

    let flushed = 0
    let skipped = 0

    for (const ent of phaseEntitlements) {
      const stub = windowClient.getEntitlementWindowStub({
        customerEntitlementId: ent.id,
        customerId,
        projectId,
      })

      // Check if the DO supports invoicing flush (optional RPC)
      if (!stub.flushReservationForInvoicing) {
        skipped++
        continue
      }

      const result = await stub.flushReservationForInvoicing({
        statementKey,
        billingPeriodIds,
      })

      if (result.ok) {
        if (result.outcome === "flushed") {
          flushed++
        } else {
          skipped++
        }
      } else {
        // Map retriable failures to appropriate HTTP codes
        if (result.outcome === "deferred") {
          throw new UnpriceApiError({
            code: "CONFLICT",
            message: result.errorMessage ?? "Reservation flush deferred, retry later",
          })
        }
        if (result.outcome === "recovery_required" || result.outcome === "wallet_error") {
          throw new UnpriceApiError({
            code: "INTERNAL_SERVER_ERROR",
            message: result.errorMessage ?? `Reservation flush failed: ${result.outcome}`,
          })
        }
        // statement_mismatch is not retriable but not fatal for the batch
        skipped++
      }
    }

    const budgetRunRows =
      earliestCycleStartAt === null
        ? []
        : await db.query.budgetRuns.findMany({
            where: (table, { and: andOp, eq: eqOp, gt: gtOp, gte: gteOp, ne: neOp }) =>
              andOp(
                eqOp(table.projectId, projectId),
                eqOp(table.customerId, customerId),
                neOp(table.status, "failed"),
                gtOp(table.consumedAmount, 0),
                gteOp(table.updatedAt, new Date(earliestCycleStartAt))
              ),
            columns: { id: true },
          })

    for (const run of budgetRunRows) {
      const stub = c.env.runbudget.getByName(
        buildRunBudgetName({
          appEnv: c.env.APP_ENV,
          projectId,
          customerId,
          runId: run.id,
        })
      ) as {
        flushCapturesForInvoicing?: (input: {
          statementKey: string
          billingPeriodIds: string[]
        }) => Promise<{ ok: true; flushed: number; skipped: number }>
      }

      if (!stub.flushCapturesForInvoicing) {
        skipped++
        continue
      }

      try {
        const result = await stub.flushCapturesForInvoicing({
          statementKey,
          billingPeriodIds,
        })
        flushed += result.flushed
        skipped += result.skipped
      } catch (error) {
        throw new UnpriceApiError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? `Run budget reservation flush failed: ${error.message}`
              : "Run budget reservation flush failed",
        })
      }
    }

    return c.json({ ok: true, flushed, skipped }, HttpStatusCodes.OK)
  })
