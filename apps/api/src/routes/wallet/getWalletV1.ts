import { createRoute } from "@hono/zod-openapi"
import { type Currency, currencySchema, walletCreditSourceSchema } from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["wallet"]

const walletAmountResponseSchema = z.object({
  ledger_amount: z.number().int().nonnegative(),
  amount: z.string(),
  currency: currencySchema,
  display_amount: z.string(),
})

const walletCreditResponseSchema = z.object({
  id: z.string(),
  source: walletCreditSourceSchema,
  issued_amount: walletAmountResponseSchema,
  remaining_amount: walletAmountResponseSchema,
  expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
})

const walletResponseSchema = z.object({
  currency: currencySchema,
  available: z.object({
    purchased: walletAmountResponseSchema,
    granted: walletAmountResponseSchema,
    total: walletAmountResponseSchema,
  }),
  reserved: walletAmountResponseSchema,
  consumed: walletAmountResponseSchema,
  credits: walletCreditResponseSchema.array(),
})

export const route = createRoute({
  path: "/v1/wallet",
  operationId: "wallet.get",
  summary: "get wallet state",
  description:
    "Snapshot of the four customer sub-account balances (purchased, granted, reserved, consumed) plus active wallet credits. Amounts include both the raw pgledger scale-8 value and customer-facing currency display values.",
  method: "get",
  tags,
  request: {
    query: z.object({
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
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(walletResponseSchema, "The wallet state for a customer"),
    ...openApiErrorResponses,
  },
})

export type GetWalletRequest = z.infer<typeof route.request.query>
export type GetWalletResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

function formatWalletAmount(ledgerAmount: number, currency: Currency) {
  const amount = toDecimal(fromLedgerMinor(ledgerAmount, currency))

  return {
    ledger_amount: ledgerAmount,
    amount,
    currency,
    display_amount: formatMoney(amount, currency),
  }
}

export const registerGetWalletV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { customerId, projectId } = c.req.valid("query")
    const { customer, wallet } = c.get("services")

    const key = await keyAuth(c)

    const finalProjectId = validateIsAllowedToAccessProject({
      isMain: key.project.isMain ?? false,
      key,
      requestedProjectId: projectId ?? key.project.id ?? "",
    })

    const { val: customerRecord, err: customerErr } = await customer.getCustomer(customerId)

    if (customerErr) {
      throw toUnpriceApiError(customerErr)
    }

    if (!customerRecord || customerRecord.projectId !== finalProjectId) {
      throw new UnpriceApiError({ code: "NOT_FOUND", message: "Customer not found" })
    }

    const { val, err } = await wallet.getWalletState({
      projectId: finalProjectId,
      customerId,
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    const { balances, credits } = val
    const currency = customerRecord.defaultCurrency

    return c.json(
      {
        currency,
        available: {
          purchased: formatWalletAmount(balances.purchased, currency),
          granted: formatWalletAmount(balances.granted, currency),
          total: formatWalletAmount(balances.purchased + balances.granted, currency),
        },
        reserved: formatWalletAmount(balances.reserved, currency),
        consumed: formatWalletAmount(balances.consumed, currency),
        credits: credits.map((credit) => ({
          id: credit.id,
          source: credit.source,
          issued_amount: formatWalletAmount(credit.issuedAmount, currency),
          remaining_amount: formatWalletAmount(credit.remainingAmount, currency),
          expires_at: credit.expiresAt ? credit.expiresAt.toISOString() : null,
          created_at: credit.createdAt.toISOString(),
        })),
      },
      HttpStatusCodes.OK
    )
  })
