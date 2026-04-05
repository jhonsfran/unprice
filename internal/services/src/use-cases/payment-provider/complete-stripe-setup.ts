import { type Database, and, eq } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { toErrorContext } from "../../utils/log-context"

type CompleteStripeSetupDeps = {
  services: Pick<ServiceContext, "customers">
  db: Database
  logger: Logger
}

type CompleteStripeSetupInput = {
  projectId: string
  sessionId: string
}

type CompleteStripeSetupOutput = {
  redirectUrl: string
}

const stripeSetupMetadataSchema = z.object({
  customerId: z.string().describe("The stripe customer id"),
  successUrl: z.string().url().describe("The success url"),
  cancelUrl: z.string().url().describe("The cancel url"),
})

export async function completeStripeSetup(
  deps: CompleteStripeSetupDeps,
  input: CompleteStripeSetupInput
): Promise<Result<CompleteStripeSetupOutput, FetchError | UnPriceCustomerError>> {
  const { projectId, sessionId } = input

  deps.logger.set({
    business: {
      operation: "payment_provider.complete_stripe_setup",
      project_id: projectId,
    },
  })

  const { err: paymentProviderErr, val: paymentProviderService } =
    await deps.services.customers.getPaymentProvider({
      projectId,
      provider: "stripe",
    })

  if (paymentProviderErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: paymentProviderErr.message,
      })
    )
  }

  const { err: getSessionErr, val: stripeSession } = await paymentProviderService.getSession({
    sessionId,
  })

  if (getSessionErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: getSessionErr.message,
      })
    )
  }

  const metadata = stripeSetupMetadataSchema.safeParse(stripeSession.metadata)

  if (!metadata.success) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: `Invalid metadata for stripe setup: ${metadata.error.message}`,
      })
    )
  }

  paymentProviderService.setCustomerId(stripeSession.customerId)

  const { err: getPaymentMethodsErr, val: paymentMethods } =
    await paymentProviderService.listPaymentMethods({
      limit: 1,
    })

  if (getPaymentMethodsErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: getPaymentMethodsErr.message,
      })
    )
  }

  const defaultPaymentMethodId = paymentMethods.at(0)?.id ?? null

  const { val: customerData, err: customerErr } = await wrapResult(
    deps.db.query.customers.findFirst({
      where: (customer, { and, eq }) =>
        and(eq(customer.id, metadata.data.customerId), eq(customer.projectId, projectId)),
    }),
    (error) =>
      new FetchError({
        message: `Error finding customer for stripe setup: ${error.message}`,
        retry: false,
      })
  )

  if (customerErr) {
    deps.logger.error("Error finding customer for stripe setup", {
      error: toErrorContext(customerErr),
      projectId,
      customerId: metadata.data.customerId,
    })

    return Err(customerErr)
  }

  if (!customerData) {
    return Err(
      new UnPriceCustomerError({
        code: "CUSTOMER_NOT_FOUND",
        message: "Unprice customer not found in database",
      })
    )
  }

  const { err: updateErr } = await wrapResult(
    deps.db
      .update(customers)
      .set({
        stripeCustomerId: stripeSession.customerId,
        metadata: {
          ...customerData.metadata,
          stripeSubscriptionId: stripeSession.subscriptionId ?? "",
          stripeDefaultPaymentMethodId: defaultPaymentMethodId ?? "",
        },
      })
      .where(and(eq(customers.id, customerData.id), eq(customers.projectId, projectId)))
      .execute(),
    (error) =>
      new FetchError({
        message: `Error updating customer for stripe setup: ${error.message}`,
        retry: false,
      })
  )

  if (updateErr) {
    deps.logger.error("Error updating customer for stripe setup", {
      error: toErrorContext(updateErr),
      projectId,
      customerId: customerData.id,
    })

    return Err(updateErr)
  }

  return Ok({
    redirectUrl: metadata.data.successUrl,
  })
}
