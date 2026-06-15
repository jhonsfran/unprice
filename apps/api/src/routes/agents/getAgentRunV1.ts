import { createRoute } from "@hono/zod-openapi"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const runBudgetSummaryResponseSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "completed", "expired", "canceled", "budget_exceeded", "failed"]),
  budgetAmount: z.number().int().nonnegative(),
  consumedAmount: z.number().int().nonnegative(),
  remainingAmount: z.number().int().nonnegative(),
})

export const route = createRoute({
  path: "/v1/agents/{agentId}/runs/{runId}",
  operationId: "agents.runs.get",
  summary: "get agent run status",
  description: "Get the current budget status of an agent run",
  method: "get",
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
    query: z.object({
      customerId: z.string().min(1).openapi({
        description: "The customer ID",
        example: "cus_123",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(runBudgetSummaryResponseSchema, "The current budget summary"),
    ...openApiErrorResponses,
  },
})

export const registerGetAgentRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { agentId, runId } = c.req.valid("param")
    const { customerId } = c.req.valid("query")
    const { agents } = c.get("services")

    const key = await keyAuth(c)
    const projectId = key.projectId

    // Verify agent/run ownership
    const run = await agents.getRunForAgent({
      agentId,
      customerId,
      projectId,
      runId,
    })

    if (!run) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Agent run not found",
      })
    }

    const runBudget = new CloudflareRunBudgetClient(c.env)

    const summary = await runBudget.getRunStatus({
      agentId,
      customerId,
      projectId,
      runId,
    })

    return c.json(summary, HttpStatusCodes.OK)
  })
