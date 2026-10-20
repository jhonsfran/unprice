import { createRoute } from "@hono/zod-openapi"
import { modelCatalogQuerySchema, modelCatalogResponseSchema } from "@unprice/db/validators"
import { MODEL_CATALOG_VERSION, modelRatesFor } from "@unprice/services/budgets"
import { jsonContent } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/budgets/models",
      operationId: "budgets.models",
      summary: "token rates and limits of models",
      description:
        "The catalog Unprice prices model steps with: token rates in USD per million tokens and the context and output limits of each model, by provider/model id. Unknown ids are omitted from the answer.",
      method: "get",
      tags: ["budgets"],
      request: {
        query: modelCatalogQuerySchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(modelCatalogResponseSchema, "The rows of the known ids"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["budgets", "models"] },
    }
  )
)

export const registerModelsBudgetV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { ids } = c.req.valid("query")
    await keyAuth(c, { requireType: ["runtime", "config"] })
    c.header("Cache-Control", "private, max-age=3600")
    return c.json(
      { version: MODEL_CATALOG_VERSION, models: modelRatesFor(ids) },
      HttpStatusCodes.OK
    )
  })
