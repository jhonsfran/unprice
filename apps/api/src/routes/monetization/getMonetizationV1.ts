import { createRoute, type z } from "@hono/zod-openapi"
import {
  getMonetizationConfig,
  getMonetizationConfigOutputSchema,
} from "@unprice/services/use-cases"
import { endTime, startTime } from "hono/timing"
import { jsonContent } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["monetization"]

const getOkSchema = getMonetizationConfigOutputSchema.options[0]

const getMonetizationResponseSchema = getOkSchema.omit({ state: true })

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/monetization/get",
      operationId: "monetization.get",
      summary: "get monetization configuration",
      description:
        "Read this project's monetization configuration in the shape monetization.apply accepts, plus what the document cannot state and what it is silent about.",
      method: "get",
      tags,
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          getMonetizationResponseSchema,
          "The project's configuration document, its per-plan version state, and everything the document could not carry"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "configuration",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["monetization", "get"],
      },
    }
  )
)

export type GetMonetizationResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

type GetOutput = z.infer<typeof getMonetizationConfigOutputSchema>
type GetFailure = Exclude<GetOutput, { state: "ok" }>

/**
 * These are states of the project, not of the request. Two default plans is a
 * genuine conflict in the stored data; the other two say a precondition for
 * emitting a document is not met. None of them are `ApiErrorDetails`
 * kinds, so none of them carry structured detail — the use case's message
 * already names what is wrong.
 */
const FAILURE_CODES = {
  no_default_plan: "PRECONDITION_FAILED",
  multiple_default_plans: "CONFLICT",
  unrepresentable_configuration: "PRECONDITION_FAILED",
} as const satisfies Record<GetFailure["state"], string>

export const registerGetMonetizationV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const key = await keyAuth(c, { requireType: "config" })

    startTime(c, "getMonetizationConfig")

    const { err, val } = await getMonetizationConfig(
      {
        db: c.get("db"),
        logger: c.get("logger"),
      },
      {
        // never a query parameter: the project is the credential's
        projectId: key.projectId,
      }
    )

    endTime(c, "getMonetizationConfig")

    if (err) {
      throw toUnpriceApiError(err)
    }

    if (val.state !== "ok") {
      throw new UnpriceApiError({
        code: FAILURE_CODES[val.state],
        message: val.message,
      })
    }

    return c.json(
      {
        config: val.config,
        plans: val.plans,
        unrepresentablePlans: val.unrepresentablePlans,
        warnings: val.warnings,
        integrationContract: val.integrationContract,
      },
      HttpStatusCodes.OK
    )
  })
