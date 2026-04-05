import { createRoute } from "@hono/zod-openapi"
import { UnPriceProjectError } from "@unprice/services/projects"
import { endTime, startTime } from "hono/timing"
import { jsonContent } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import type { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors/http"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { getProjectFeaturesResponseSchema } from "~/project/interface"

const tags = ["project"]

export const route = createRoute({
  path: "/v1/project/getFeatures",
  operationId: "projects.getFeatures",
  summary: "get features",
  description: "Get features for a project",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      getProjectFeaturesResponseSchema,
      "The result of the get features"
    ),
    ...openApiErrorResponses,
  },
})

export type GetFeaturesResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetFeaturesV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { project } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    // start a new timer
    startTime(c, "getFeatures")

    // validate usage from db
    const { err, val } = await project.getProjectFeatures({
      projectId: key.projectId,
    })

    // end the timer
    endTime(c, "getFeatures")

    if (err) {
      if (err instanceof UnPriceProjectError && err.code === "PROJECT_NOT_ENABLED") {
        throw new UnpriceApiError({
          code: "FORBIDDEN",
          message: err.message,
        })
      }

      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    return c.json(
      {
        features: val?.features ?? [],
      },
      HttpStatusCodes.OK
    )
  })
