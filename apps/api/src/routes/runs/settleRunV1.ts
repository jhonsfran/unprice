import { createRoute } from "@hono/zod-openapi"
import { newId } from "@unprice/db/utils"
import {
  applyRunSyncEventInputSchema,
  runSettlementDecisionSchema,
  toRunSummaryMinor,
} from "@unprice/db/validators"
import { fromLedgerMinor, toCurrencyMinor } from "@unprice/money"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import {
  IngestionEntitlementContextLoader,
  IngestionReportingDispatcher,
  IngestionRunEntitlementResolver,
  IngestionSubscriptionCatchUp,
} from "@unprice/services/ingestion"
import { RunUseCaseError, settleRun } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareReportingQueueClient } from "~/ingestion/reporting/client"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["runs"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/runs/settle/{runId}",
      operationId: "runs.settle",
      summary: "settle incurred usage against a run",
      description:
        "Record already-incurred usage without feature-limit enforcement and reconcile its cost against the run budget. The run remains open until runs.end.",
      method: "post",
      tags,
      request: {
        params: z.object({
          runId: z.string().min(1).openapi({
            description: "The run ID",
            example: "brun_123",
          }),
        }),
        body: jsonContentRequired(applyRunSyncEventInputSchema, "The incurred usage payload"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(runSettlementDecisionSchema, "The settlement decision"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["runs", "settle"] },
    }
  )
)

export const registerSettleRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { runId } = c.req.valid("param")
    const body = c.req.valid("json")
    const key = await keyAuth(c)
    const {
      budgetRuns,
      entitlement: entitlementService,
      subscription: subscriptionService,
    } = c.get("services")
    const logger = c.get("logger")
    const requestId = c.get("requestId")
    const receivedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? receivedAt

    try {
      validateEventTimestamp(timestamp, receivedAt)
    } catch (error) {
      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw new UnpriceApiError({ code: "BAD_REQUEST", message: error.message })
      }
      throw error
    }

    const entitlementContext = new IngestionEntitlementContextLoader({
      cache: c.get("cache"),
      db: c.get("db"),
      entitlementService,
      logger,
    })
    const entitlementResolver = new IngestionRunEntitlementResolver({
      entitlementContext,
      logger,
      subscriptionCatchUp: new IngestionSubscriptionCatchUp({
        logger,
        subscriptions: subscriptionService,
      }),
    })
    const reportingDispatcher = new IngestionReportingDispatcher({
      logger,
      now: () => Date.now(),
      reportingClient: new CloudflareReportingQueueClient(c.env),
    })
    const result = await settleRun(
      {
        services: { budgetRuns },
        runBudget: new CloudflareRunBudgetClient(c.env),
        entitlementResolver,
        reportingDispatcher,
      },
      {
        projectId: key.projectId,
        runId,
        keyCustomerId: key.defaultCustomerId ?? null,
        featureSlug: body.featureSlug,
        idempotencyKey: body.idempotencyKey,
        requestId,
        receivedAt,
        event: {
          id: body.id ?? newId("event"),
          slug: body.eventSlug ?? body.featureSlug,
          timestamp,
          properties: body.properties ?? {},
        },
        source: {
          workspaceId: key.project.workspaceId,
          environment: c.env.APP_ENV,
          apiKeyId: key.id,
          sourceType: "api_key",
          sourceId: key.id,
          sourceName: null,
        },
        now: Date.now(),
      }
    )

    if (result.err) {
      if (result.err instanceof RunUseCaseError && result.err.message === "RUN_NOT_FOUND") {
        throw new UnpriceApiError({ code: "NOT_FOUND", message: "Run not found" })
      }
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    const { fundedAmount, unfundedAmount, ...decision } = result.val
    return c.json(
      {
        ...decision,
        ...(fundedAmount === undefined
          ? {}
          : {
              fundedAmountMinor: toCurrencyMinor(
                fromLedgerMinor(fundedAmount, result.val.run.currency)
              ),
            }),
        ...(unfundedAmount === undefined
          ? {}
          : {
              unfundedAmountMinor: toCurrencyMinor(
                fromLedgerMinor(unfundedAmount, result.val.run.currency)
              ),
            }),
        run: toRunSummaryMinor(result.val.run),
      },
      HttpStatusCodes.OK
    )
  })
