import { createRoute } from "@hono/zod-openapi"
import { applyRunSyncEventInputSchema, runSyncDecisionSchema } from "@unprice/db/validators"
import { RunUseCaseError, applyRunSyncEvent } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["runs"]

export const route = createRoute({
  path: "/v1/runs/{runId}/events/sync",
  operationId: "runs.events.sync",
  summary: "apply sync metered event to a run",
  description: "Apply a synchronous metered event to a running budget run",
  method: "post",
  tags,
  request: {
    params: z.object({
      runId: z.string().min(1).openapi({
        description: "The run ID",
        example: "brun_123",
      }),
    }),
    body: jsonContentRequired(applyRunSyncEventInputSchema, "The sync event payload"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(runSyncDecisionSchema, "The sync event decision"),
    ...openApiErrorResponses,
  },
})

export const registerApplyRunSyncEventV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { runId } = c.req.valid("param")
    const body = c.req.valid("json")
    const key = await keyAuth(c)

    const { budgetRuns } = c.get("services")
    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await applyRunSyncEvent(
      { services: { budgetRuns }, runBudget },
      {
        projectId: key.projectId,
        runId,
        keyCustomerId: key.defaultCustomerId ?? null,
        featureSlug: body.featureSlug,
        idempotencyKey: body.idempotencyKey,
        event: {
          id: body.id ?? `evt_${Date.now()}`,
          slug: body.eventSlug ?? body.featureSlug,
          timestamp: body.timestamp ?? Date.now(),
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
        throw new UnpriceApiError({
          code: "NOT_FOUND",
          message: "Run not found",
        })
      }

      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
