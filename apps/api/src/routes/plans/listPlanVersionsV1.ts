import { createRoute } from "@hono/zod-openapi"
import { getPlanVersionApiResponseSchema, getPlanVersionListSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors/http"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["plans"]

export const route = createRoute({
  path: "/v1/plans/listPlanVersions",
  operationId: "plans.listPlanVersions",
  summary: "list all plan versions",
  description: "List all plan versions for a project",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(getPlanVersionListSchema, "Body of the request"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        planVersions: getPlanVersionApiResponseSchema.array(),
      }),
      "The result of the list plan versions"
    ),
    ...openApiErrorResponses,
  },
})

export type GetPlanVersionsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export type GetPlanVersionsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export const registerListPlanVersionsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { plans } = c.get("services")
    const {
      onlyPublished,
      onlyEnterprisePlan,
      onlyLatest,
      billingInterval,
      currency,
      planVersionIds,
    } = c.req.valid("json")

    // validate the request
    const key = await keyAuth(c)

    const { err, val: planVersionsData } = await plans.listPlanVersions({
      projectId: key.projectId,
      query: {
        published: onlyPublished,
        enterprise: onlyEnterprisePlan,
        latest: onlyLatest,
        currency: currency,
        billingInterval,
        planVersionIds,
      },
    })

    if (err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!planVersionsData || planVersionsData?.length === 0) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Plan version not found",
      })
    }

    return c.json(
      {
        planVersions: planVersionsData,
      },
      HttpStatusCodes.OK
    )
  })
