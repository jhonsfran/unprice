import type { Database } from "@unprice/db"
import type { PaymentProvider, PaymentProviderConfig } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"

type PaymentProviderAvailabilityDeps = {
  db: Database
  logger: Logger
}

type PaymentProviderAvailabilityInput = {
  projectId: string
  paymentProvider: PaymentProvider
}

type PaymentProviderUnavailableReason = "missing" | "disabled" | "not_ready"

export type PaymentProviderAvailability =
  | {
      available: true
      paymentProviderConfig: PaymentProviderConfig
    }
  | {
      available: false
      reason: PaymentProviderUnavailableReason
      message: string
      paymentProviderConfig?: PaymentProviderConfig
    }

function providerLabel(paymentProvider: PaymentProvider): string {
  switch (paymentProvider) {
    case "stripe":
      return "Stripe"
    case "sandbox":
      return "Sandbox"
    case "square":
      return "Square"
  }
}

function stripeIsReady(config: PaymentProviderConfig): boolean {
  return Boolean(config.externalAccountId) && config.status === "active"
}

export async function checkPaymentProviderAvailability(
  deps: PaymentProviderAvailabilityDeps,
  input: PaymentProviderAvailabilityInput
): Promise<Result<PaymentProviderAvailability, FetchError>> {
  const { val: config, err } = await wrapResult(
    deps.db.query.paymentProviderConfig.findFirst({
      where: (table, { and, eq }) =>
        and(eq(table.projectId, input.projectId), eq(table.paymentProvider, input.paymentProvider)),
    }),
    (error) =>
      new FetchError({
        message: `error checking payment provider availability: ${error.message}`,
        retry: false,
      })
  )

  if (err) {
    deps.logger.error(err, {
      context: "error checking payment provider availability",
      projectId: input.projectId,
      paymentProvider: input.paymentProvider,
    })
    return Err(err)
  }

  const paymentProviderConfig = config as PaymentProviderConfig | undefined
  const label = providerLabel(input.paymentProvider)

  if (!paymentProviderConfig) {
    return Ok({
      available: false,
      reason: "missing",
      message: `${label} is not enabled for this project. Enable it in payment settings before creating subscriptions.`,
    })
  }

  if (!paymentProviderConfig.active) {
    return Ok({
      available: false,
      reason: "disabled",
      message: `${label} is disabled for this project. Enable it in payment settings before creating subscriptions.`,
      paymentProviderConfig,
    })
  }

  if (input.paymentProvider === "stripe" && !stripeIsReady(paymentProviderConfig)) {
    return Ok({
      available: false,
      reason: "not_ready",
      message:
        "Stripe is not ready to process payments. Complete onboarding and refresh the connection before creating subscriptions.",
      paymentProviderConfig,
    })
  }

  return Ok({
    available: true,
    paymentProviderConfig,
  })
}
