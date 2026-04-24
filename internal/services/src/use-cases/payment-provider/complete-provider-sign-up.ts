import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { customerProviderIds, customers } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { PaymentProvider } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { toErrorContext } from "../../utils/log-context"

type CompleteProviderSignUpDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  waitUntil: (promise: Promise<unknown>) => void
}

type CompleteProviderSignUpInput = {
  projectId: string
  sessionId: string
  provider: PaymentProvider
}

type CompleteProviderSignUpOutput = {
  redirectUrl: string
}

const providerSignUpMetadataSchema = z.object({
  customerSessionId: z.string().describe("The unprice customer session id"),
  successUrl: z.string().url().describe("The success url"),
  cancelUrl: z.string().url().describe("The cancel url"),
})

function buildProviderMetadata({
  subscriptionId,
  defaultPaymentMethodId,
  customerSessionId,
}: {
  subscriptionId: string | null
  defaultPaymentMethodId: string | null
  customerSessionId: string
}) {
  return {
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(defaultPaymentMethodId ? { defaultPaymentMethodId } : {}),
    customerSessionId,
  }
}

function isExternalIdConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const dbError = error as {
    code?: string
    constraint?: string
    message?: string
  }

  return (
    dbError.code === "23505" &&
    (dbError.constraint === "cp_external_id_idx" ||
      dbError.message?.includes("cp_external_id_idx") ||
      dbError.message?.includes("external_id") ||
      false)
  )
}

export async function completeProviderSignUp(
  deps: CompleteProviderSignUpDeps,
  input: CompleteProviderSignUpInput
): Promise<Result<CompleteProviderSignUpOutput, FetchError | UnPriceCustomerError>> {
  const { projectId, sessionId, provider } = input

  deps.logger.set({
    business: {
      operation: "payment_provider.complete_signup",
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

  const metadata = providerSignUpMetadataSchema.safeParse(providerSession.metadata)

  if (!metadata.success) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: `Invalid metadata for provider sign up: ${metadata.error.message}`,
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

  const { val: customerSession, err: customerSessionErr } = await wrapResult(
    deps.db.query.customerSessions.findFirst({
      where: (session, { and, eq }) => and(eq(session.id, metadata.data.customerSessionId)),
    }),
    (error) =>
      new FetchError({
        message: `Error loading customer session for provider sign up: ${error.message}`,
        retry: false,
      })
  )

  if (customerSessionErr) {
    deps.logger.error(customerSessionErr, {
      context: "Error loading customer session for provider sign up",
      projectId,
      customerSessionId: metadata.data.customerSessionId,
      provider,
    })

    return Err(customerSessionErr)
  }

  if (!customerSession) {
    return Err(
      new UnPriceCustomerError({
        code: "CUSTOMER_SESSION_NOT_FOUND",
        message: "Customer session not found",
      })
    )
  }

  let customerUnprice: {
    id: string
    projectId: string
  } | null = null

  try {
    customerUnprice = await deps.db
      .insert(customers)
      .values({
        id: customerSession.customer.id,
        projectId: customerSession.customer.projectId,
        externalId: customerSession.customer.externalId,
        name: customerSession.customer.name ?? "",
        email: customerSession.customer.email ?? "",
        defaultCurrency: customerSession.customer.currency,
        active: true,
        timezone: customerSession.customer.timezone,
        metadata: customerSession.customer.metadata,
      })
      .onConflictDoUpdate({
        target: [customers.id, customers.projectId],
        set: {
          externalId: customerSession.customer.externalId,
          name: customerSession.customer.name ?? "",
          email: customerSession.customer.email ?? "",
          defaultCurrency: customerSession.customer.currency,
          active: true,
          timezone: customerSession.customer.timezone,
          metadata: customerSession.customer.metadata,
        },
      })
      .returning()
      .then((rows) => rows.at(0) ?? null)
  } catch (error) {
    if (isExternalIdConflictError(error)) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_EXTERNAL_ID_CONFLICT",
          message: "External customer id already exists for this project",
        })
      )
    }

    deps.logger.error(error, {
      context: "Error upserting customer for provider sign up",
      projectId,
      customerSessionId: customerSession.id,
      provider,
    })

    return Err(
      new FetchError({
        message: `Error upserting customer for provider sign up: ${(error as Error).message}`,
        retry: false,
      })
    )
  }

  if (!customerUnprice) {
    return Err(
      new UnPriceCustomerError({
        code: "CUSTOMER_NOT_CREATED",
        message: "Failed to upsert customer",
      })
    )
  }

  const { err: providerMappingErr } = await wrapResult(
    deps.db
      .insert(customerProviderIds)
      .values({
        id: newId("customer_provider"),
        projectId,
        customerId: customerUnprice.id,
        provider,
        providerCustomerId: providerSession.customerId,
        metadata: buildProviderMetadata({
          subscriptionId: providerSession.subscriptionId,
          defaultPaymentMethodId,
          customerSessionId: customerSession.id,
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
            customerSessionId: customerSession.id,
          }),
        },
      }),
    (error) =>
      new FetchError({
        message: `Error upserting customer provider mapping: ${error.message}`,
        retry: false,
      })
  )

  if (providerMappingErr) {
    deps.logger.error(providerMappingErr, {
      context: "Error upserting customer provider mapping",
      projectId,
      customerId: customerUnprice.id,
      provider,
    })
    return Err(providerMappingErr)
  }

  const { err: createSubscriptionErr, val: subscriptionData } =
    await deps.services.subscriptions.createSubscription({
      projectId: customerSession.customer.projectId,
      input: {
        customerId: customerUnprice.id,
      },
    })

  if (createSubscriptionErr) {
    return Err(
      new UnPriceCustomerError({
        code: "SUBSCRIPTION_NOT_CREATED",
        message: createSubscriptionErr.message,
      })
    )
  }

  const { err: createPhaseErr } = await deps.services.subscriptions.createPhase({
    input: {
      startAt: Date.now(),
      planVersionId: customerSession.planVersion.id,
      config: customerSession.planVersion.config,
      paymentProvider: provider,
      paymentMethodId: defaultPaymentMethodId,
      subscriptionId: subscriptionData.id,
      customerId: customerUnprice.id,
      paymentMethodRequired: customerSession.planVersion.paymentMethodRequired,
    },
    projectId,
    db: deps.db,
    now: Date.now(),
  })

  if (createPhaseErr) {
    return Err(
      new UnPriceCustomerError({
        code: "PHASE_NOT_CREATED",
        message: createPhaseErr.message,
      })
    )
  }

  deps.waitUntil(
    deps.analytics.ingestEvents({
      action: "signup",
      version: "1",
      session_id: customerSession.metadata?.sessionId ?? "",
      project_id: projectId,
      timestamp: new Date().toISOString(),
      payload: {
        customer_id: customerUnprice.id,
        plan_version_id: customerSession.planVersion.id,
        page_id: customerSession.metadata?.pageId ?? "",
        status: "signup_success",
      },
    })
  )

  return Ok({
    redirectUrl: metadata.data.successUrl,
  })
}
