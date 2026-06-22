import {
  currencySchema,
  customerSelectSchema,
  walletCreditSelectSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { UnPriceWalletError } from "../../wallet"

export const getCustomerWalletInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const customerWalletBalancesSchema = z.object({
  purchased: z.number().int(),
  granted: z.number().int(),
  reserved: z.number().int(),
  consumed: z.number().int(),
})

export const getCustomerWalletOutputSchema = z.object({
  customer: customerSelectSchema,
  wallet: z.object({
    currency: currencySchema,
    balances: customerWalletBalancesSchema,
    credits: walletCreditSelectSchema.array(),
  }),
})

export type GetCustomerWalletInput = z.infer<typeof getCustomerWalletInputSchema>
export type GetCustomerWalletOutput = z.infer<typeof getCustomerWalletOutputSchema>

export type GetCustomerWalletDeps = {
  services: Pick<ServiceContext, "customers" | "wallet">
  logger: Logger
}

export async function getCustomerWallet(
  deps: GetCustomerWalletDeps,
  rawInput: GetCustomerWalletInput
): Promise<Result<GetCustomerWalletOutput | null, FetchError | UnPriceWalletError>> {
  const input = getCustomerWalletInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "wallet.get_customer_wallet",
      project_id: input.projectId,
      customer_id: input.customerId,
    },
  })

  const customerResult = await deps.services.customers.getCustomerByIdInProject({
    id: input.customerId,
    projectId: input.projectId,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  if (!customerResult.val) {
    return Ok(null)
  }

  const walletResult = await deps.services.wallet.getWalletState({
    projectId: input.projectId,
    customerId: input.customerId,
  })

  if (walletResult.err) {
    return Err(walletResult.err)
  }

  return Ok(
    getCustomerWalletOutputSchema.parse({
      customer: customerResult.val,
      wallet: {
        currency: customerResult.val.defaultCurrency,
        balances: walletResult.val.balances,
        credits: walletResult.val.credits,
      },
    })
  )
}
