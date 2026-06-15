import { createRoute } from "@hono/zod-openapi"
import { AgentRunUseCaseError, endAgentRun } from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const endAgentRunBodySchema = z.object({
  customerId: z.string().min(1).openapi({
    description: "The customer ID",
    example: "cus_123",
  }),
  status: z.enum(["completed", "expired", "canceled"]).default("completed").openapi({
    description: "The ending status for the run",
    example: "completed",
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
  path: "/v1/agents/{agentId}/runs/{runId}/end",
  operationId: "agents.runs.end",
  summary: "end agent run",
  description: "End an agent run with a terminal status",
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
    body: jsonContentRequired(endAgentRunBodySchema, "The end run payload"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(runBudgetSummaryResponseSchema, "The final budget summary"),
    ...openApiErrorResponses,
  },
})

export const registerEndAgentRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { agentId, runId } = c.req.valid("param")
    const body = c.req.valid("json")
    const { agents } = c.get("services")

    const key = await keyAuth(c)
    const projectId = key.projectId

    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await endAgentRun(
      { services: { agents }, runBudget },
      {
        agentId,
        runId,
        customerId: body.customerId,
        projectId,
        status: body.status,
        endedAt: new Date(),
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
