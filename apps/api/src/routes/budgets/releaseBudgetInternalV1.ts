import { createRoute } from "@hono/zod-openapi"
import {
  budgetReleaseRejectionSchema,
  releaseBudgetInternalInputSchema,
  releaseBudgetResponseSchema,
} from "@unprice/db/validators"
import { UnPriceBudgetError } from "@unprice/services/budgets"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { runBudgetVerb, toWire } from "./budget-verb"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/budgets/release",
      operationId: "budgets.internalRelease",
      summary: "release a hold for the dashboard",
      description:
        "Runs the release command for an operator who confirmed the work used nothing. Called by the dashboard with a main-project key, for any project. A 404 or 409 carries the budget's rejection in `details`.",
      method: "post",
      hide: true,
      tags: ["budgets"],
      request: {
        body: jsonContentRequired(releaseBudgetInternalInputSchema, "The budget and the hold"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(releaseBudgetResponseSchema, "The release"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "operations",
      docs: { expose: false },
      sdk: false,
    }
  )
)

export const registerReleaseBudgetInternalV1 = (app: App) =>
  app.openapi(route, async (c) => {
    // `internalKeyAuth` admits only main and internal keys, so the project comes from the body.
    const { projectId, key, holdId, holdCreatedAt } = c.req.valid("json")
    const { type: _, ...released } = await runBudgetVerb(
      c,
      key,
      { type: "release", holdId, holdCreatedAt },
      { projectId }
    ).catch(withRejection)
    return c.json(toWire(released), HttpStatusCodes.OK)
  })

/** Puts the budget's rejection in the details of a 404 or 409 that the public route flattens. */
function withRejection(error: unknown): never {
  if (!(error instanceof UnpriceApiError) || !(error.cause instanceof UnPriceBudgetError)) {
    throw error
  }
  const rejection = budgetReleaseRejectionSchema.safeParse(error.cause.rejection)
  if (!rejection.success) throw error
  throw new UnpriceApiError({
    code: error.code,
    message: error.message,
    details: { kind: "release_rejected", rejection: rejection.data },
  })
}
