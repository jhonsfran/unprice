import { createRoute } from "@hono/zod-openapi"
import { subscriptionStatusSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import * as HttpStatusCodes from "~/util/http-status-codes"

import { z } from "zod"
import { keyAuth, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"

const tags = ["access"]

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/access/update",
      operationId: "access.update",
      summary: "update ACL",
      description: "Update the ACL for a customer",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            customerId: z.string().openapi({
              description: "The customer ID",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            }),
            updates: z.object({
              customerUsageLimitReached: z.boolean().optional(),
              customerDisabled: z.boolean().optional(),
              subscriptionStatus: subscriptionStatusSchema.optional(),
            }),
          }),
          "The updates to the ACL"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(z.object({}), "The result of the update ACL"),
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
        path: ["access", "update"],
      },
    }
  )
)

export type UpdateACLRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type UpdateACLResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerUpdateACLV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId: inputCustomerId, updates } = c.req.valid("json")
    const { customer } = c.get("services")

    // validate the request
    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: inputCustomerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    const isMain = (key.project.isMain ?? false) || key.project.workspace.isMain
    const { err, val: customerRecord } = isMain
      ? await customer.getCustomerByIdAcrossProjects(customerId)
      : await customer.getCustomerByIdInProject({
          id: customerId,
          projectId: key.projectId,
        })

    if (err) {
      throw new UnpriceApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!customerRecord) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    await customer.updateAccessControlList({
      customerId,
      projectId: customerRecord.projectId,
      updates,
    })

    return c.json({}, HttpStatusCodes.OK)
  })
