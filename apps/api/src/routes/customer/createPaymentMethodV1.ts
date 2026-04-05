import { createRoute } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import {
  createPaymentMethodResponseSchema,
  createPaymentMethodSchema,
} from "@unprice/db/validators"
import type { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/createPaymentMethod",
  operationId: "customers.createPaymentMethod",
  summary: "create payment method",
  description: "Create a payment method for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      createPaymentMethodSchema.openapi({
        description: "The customer create payment method request",
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      createPaymentMethodResponseSchema,
      "The result of the customer create payment method"
    ),
    ...openApiErrorResponses,
  },
})

export type CreatePaymentMethodRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type CreatePaymentMethodResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerCreatePaymentMethodV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { paymentProvider, customerId, successUrl, cancelUrl } = c.req.valid("json")
    const { customer } = c.get("services")

    // validate the request
    await keyAuth(c)

    const { err: customerDataErr, val: customerData } = await customer.getCustomer(customerId)

    if (customerDataErr) {
      throw toUnpriceApiError(customerDataErr)
    }

    if (!customerData) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    // get payment provider for the project
    const { err: paymentProviderErr, val: paymentProviderService } =
      await customer.getPaymentProvider({
        customerId: customerData.id,
        projectId: customerData.projectId,
        provider: paymentProvider,
      })

    if (paymentProviderErr) {
      throw toUnpriceApiError(paymentProviderErr)
    }

    const { err, val } = await paymentProviderService.createSession({
      customerId: customerData.id,
      projectId: customerData.projectId,
      email: customerData.email,
      currency: customerData.defaultCurrency,
      successUrl: successUrl,
      cancelUrl: cancelUrl,
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    return c.json(val, HttpStatusCodes.OK)
  })
