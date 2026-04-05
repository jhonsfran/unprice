import { createRoute } from "@hono/zod-openapi"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { customerSignUpSchema, signUpResponseSchema } from "@unprice/db/validators"
import { UnPriceCustomerError } from "@unprice/services/customers"
import { signUp } from "@unprice/services/use-cases"
import type { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError } from "~/errors/http"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/signUp",
  operationId: "customers.signUp",
  summary: "sign up",
  description: "Sign up a customer for a project",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      customerSignUpSchema.openapi({
        description: "The customer sign up request",
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(signUpResponseSchema, "The result of the customer sign up"),
    ...openApiErrorResponses,
  },
})

export type SignUpRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type SignUpResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerSignUpV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const {
      email,
      planVersionId,
      successUrl,
      cancelUrl,
      config,
      externalId,
      name,
      timezone,
      defaultCurrency,
      planSlug,
      billingInterval,
      metadata,
      sessionId,
    } = c.req.valid("json")
    const { customer, subscription, plans } = c.get("services")

    // validate the request
    const key = await keyAuth(c)

    startTime(c, "customerSignUp")

    const result = await signUp(
      {
        services: {
          customers: customer,
          subscriptions: subscription,
          plans,
        },
        db: c.get("db"),
        logger: c.get("logger"),
        analytics: c.get("analytics"),
        waitUntil: c.get("waitUntil"),
      },
      {
        input: {
          name,
          timezone,
          defaultCurrency,
          email,
          planVersionId,
          planSlug,
          successUrl,
          cancelUrl,
          config,
          externalId,
          billingInterval,
          sessionId,
          metadata: metadata,
        },
        projectId: key.projectId,
      }
    ).finally(() => endTime(c, "customerSignUp"))

    if (result.err) {
      if (
        result.err instanceof UnPriceCustomerError &&
        result.err.code === "CUSTOMER_EXTERNAL_ID_CONFLICT"
      ) {
        throw new UnpriceApiError({
          code: "CONFLICT",
          message: result.err.message,
        })
      }

      throw result.err
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
