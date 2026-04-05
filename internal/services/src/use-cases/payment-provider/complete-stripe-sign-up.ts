import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { toErrorContext } from "../../utils/log-context"

type CompleteStripeSignUpDeps = {
  services: Pick<ServiceContext, "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: platform-specific promise handler
  waitUntil: (promise: Promise<any>) => void
}

type CompleteStripeSignUpInput = {
  projectId: string
  sessionId: string
}

type CompleteStripeSignUpOutput = {
  redirectUrl: string
}

const stripeSignUpMetadataSchema = z.object({
  customerSessionId: z.string().describe("The unprice customer session id"),
  successUrl: z.string().url().describe("The success url"),
  cancelUrl: z.string().url().describe("The cancel url"),
})

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

export async function completeStripeSignUp(
  deps: CompleteStripeSignUpDeps,
  input: CompleteStripeSignUpInput
): Promise<Result<CompleteStripeSignUpOutput, FetchError | UnPriceCustomerError>> {
  const { projectId, sessionId } = input

  deps.logger.set({
    business: {
      operation: "payment_provider.complete_stripe_signup",
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

  const metadata = stripeSignUpMetadataSchema.safeParse(stripeSession.metadata)

  if (!metadata.success) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: `Invalid metadata for stripe sign up: ${metadata.error.message}`,
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

  const { val: customerSession, err: customerSessionErr } = await wrapResult(
    deps.db.query.customerSessions.findFirst({
      where: (session, { and, eq }) => and(eq(session.id, metadata.data.customerSessionId)),
    }),
    (error) =>
      new FetchError({
        message: `Error loading customer session for stripe sign up: ${error.message}`,
        retry: false,
      })
  )

  if (customerSessionErr) {
    deps.logger.error("Error loading customer session for stripe sign up", {
      error: toErrorContext(customerSessionErr),
      projectId,
      customerSessionId: metadata.data.customerSessionId,
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
        stripeCustomerId: stripeSession.customerId,
        externalId: customerSession.customer.externalId,
        name: customerSession.customer.name ?? "",
        email: customerSession.customer.email ?? "",
        defaultCurrency: customerSession.customer.currency,
        active: true,
        timezone: customerSession.customer.timezone,
        metadata: {
          stripeSubscriptionId: stripeSession.subscriptionId ?? "",
          stripeDefaultPaymentMethodId: defaultPaymentMethodId ?? "",
        },
      })
      .onConflictDoUpdate({
        target: [customers.id, customers.projectId],
        set: {
          stripeCustomerId: stripeSession.customerId,
          externalId: customerSession.customer.externalId,
          name: customerSession.customer.name ?? "",
          email: customerSession.customer.email ?? "",
          defaultCurrency: customerSession.customer.currency,
          active: true,
          timezone: customerSession.customer.timezone,
          metadata: {
            stripeSubscriptionId: stripeSession.subscriptionId ?? "",
            stripeDefaultPaymentMethodId: defaultPaymentMethodId ?? "",
          },
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

    deps.logger.error("Error upserting customer for stripe sign up", {
      error: toErrorContext(error),
      projectId,
      customerSessionId: customerSession.id,
    })

    return Err(
      new FetchError({
        message: `Error upserting customer for stripe sign up: ${(error as Error).message}`,
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
