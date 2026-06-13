import { createRoute } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareEntitlementWindowClient } from "~/ingestion/entitlements/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["billing"]

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

const route = createRoute({
  path: "/v1/billing/reservations/flush-for-invoicing",
  operationId: "billing.reservations.flushForInvoicing",
  summary: "flush wallet reservation usage before invoicing",
  description:
    "Flushes unflushed consumed usage from active wallet reservations into the ledger for invoicing. Called by the billing service before invoice materialization.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(requestSchema, "Flush reservation request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(responseSchema, "Flush result"),
    ...openApiErrorResponses,
  },
})

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
      columns: { id: true },
    })
    const billingPeriodIds = billingPeriodRows.map((r) => r.id)

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

    if (phaseEntitlements.length === 0) {
      return c.json({ ok: true, flushed: 0, skipped: 0 }, HttpStatusCodes.OK)
    }

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

    return c.json({ ok: true, flushed, skipped }, HttpStatusCodes.OK)
  })
