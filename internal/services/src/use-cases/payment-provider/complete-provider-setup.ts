import type { Database } from "@unprice/db"
import { customerProviderIds } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { toErrorContext } from "../../utils/log-context"

type CompleteProviderSetupDeps = {
  services: Pick<ServiceContext, "customers">
  db: Database
  logger: Logger
}

type CompleteProviderSetupInput = {
  projectId: string
  sessionId: string
  provider: PaymentProvider
}

type CompleteProviderSetupOutput = {
  redirectUrl: string
}

const providerSetupMetadataSchema = z.object({
  customerId: z.string().describe("The unprice customer id"),
  successUrl: z.string().url().describe("The success url"),
  cancelUrl: z.string().url().describe("The cancel url"),
})

function buildProviderMetadata({
  subscriptionId,
  defaultPaymentMethodId,
  setupSessionId,
}: {
  subscriptionId: string | null
  defaultPaymentMethodId: string | null
  setupSessionId: string
}) {
  return {
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(defaultPaymentMethodId ? { defaultPaymentMethodId } : {}),
    setupSessionId,
  }
}

export async function completeProviderSetup(
  deps: CompleteProviderSetupDeps,
  input: CompleteProviderSetupInput
): Promise<Result<CompleteProviderSetupOutput, FetchError | UnPriceCustomerError>> {
  const { projectId, sessionId, provider } = input

  deps.logger.set({
    business: {
      operation: "payment_provider.complete_setup",
      project_id: projectId,
    },
  })

  const { err: paymentProviderErr, val: paymentProviderService } =
    await deps.services.customers.getPaymentProvider({
      projectId,
      provider,
    })

  if (paymentProviderErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: paymentProviderErr.message,
      })
    )
  }

  const { err: getSessionErr, val: providerSession } = await paymentProviderService.getSession({
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

  const metadata = providerSetupMetadataSchema.safeParse(providerSession.metadata)

  if (!metadata.success) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: `Invalid metadata for provider setup: ${metadata.error.message}`,
      })
    )
  }

  paymentProviderService.setCustomerId(providerSession.customerId)

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
        message: `Error finding customer for provider setup: ${error.message}`,
        retry: false,
      })
  )

  if (customerErr) {
    deps.logger.error(customerErr, {
      context: "Error finding customer for provider setup",
      projectId,
      customerId: metadata.data.customerId,
      provider,
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

  const { err: providerMappingErr } = await wrapResult(
    deps.db
      .insert(customerProviderIds)
      .values({
        id: newId("customer_provider"),
        projectId,
        customerId: customerData.id,
        provider,
        providerCustomerId: providerSession.customerId,
        metadata: buildProviderMetadata({
          subscriptionId: providerSession.subscriptionId,
          defaultPaymentMethodId,
          setupSessionId: sessionId,
        }),
      })
      .onConflictDoUpdate({
        target: [
          customerProviderIds.projectId,
          customerProviderIds.customerId,
          customerProviderIds.provider,
        ],
        set: {
          providerCustomerId: providerSession.customerId,
          metadata: buildProviderMetadata({
            subscriptionId: providerSession.subscriptionId,
            defaultPaymentMethodId,
            setupSessionId: sessionId,
          }),
        },
      }),
    (error) =>
      new FetchError({
        message: `Error updating provider mapping for setup: ${error.message}`,
        retry: false,
      })
  )

  if (providerMappingErr) {
    deps.logger.error(providerMappingErr, {
      context: "Error updating provider mapping for setup",
      projectId,
      customerId: customerData.id,
      provider,
    })

    return Err(providerMappingErr)
  }

  return Ok({
    redirectUrl: metadata.data.successUrl,
  })
}
