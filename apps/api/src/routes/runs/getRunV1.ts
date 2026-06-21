import { createRoute } from "@hono/zod-openapi"
import { runSummarySchema } from "@unprice/db/validators"
import { fromLedgerMinor, toCurrencyMinor } from "@unprice/money"
import { RunUseCaseError, getRun } from "@unprice/services/use-cases"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { CloudflareRunBudgetClient } from "~/ingestion/run-budget/client"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["runs"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/runs/get/{runId}",
      operationId: "runs.get",
      summary: "get a budgeted run",
      description: "Get the current status and budget of a run",
      method: "get",
      tags,
      request: {
        params: z.object({
          runId: z.string().min(1).openapi({
            description: "The run ID",
            example: "brun_123",
          }),
        }),
        query: z.object({
          project_id: z
            .string()
            .optional()
            .openapi({ description: "Project override for main/internal dashboard keys" }),
        }),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(runSummarySchema, "The current budget run summary"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["runs", "get"],
      },
    }
  )
)

export const registerGetRunV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { runId } = c.req.valid("param")
    const { project_id: requestedProjectId } = c.req.valid("query")
    const key = await keyAuth(c)
    const projectId = validateIsAllowedToAccessProject({
      isMain: (key.project.isMain ?? false) || key.project.workspace.isMain,
      key,
      requestedProjectId: requestedProjectId ?? key.projectId,
    })

    const { budgetRuns } = c.get("services")
    const runBudget = new CloudflareRunBudgetClient(c.env)

    const result = await getRun(
      { services: { budgetRuns }, runBudget },
      {
        projectId,
        runId,
        keyCustomerId: key.defaultCustomerId ?? null,
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

    const { currency } = result.val
    return c.json(
      {
        ...result.val,
        budgetAmount: toCurrencyMinor(fromLedgerMinor(result.val.budgetAmount, currency)),
        consumedAmount: toCurrencyMinor(fromLedgerMinor(result.val.consumedAmount, currency)),
        remainingAmount: toCurrencyMinor(fromLedgerMinor(result.val.remainingAmount, currency)),
      },
      HttpStatusCodes.OK
    )
  })
