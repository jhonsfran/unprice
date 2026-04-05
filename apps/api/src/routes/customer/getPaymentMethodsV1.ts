import { createRoute } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { customerPaymentMethodSchema, paymentProviderSchema } from "@unprice/db/validators"
import { z } from "zod"
import { keyAuth } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"

const tags = ["customer"]

export const route = createRoute({
  path: "/v1/customer/getPaymentMethods",
  operationId: "customers.getPaymentMethods",
  summary: "get payment methods",
  description: "Get payment methods for a customer",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        provider: paymentProviderSchema.openapi({
          description: "The payment provider",
          example: "stripe",
        }),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      customerPaymentMethodSchema.array(),
      "The result of the get payment methods"
    ),
    ...openApiErrorResponses,
  },
})

export type GetPaymentMethodsRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetPaymentMethodsResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetPaymentMethodsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, provider } = c.req.valid("json")
    const { customer } = c.get("services")

    // validate the request
    await keyAuth(c)

    // TODO: check this an identify key can query all customers
    const { err: customerDataErr, val: customerData } = await customer.getCustomer(customerId)

    if (customerDataErr) {
      throw toUnpriceApiError(customerDataErr)
    }

    if (!customerData) {
      throw new UnpriceApiError({ code: "NOT_FOUND", message: "Customer not found" })
    }

    // get payment methods from service
    const result = await customer.getPaymentMethods({
      customerId: customerData.id,
      provider,
      projectId: customerData.projectId,
    })

    if (result.err) {
      throw toUnpriceApiError(result.err)
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
