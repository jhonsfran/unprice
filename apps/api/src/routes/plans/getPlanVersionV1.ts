import { createRoute } from "@hono/zod-openapi"
import { getPlanVersionApiResponseSchema } from "@unprice/db/validators"
import { jsonContent } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors/http"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["plans"]

export const route = createRoute({
  path: "/v1/plans/getPlanVersion/{planVersionId}",
  operationId: "plans.getPlanVersion",
  summary: "get plan version",
  description: "Get a plan version by id",
  method: "get",
  tags,
  request: {
    params: z.object({
      planVersionId: z.string().openapi({
        description: "The plan version id",
        example: "pv_1H7KQFLr7RepUyQBKdnvY",
      }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        planVersion: getPlanVersionApiResponseSchema,
      }),
      "The result of the get plan version"
    ),
    ...openApiErrorResponses,
  },
})

export type GetPlanVersionResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetPlanVersionV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { plans } = c.get("services")
    const { planVersionId } = c.req.valid("param")

    // validate the request
    const key = await keyAuth(c)

    // main workspace can see all plans
    // TODO: improve this
    const isMain = key.project.workspace.isMain

    const { err, val: planVersionData } = await plans.getPlanVersion({
      projectId: isMain ? undefined : key.projectId,
      planVersionId,
    })

    if (err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!planVersionData) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    return c.json(
      {
        planVersion: planVersionData,
      },
      HttpStatusCodes.OK
    )
  })
