import {
  type WalletCredit,
  currencySchema,
  customerSelectSchema,
  walletCreditSelectSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { UnPriceWalletError, WalletCreditWithConsumption } from "../../wallet"

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

export const walletCreditStatusSchema = z.enum(["active", "expired"])

export const customerWalletCreditSchema = walletCreditSelectSchema.extend({
  consumedAmount: z.number().int().nonnegative(),
  status: walletCreditStatusSchema,
  usableAmount: z.number().int().nonnegative(),
})

export const getCustomerWalletOutputSchema = z.object({
  customer: customerSelectSchema,
  wallet: z.object({
    currency: currencySchema,
    balances: customerWalletBalancesSchema,
    credits: customerWalletCreditSchema.array(),
  }),
})

export type GetCustomerWalletInput = z.infer<typeof getCustomerWalletInputSchema>
export type GetCustomerWalletOutput = z.infer<typeof getCustomerWalletOutputSchema>
export type CustomerWalletCredit = z.infer<typeof customerWalletCreditSchema>

export type GetCustomerWalletDeps = {
  services: Pick<ServiceContext, "customers" | "wallet">
  logger: Logger
  now?: () => Date
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

  const now = deps.now?.() ?? new Date()
  const credits = walletResult.val.credits
    .map((credit) => toCustomerWalletCredit(credit, now))
    .sort(compareCustomerWalletCredits)
  const activeGranted = credits.reduce((sum, credit) => sum + credit.usableAmount, 0)

  return Ok(
    getCustomerWalletOutputSchema.parse({
      customer: customerResult.val,
      wallet: {
        currency: customerResult.val.defaultCurrency,
        balances: {
          ...walletResult.val.balances,
          granted: activeGranted,
        },
        credits,
      },
    })
  )
}

function toCustomerWalletCredit(
  credit: WalletCreditWithConsumption,
  now: Date
): CustomerWalletCredit {
  const status = isExpired(credit, now) ? "expired" : "active"

  return {
    ...credit,
    status,
    usableAmount: status === "active" ? credit.remainingAmount : 0,
  }
}

function isExpired(credit: WalletCredit, now: Date): boolean {
  if (credit.expiredAt) {
    return true
  }

  return Boolean(credit.expiresAt && credit.expiresAt.getTime() <= now.getTime())
}

function compareCustomerWalletCredits(a: CustomerWalletCredit, b: CustomerWalletCredit): number {
  const createdAtDelta = b.createdAt.getTime() - a.createdAt.getTime()
  if (createdAtDelta !== 0) {
    return createdAtDelta
  }

  return b.id.localeCompare(a.id)
}
