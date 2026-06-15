import { createRoute } from "@hono/zod-openapi"
import { AgentRunUseCaseError, startAgentRun } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const startAgentRunBodySchema = z.object({
  customerId: z.string().min(1).openapi({
    description: "The customer ID to associate with this run",
    example: "cus_123",
  }),
  currency: z.string().length(3).openapi({
    description: "ISO 4217 currency code",
    example: "usd",
  }),
  budgetAmount: z.number().int().positive().openapi({
    description: "The budget amount in smallest currency unit",
    example: 1000,
  }),
  idempotencyKey: z.string().min(1).openapi({
    description: "Idempotency key for this operation",
    example: "idem_abc123",
  }),
  traceId: z.string().min(1).nullable().optional().openapi({
    description: "Optional trace ID for distributed tracing",
  }),
  metadata: z.record(z.unknown()).default({}).openapi({
    description: "Arbitrary metadata to attach to the run",
  }),
  expiresAt: z.number().finite().nullable().optional().openapi({
    description: "Optional expiration timestamp in milliseconds",
  }),
})

const runBudgetSummaryResponseSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "completed", "expired", "canceled", "budget_exceeded", "failed"]),
  budgetAmount: z.number().int().nonnegative(),
  consumedAmount: z.number().int().nonnegative(),
  remainingAmount: z.number().int().nonnegative(),
})

export const route = createRoute({
  path: "/v1/agents/{agentId}/runs",
  operationId: "agents.runs.start",
  summary: "start agent run",
  description: "Start a new agent run with a budget",
  method: "post",
  tags,
  request: {
    params: z.object({
      agentId: z.string().min(1).openapi({
        description: "The agent ID",
        example: "agent_123",
      }),
    }),
    body: jsonContentRequired(startAgentRunBodySchema, "The run configuration"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      runBudgetSummaryResponseSchema,
      "The budget summary for the started run"
    ),
    ...openApiErrorResponses,
  },
})

export const registerStartAgentRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { agentId } = c.req.valid("param")
    const body = c.req.valid("json")
    const { agents } = c.get("services")

    const key = await keyAuth(c)
    const projectId = key.projectId

    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await startAgentRun(
      { services: { agents }, runBudget },
      {
        agentId,
        customerId: body.customerId,
        projectId,
        currency: body.currency,
        budgetAmount: body.budgetAmount,
        idempotencyKey: body.idempotencyKey,
        traceId: body.traceId,
        metadata: body.metadata ?? {},
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      }
    )

    if (result.err) {
      if (result.err instanceof AgentRunUseCaseError && result.err.message === "AGENT_NOT_FOUND") {
        throw new UnpriceApiError({
          code: "NOT_FOUND",
          message: "Agent not found",
        })
      }

      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
