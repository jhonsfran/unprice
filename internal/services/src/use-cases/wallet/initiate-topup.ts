import { and, eq, type Database } from "@unprice/db"
import { walletTopups } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { Currency, PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"

type InitiateTopupDeps = {
  services: Pick<ServiceContext, "customers">
  db: Database
  logger: Logger
}

type InitiateTopupInput = {
  projectId: string
  customerId: string
  provider: PaymentProvider
  /** Amount in pgledger scale-8 minor units (e.g. $10 → 1_000_000_000). */
  amount: number
  currency: Currency
  successUrl: string
  cancelUrl: string
  description?: string
}

type InitiateTopupOutput = {
  topupId: string
  checkoutUrl: string
  providerSessionId: string
}

/**
 * Begin a customer-initiated wallet top-up. Inserts a `pending`
 * `wallet_topups` row before creating the provider checkout session so an
 * eager webhook can always find the row. The ledger transfer does not happen
 * until the provider webhook settles the session.
 */
export async function initiateTopup(
  deps: InitiateTopupDeps,
  input: InitiateTopupInput
): Promise<Result<InitiateTopupOutput, FetchError | UnPriceCustomerError>> {
  deps.logger.set({
    business: {
      operation: "wallet.initiate_topup",
      project_id: input.projectId,
      customer_id: input.customerId,
    },
  })

  if (input.amount <= 0) {
    return Err(
      new FetchError({
        message: "Top-up amount must be greater than zero",
        retry: false,
      })
    )
  }

  const { val: customer, err: customerErr } = await wrapResult(
    deps.db.query.customers.findFirst({
      where: (c, { and, eq }) => and(eq(c.id, input.customerId), eq(c.projectId, input.projectId)),
    }),
    (error) =>
      new FetchError({
        message: `Error finding customer for top-up: ${error.message}`,
        retry: false,
      })
  )

  if (customerErr) return Err(customerErr)
  if (!customer) {
    return Err(
      new UnPriceCustomerError({
        code: "CUSTOMER_NOT_FOUND",
        message: "Customer not found",
      })
    )
  }

  const { err: providerErr, val: providerService } =
    await deps.services.customers.getPaymentProvider({
      customerId: input.customerId,
      projectId: input.projectId,
      provider: input.provider,
    })

  if (providerErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: providerErr.message,
      })
    )
  }

  const topupId = newId("wallet_topup")

  const { err: insertErr } = await wrapResult(
    deps.db.insert(walletTopups).values({
      id: topupId,
      projectId: input.projectId,
      customerId: input.customerId,
      provider: input.provider,
      providerSessionId: null,
      requestedAmount: input.amount,
      currency: input.currency,
      status: "pending",
    }),
    (error) =>
      new FetchError({
        message: `Failed to persist wallet top-up row: ${error.message}`,
        retry: false,
      })
  )

  if (insertErr) {
    return Err(insertErr)
  }

  const { err: sessionErr, val: session } = await providerService.createSession({
    kind: "wallet_topup",
    currency: input.currency,
    customerId: input.customerId,
    projectId: input.projectId,
    email: customer.email,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    amount: input.amount,
    description: input.description,
    metadata: {
      kind: "wallet_topup",
      topup_id: topupId,
      customer_id: input.customerId,
      project_id: input.projectId,
      currency: input.currency,
      requested_amount: String(input.amount),
    },
  })

  if (sessionErr) {
    await deps.db
      .update(walletTopups)
      .set({ status: "failed" })
      .where(and(eq(walletTopups.id, topupId), eq(walletTopups.projectId, input.projectId)))

    return Err(
      new FetchError({
        message: `Failed to create top-up session: ${sessionErr.message}`,
        retry: true,
      })
    )
  }

  if (!session.sessionId || !session.url) {
    await deps.db
      .update(walletTopups)
      .set({ status: "failed" })
      .where(and(eq(walletTopups.id, topupId), eq(walletTopups.projectId, input.projectId)))

    return Err(
      new FetchError({
        message: "Provider returned an empty top-up session",
        retry: false,
      })
    )
  }

  const { err: updateErr } = await wrapResult(
    deps.db
      .update(walletTopups)
      .set({ providerSessionId: session.sessionId })
      .where(and(eq(walletTopups.id, topupId), eq(walletTopups.projectId, input.projectId))),
    (error) =>
      new FetchError({
        message: `Failed to persist wallet top-up session: ${error.message}`,
        retry: false,
      })
  )

  if (updateErr) {
    deps.logger.error(updateErr, {
      context: "Failed to persist wallet_topups provider session after creating session",
      topupId,
      providerSessionId: session.sessionId,
      projectId: input.projectId,
    })
    return Err(updateErr)
  }

  return Ok({
    topupId,
    checkoutUrl: session.url,
    providerSessionId: session.sessionId,
  })
}
