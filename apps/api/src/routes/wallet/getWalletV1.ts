import { type RouteHandler, createRoute } from "@hono/zod-openapi"
import {
  type Currency,
  type WalletCredit,
  currencySchema,
  walletCreditSourceSchema,
} from "@unprice/db/validators"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import { resolveOwnedCustomer } from "~/auth/key"
import { UnpriceApiError, toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import type { HonoEnv } from "~/hono/env"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
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
  issued: walletAmountResponseSchema,
  available: walletAmountResponseSchema,
  expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
})

const walletResponseSchema = z.object({
  currency: currencySchema,
  available: walletAmountResponseSchema,
  held: walletAmountResponseSchema,
  credits: walletCreditResponseSchema.array(),
})

const walletCreditBalanceResponseSchema = z.object({
  currency: currencySchema,
  wallet: walletCreditResponseSchema,
})

const walletBalanceQuerySchema = z.object({
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
})

const walletCreditBalanceParamsSchema = z.object({
  walletId: z.string().openapi({
    description: "The wallet credit ID returned in the wallet balance credits array",
    example: "wcr_1H7KQFLr7RepUyQBKdnvY",
  }),
})

export const walletBalanceRoute = createRoute(
  defineEndpointContract(
    {
      path: "/v1/wallet/balance",
      operationId: "wallet.balance",
      summary: "get wallet balance",
      description:
        "Current customer wallet balance plus active holds and credits. Amounts include both the raw pgledger scale-8 value and customer-facing currency display values.",
      method: "get",
      tags,
      request: {
        query: walletBalanceQuerySchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          walletResponseSchema,
          "The wallet balance for a customer"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "money",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["wallet", "balance"],
      },
    }
  )
)

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/internal/wallet/get",
      operationId: "wallet.internalGet",
      summary: "get wallet balance",
      description:
        "Compatibility alias for /v1/wallet/balance. Current customer wallet balance plus active holds and credits.",
      method: "get",
      hide: true,
      tags,
      request: {
        query: walletBalanceQuerySchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          walletResponseSchema,
          "The wallet balance for a customer"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "internal",
      category: "money",
      docs: {
        expose: false,
      },
      sdk: false,
    }
  )
)

export const walletCreditBalanceRoute = createRoute(
  defineEndpointContract(
    {
      path: "/v1/wallet-credits/balance/{walletId}",
      operationId: "walletCredits.balance",
      summary: "get wallet credit balance",
      description:
        "Current balance for one wallet credit owned by the customer. The walletId is the wcr_ ID returned in the wallet balance credits array.",
      method: "get",
      tags: ["walletCredits"],
      request: {
        params: walletCreditBalanceParamsSchema,
        query: walletBalanceQuerySchema,
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          walletCreditBalanceResponseSchema,
          "The balance for one wallet credit"
        ),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "money",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["walletCredits", "balance"],
      },
    }
  )
)

export type GetWalletRequest = z.infer<typeof walletBalanceRoute.request.query>
export type GetWalletResponse = z.infer<
  (typeof walletBalanceRoute.responses)[200]["content"]["application/json"]["schema"]
>
export type GetWalletCreditBalanceRequest = z.infer<typeof walletCreditBalanceRoute.request.query> &
  z.infer<typeof walletCreditBalanceRoute.request.params>
export type GetWalletCreditBalanceResponse = z.infer<
  (typeof walletCreditBalanceRoute.responses)[200]["content"]["application/json"]["schema"]
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

function formatWalletCredit(credit: WalletCredit, currency: Currency) {
  return {
    id: credit.id,
    source: credit.source,
    issued: formatWalletAmount(credit.issuedAmount, currency),
    available: formatWalletAmount(credit.remainingAmount, currency),
    expires_at: credit.expiresAt ? credit.expiresAt.toISOString() : null,
    created_at: credit.createdAt.toISOString(),
  }
}

function formatWalletState(
  state: {
    balances: { purchased: number; granted: number; reserved: number }
    credits: WalletCredit[]
  },
  currency: Currency
) {
  const { balances, credits } = state

  return {
    currency,
    available: formatWalletAmount(balances.purchased + balances.granted, currency),
    held: formatWalletAmount(balances.reserved, currency),
    credits: credits.map((credit) => formatWalletCredit(credit, currency)),
  }
}

// The public route and the internal compatibility alias are character-identical;
// register one handler for both.
const walletBalanceHandler: RouteHandler<typeof walletBalanceRoute, HonoEnv> = async (c) => {
  const { customerId: inputCustomerId, projectId } = c.req.valid("query")
  const { wallet: walletService } = c.get("services")

  const {
    customerId,
    projectId: finalProjectId,
    customer,
  } = await resolveOwnedCustomer(c, {
    customerId: inputCustomerId,
    projectId,
  })

  const { val, err } = await walletService.getWalletState({
    projectId: finalProjectId,
    customerId,
  })

  if (err) {
    throw toUnpriceApiError(err)
  }

  return c.json(formatWalletState(val, customer.defaultCurrency), HttpStatusCodes.OK)
}

export const registerGetWalletV1 = (app: App) => {
  app.openapi(walletBalanceRoute, walletBalanceHandler)
  app.openapi(route, walletBalanceHandler)

  app.openapi(walletCreditBalanceRoute, async (c) => {
    const { customerId: inputCustomerId, projectId } = c.req.valid("query")
    const { walletId } = c.req.valid("param")
    const { wallet: walletService } = c.get("services")

    const {
      customerId,
      projectId: finalProjectId,
      customer,
    } = await resolveOwnedCustomer(c, {
      customerId: inputCustomerId,
      projectId,
    })

    const { val, err } = await walletService.getWalletCreditBalance({
      projectId: finalProjectId,
      customerId,
      walletId,
    })

    if (err) {
      throw toUnpriceApiError(err)
    }

    if (!val) {
      throw new UnpriceApiError({ code: "NOT_FOUND", message: "Wallet credit not found" })
    }

    return c.json(
      {
        currency: customer.defaultCurrency,
        wallet: formatWalletCredit(val, customer.defaultCurrency),
      },
      HttpStatusCodes.OK
    )
  })
}
