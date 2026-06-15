import { createRoute } from "@hono/zod-openapi"
import { AgentRunUseCaseError, applyAgentRunSyncEvent } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const applyEventBodySchema = z.object({
  customerId: z.string().min(1).openapi({
    description: "The customer ID",
    example: "cus_123",
  }),
  featureSlug: z.string().min(1).openapi({
    description: "The feature slug to apply the event against",
    example: "tokens",
  }),
  idempotencyKey: z.string().min(1).openapi({
    description: "Idempotency key for this event",
    example: "idem_event_abc",
  }),
  id: z.string().min(1).openapi({
    description: "Unique event ID",
    example: "evt_123",
  }),
  eventSlug: z.string().min(1).openapi({
    description: "The event slug/type",
    example: "token_usage",
  }),
  timestamp: z.number().finite().openapi({
    description: "Event timestamp in milliseconds",
    example: 1700000000000,
  }),
  properties: z.record(z.unknown()).openapi({
    description: "Event properties",
    example: { tokens: 100 },
  }),
})

const runBudgetSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "completed", "expired", "canceled", "budget_exceeded", "failed"]),
  budgetAmount: z.number().int().nonnegative(),
  consumedAmount: z.number().int().nonnegative(),
  remainingAmount: z.number().int().nonnegative(),
})

const runBudgetDecisionResponseSchema = z.object({
  allowed: z.boolean(),
  state: z.enum(["processed", "rejected"]),
  rejectionReason: z
    .enum(["LIMIT_EXCEEDED", "WALLET_EMPTY", "LATE_EVENT_CLOSED_PERIOD", "RUN_BUDGET_EXCEEDED"])
    .optional(),
  message: z.string().optional(),
  budget: runBudgetSummarySchema,
})

export const route = createRoute({
  path: "/v1/agents/{agentId}/runs/{runId}/events/sync",
  operationId: "agents.runs.ingestSync",
  summary: "apply sync event to agent run",
  description: "Apply a synchronous event to an agent run and get an immediate budget decision",
  method: "post",
  tags,
  request: {
    params: z.object({
      agentId: z.string().min(1).openapi({
        description: "The agent ID",
        example: "agent_123",
      }),
      runId: z.string().min(1).openapi({
        description: "The run ID",
        example: "run_123",
      }),
    }),
    body: jsonContentRequired(applyEventBodySchema, "The event to apply"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      runBudgetDecisionResponseSchema,
      "The synchronous budget decision"
    ),
    ...openApiErrorResponses,
  },
})

export const registerApplyAgentRunSyncEventV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { agentId, runId } = c.req.valid("param")
    const body = c.req.valid("json")
    const { agents } = c.get("services")

    const key = await keyAuth(c)
    const projectId = key.projectId
    const workspaceId = key.project.workspaceId

    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await applyAgentRunSyncEvent(
      { services: { agents }, runBudget },
      {
        agentId,
        runId,
        customerId: body.customerId,
        projectId,
        featureSlug: body.featureSlug,
        idempotencyKey: body.idempotencyKey,
        event: {
          id: body.id,
          slug: body.eventSlug,
          timestamp: body.timestamp,
          properties: body.properties,
        },
        source: {
          workspaceId,
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
      if (result.err instanceof AgentRunUseCaseError && result.err.message === "RUN_NOT_FOUND") {
        throw new UnpriceApiError({
          code: "NOT_FOUND",
          message: "Agent run not found",
        })
      }

      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
