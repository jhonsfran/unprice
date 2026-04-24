import { createRoute } from "@hono/zod-openapi"
import { walletGrantSourceSchema } from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["wallet"]

const walletGrantResponseSchema = z.object({
  id: z.string(),
  source: walletGrantSourceSchema,
  issued_amount: z.number().int().nonnegative(),
  remaining_amount: z.number().int().nonnegative(),
  expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
})

const walletResponseSchema = z.object({
  available: z.object({
    purchased: z.number().int().nonnegative(),
    granted: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  reserved: z.number().int().nonnegative(),
  consumed: z.number().int().nonnegative(),
  grants: walletGrantResponseSchema.array(),
})

export const route = createRoute({
  path: "/v1/wallet/getWallet",
  operationId: "wallet.getWallet",
  summary: "get wallet state",
  description:
    "Snapshot of the four customer sub-account balances (purchased, granted, reserved, consumed) plus the list of active wallet grants. Amounts are at pgledger scale 8 ($1 = 100_000_000).",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      z.object({
        customerId: z.string().openapi({
          description: "The customer ID",
          example: "cus_1H7KQFLr7RepUyQBKdnvY",
        }),
        projectId: z
          .string()
          .openapi({
            description: "The project ID",
            example: "prj_1H7KQFLr7RepUyQBKdnvY",
          })
          .optional(),
      }),
      "Body of the request"
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(walletResponseSchema, "The wallet state for a customer"),
    ...openApiErrorResponses,
  },
})

export type GetWalletRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type GetWalletResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerGetWalletV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("json")
    const { wallet } = c.get("services")

    const key = await keyAuth(c)

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id ?? "",
    })

    const { val, err } = await wallet.getWalletState({
      projectId: finalProjectId,
      customerId,
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    const { balances, grants } = val

    return c.json(
      {
        available: {
          purchased: balances.purchased,
          granted: balances.granted,
          total: balances.purchased + balances.granted,
        },
        reserved: balances.reserved,
        consumed: balances.consumed,
        grants: grants.map((g) => ({
          id: g.id,
          source: g.source,
          issued_amount: g.issuedAmount,
          remaining_amount: g.remainingAmount,
          expires_at: g.expiresAt ? g.expiresAt.toISOString() : null,
          created_at: g.createdAt.toISOString(),
        })),
      },
      HttpStatusCodes.OK
    )
  })
