import { createRoute } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { createRealtimeTicket } from "~/auth/ticket"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["analytics"]

export const route = createRoute({
  path: "/v1/analytics/realtime/ticket",
  operationId: "analytics.getRealtimeTicket",
  summary: "issue realtime websocket ticket",
  description:
    "Issue a short-lived ticket for customer realtime websocket access. The ticket is scoped to user, project, and customer.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID to scope realtime access",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z
          .string()
          .openapi({
            description: "The project ID to scope realtime access",
            example: "project_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
      }),
      "Realtime ticket request payload"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        ticket: z.string(),
        expiresAt: z.number().int(),
        projectId: z.string(),
        customerId: z.string(),
      }),
      "Realtime websocket ticket"
    ),
    ...openApiErrorResponses,
  },
})

export type GetRealtimeTicketRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>

export type GetRealtimeTicketResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetRealtimeTicketV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")

    // validate auth
    const key = await keyAuth(c)

    const isMain = key.project.workspace.isMain

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain,
      key,
      requestedProjectId: projectId ?? key.project.id,
    })

    const { customer } = c.get("services")
    const { err: customerErr, val: customerData } = await customer.getCustomer(customerId)

    if (customerErr) {
      throw toUnpriceApiError(customerErr)
    }

    if (!customerData) {
      throw new UnpriceApiError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    if (customerData.projectId !== projectId && !isMain) {
      throw new UnpriceApiError({
        code: "FORBIDDEN",
        message: "Customer does not belong to this project",
      })
    }

    const expiresInSeconds = 3600
    const ticket = await createRealtimeTicket({
      secret: c.env.AUTH_SECRET,
      projectId: finalProjectId,
      customerId,
      expiresInSeconds,
    })

    return c.json(
      {
        ticket,
        expiresAt: Date.now() + expiresInSeconds * 1000,
        projectId: finalProjectId,
        customerId,
      },
      HttpStatusCodes.OK
    )
  })
