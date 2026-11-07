import { createRoute } from "@hono/zod-openapi"
import {
  OPERATION_RETENTION_MS,
  describeDuration,
  settleBudgetInputSchema,
  settleBudgetResponseSchema,
} from "@unprice/db/validators"
import { amountUsage } from "@unprice/services/budgets"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { amountToWire, balanceToWire, runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/settle",
      operationId: "budgets.settle",
      summary: "settle a hold with the actual amount",
      description: `Settle final usage after work has stopped and release the unused reservation. Actual usage must not exceed the authorized amount. A larger amount returns 409 and leaves the reservation unchanged. Expired open holds still settle against their reservation. The hold id is the idempotency key: the same amount replays, another amount returns 409. A hold retires ${describeDuration(OPERATION_RETENTION_MS)} after it closes; settling or releasing it after that returns 409.`,
      method: "post",
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(settleBudgetInputSchema, "The settle request"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(settleBudgetResponseSchema, "The settlement"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "settle"] },
    }
  )
)

export const registerSettleBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { key, holdId, amount } = c.req.valid("json")
    const {
      type: _,
      actual,
      released,
      balance,
      ...settled
    } = await runBudgetVerb(c, key, { type: "settle", holdId, actual: amountUsage(amount) })
    return c.json(
      {
        ...toWire(settled),
        actual: amountToWire(actual),
        released: amountToWire(released),
        balance: balanceToWire(balance),
      },
      HttpStatusCodes.OK
    )
  })
