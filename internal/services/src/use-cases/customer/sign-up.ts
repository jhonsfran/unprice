import type { Analytics } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { customerProviderIds, customerSessions, customers } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import type { CustomerSignUp, Plan, PlanVersion, Project } from "@unprice/db/validators"
import { Err, type FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import { UnPriceCustomerError } from "../../customers/errors"
import { getPaymentProviderCapabilities } from "../../payment-provider/service"
import { activateWalletIfSubscriptionIsActive } from "../subscription/activate-wallet-if-active"

type SignUpDeps = {
  services: Pick<ServiceContext, "plans" | "customers" | "subscriptions">
  db: Database
  logger: Logger
  analytics: Analytics
  waitUntil: (promise: Promise<unknown>) => void
}

type SignUpInput = {
  input: CustomerSignUp
  projectId: string
}

type PlanVersionWithProject = PlanVersion & {
  project: Project
  plan: Plan
}

type SignUpContext = {
  input: CustomerSignUp
  projectId: string
  planVersion: PlanVersionWithProject
  pageId: string | null
  customerId: string
  successUrl: string
  cancelUrl: string
}

function normalizePhaseCreditLine(input: {
  creditLinePolicy?: CustomerSignUp["creditLinePolicy"]
  creditLineAmount?: CustomerSignUp["creditLineAmount"]
}) {
  const creditLinePolicy = input.creditLinePolicy ?? "uncapped"

  return {
    creditLinePolicy,
    creditLineAmount: creditLinePolicy === "uncapped" ? null : (input.creditLineAmount ?? null),
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

async function resolvePlanVersion(
  deps: SignUpDeps,
  opts: SignUpInput
): Promise<
  Result<{ planVersion: PlanVersionWithProject; pageId: string | null }, UnPriceCustomerError>
> {
  const { input, projectId } = opts
  const { planVersionId, defaultCurrency, planSlug, sessionId, billingInterval } = input

  let planVersion: PlanVersionWithProject | null = null
  let pageId: string | null = null

  if (sessionId) {
    deps.logger.set({
      business: {
        operation: "customer.sign_up.resolve_plan",
        project_id: projectId,
      },
    })

    const data = await deps.analytics.getPlanClickBySessionId({
      session_id: sessionId,
      action: "plan_click",
    })

    const session = data.data.at(0)

    if (!session) {
      if (!planVersionId) {
        return Err(
          new UnPriceCustomerError({
            code: "PLAN_VERSION_NOT_FOUND",
            message: "Session not found",
          })
        )
      }

      planVersion = await deps.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(eq(version.id, planVersionId), eq(version.projectId, projectId)),
        })
        .then((data) => data ?? null)
    } else {
      pageId = session.payload.page_id

      planVersion = await deps.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(eq(version.id, session.payload.plan_version_id), eq(version.projectId, projectId)),
        })
        .then((data) => data ?? null)
    }
  } else if (planVersionId) {
    planVersion = await deps.db.query.versions
      .findFirst({
        with: {
          project: true,
          plan: true,
        },
        where: (version, { eq, and }) =>
          and(
            eq(version.id, planVersionId),
            eq(version.projectId, projectId),
            defaultCurrency ? eq(version.currency, defaultCurrency) : undefined
          ),
      })
      .then((data) => data ?? null)
  } else if (planSlug) {
    const plan = await deps.db.query.plans
      .findFirst({
        with: {
          versions: {
            with: {
              project: true,
              plan: true,
            },
            where: (version, { eq, and }) =>
              and(
                eq(version.latest, true),
                eq(version.projectId, projectId),
                defaultCurrency ? eq(version.currency, defaultCurrency) : undefined
              ),
          },
        },
        where: (plan, { eq, and }) => and(eq(plan.projectId, projectId), eq(plan.slug, planSlug)),
      })
      .then((data) => {
        if (!data) {
          return null
        }

        if (billingInterval) {
          const versions = data.versions.filter(
            (version) => version.billingConfig.billingInterval === billingInterval
          )

          return {
            ...data,
            versions: versions ?? [],
          }
        }

        return data
      })

    if (!plan) {
      return Err(
        new UnPriceCustomerError({
          code: "PLAN_VERSION_NOT_FOUND",
          message: "Plan version not found",
        })
      )
    }

    planVersion = plan.versions[0] ?? null
  }

  if (!planVersion) {
    const defaultPlan = await deps.db.query.plans.findFirst({
      where: (plan, { eq, and }) => and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
    })

    if (!defaultPlan) {
      return Err(
        new UnPriceCustomerError({
          code: "NO_DEFAULT_PLAN_FOUND",
          message: "Default plan not found, provide a plan version id, slug or session id",
        })
      )
    }

    planVersion = await deps.db.query.versions
      .findFirst({
        with: {
          project: true,
          plan: true,
        },
        where: (version, { eq, and }) =>
          and(
            eq(version.planId, defaultPlan.id),
            eq(version.latest, true),
            eq(version.status, "published"),
            eq(version.active, true)
          ),
      })
      .then((data) => data ?? null)
  }

  if (!planVersion) {
    return Err(
      new UnPriceCustomerError({
        code: "PLAN_VERSION_NOT_FOUND",
        message: "Plan version not found",
      })
    )
  }

  deps.logger.set({
    business: {
      operation: "customer.sign_up.resolve_plan",
      project_id: projectId,
    },
  })

  if (planVersion.status !== "published") {
    return Err(
      new UnPriceCustomerError({
        code: "PLAN_VERSION_NOT_PUBLISHED",
        message: "Plan version is not published",
      })
    )
  }

  if (planVersion.active === false) {
    return Err(
      new UnPriceCustomerError({
        code: "PLAN_VERSION_NOT_ACTIVE",
        message: "Plan version is not active",
      })
    )
  }

  const planProject = planVersion.project
  const currency = defaultCurrency ?? planProject.defaultCurrency
  const defaultBillingInterval = billingInterval ?? planVersion.billingConfig.billingInterval

  if (
    defaultBillingInterval &&
    planVersion.billingConfig.billingInterval !== defaultBillingInterval
  ) {
    return Err(
      new UnPriceCustomerError({
        code: "BILLING_INTERVAL_MISMATCH",
        message: "Billing interval mismatch",
      })
    )
  }

  if (currency !== planVersion.currency) {
    return Err(
      new UnPriceCustomerError({
        code: "CURRENCY_MISMATCH",
        message: `Currency mismatch, the project default currency does not match the plan version currency: ${currency} !== ${planVersion.currency}`,
      })
    )
  }

  return Ok({ planVersion, pageId })
}

async function handlePaymentRequiredFlow(
  deps: SignUpDeps,
  context: SignUpContext
): Promise<
  Result<
    { success: boolean; url: string; error?: string; customerId: string },
    UnPriceCustomerError | FetchError
  >
> {
  const { input, projectId, planVersion, customerId, pageId, successUrl, cancelUrl } = context
  const { email, name, config, timezone, externalId, metadata } = input
  const paymentProvider = planVersion.paymentProvider
  const paymentRequired = planVersion.paymentMethodRequired
  const currency = input.defaultCurrency ?? planVersion.project.defaultCurrency
  const phaseCreditLine = normalizePhaseCreditLine(input)

  const { err: paymentProviderErr, val: paymentProviderService } =
    await deps.services.customers.getPaymentProvider({
      projectId,
      provider: paymentProvider,
    })

  if (paymentProviderErr) {
    return Err(paymentProviderErr)
  }

  const customerSessionId = newId("customer_session")
  const customerSession = await deps.db
    .insert(customerSessions)
    .values({
      id: customerSessionId,
      customer: {
        id: customerId,
        name: name,
        email: email,
        currency: currency,
        timezone: timezone || planVersion.project.timezone,
        projectId: projectId,
        externalId: externalId,
        metadata: metadata,
      },
      planVersion: {
        id: planVersion.id,
        projectId: projectId,
        config: config,
        creditLinePolicy: phaseCreditLine.creditLinePolicy,
        creditLineAmount: phaseCreditLine.creditLineAmount,
        paymentMethodRequired: paymentRequired,
      },
      metadata: {
        sessionId: input.sessionId ?? undefined,
        pageId: pageId ?? undefined,
      },
    })
    .returning()
    .then((data) => data[0])

  if (!customerSession) {
    return Err(
      new UnPriceCustomerError({
        code: "CUSTOMER_SESSION_NOT_CREATED",
        message: "Error creating customer session",
      })
    )
  }

  const { err, val } = await paymentProviderService.signUp({
    successUrl: successUrl,
    cancelUrl: cancelUrl,
    customerSessionId: customerSession.id,
    customer: {
      id: customerId,
      email: email,
      currency: currency,
      projectId: projectId,
    },
  })

  if (err) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: err.message,
      })
    )
  }

  if (!val) {
    return Err(
      new UnPriceCustomerError({
        code: "PAYMENT_PROVIDER_ERROR",
        message: "Error creating payment provider signup",
      })
    )
  }

  deps.waitUntil(
    deps.analytics.ingestEvents({
      action: "signup",
      version: "1",
      session_id: input.sessionId ?? "",
      project_id: projectId,
      timestamp: new Date().toISOString(),
      payload: {
        customer_id: customerId,
        plan_version_id: planVersion.id,
        page_id: pageId,
        status: "waiting_payment_provider_setup",
      },
    })
  )

  return Ok({
    success: true,
    url: val.url,
    customerId: val.customerId,
  })
}

async function handleDirectProvisioningFlow(
  deps: SignUpDeps,
  context: SignUpContext
): Promise<
  Result<
    { success: boolean; url: string; error?: string; customerId: string },
    UnPriceCustomerError | FetchError
  >
> {
  const { input, projectId, planVersion, customerId, pageId, successUrl, cancelUrl } = context
  const { email, name, config, timezone, metadata, externalId } = input
  const paymentProvider = planVersion.paymentProvider
  const phaseCreditLine = normalizePhaseCreditLine(input)

  const currency = input.defaultCurrency ?? planVersion.project.defaultCurrency
  const customerMetadata = externalId ? { ...metadata, externalId } : metadata

  try {
    const txResult = await deps.db.transaction(async (tx) => {
      const newCustomer = await tx
        .insert(customers)
        .values({
          id: customerId,
          name: name ?? email,
          email: email,
          projectId: projectId,
          defaultCurrency: currency,
          timezone: timezone ?? planVersion.project.timezone,
          active: true,
          externalId: externalId,
          metadata: customerMetadata,
        })
        .returning()
        .then((data) => data[0])

      if (!newCustomer?.id) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_NOT_CREATED",
            message: "Error creating customer",
          })
        )
      }

      // Providers that don't support async payment confirmation (e.g. sandbox)
      // won't go through the redirect-based sign-up flow, so we create the
      // provider mapping here using the internal customer id.
      const providerCaps = getPaymentProviderCapabilities(paymentProvider)
      if (!providerCaps.asyncPaymentConfirmation) {
        await tx.insert(customerProviderIds).values({
          id: newId("customer_provider"),
          projectId,
          customerId: newCustomer.id,
          provider: paymentProvider,
          providerCustomerId: newCustomer.id,
          metadata: {
            setupSessionId: "direct_signup",
          },
        })
      }

      const { err, val: newSubscription } = await deps.services.subscriptions.createSubscription({
        input: {
          customerId: newCustomer.id,
          projectId: projectId,
          timezone: timezone ?? planVersion.project.timezone,
        },
        projectId: projectId,
        db: tx,
      })

      if (err) {
        return Err(
          new UnPriceCustomerError({
            code: "SUBSCRIPTION_NOT_CREATED",
            message: err.message,
          })
        )
      }

      const phaseTimestamp = Date.now()

      const { err: createPhaseErr } = await deps.services.subscriptions.createPhase({
        input: {
          planVersionId: planVersion.id,
          startAt: phaseTimestamp,
          config: config,
          paymentProvider: paymentProvider,
          creditLinePolicy: phaseCreditLine.creditLinePolicy,
          creditLineAmount: phaseCreditLine.creditLineAmount,
          paymentMethodRequired: planVersion.paymentMethodRequired,
          customerId: newCustomer.id,
          subscriptionId: newSubscription.id,
        },
        projectId: projectId,
        db: tx,
        now: phaseTimestamp,
      })

      if (createPhaseErr) {
        return Err(
          new UnPriceCustomerError({
            code: "PHASE_NOT_CREATED",
            message: "Error creating phase",
          })
        )
      }

      deps.logger.set({
        business: {
          operation: "customer.sign_up.provision_customer",
          project_id: projectId,
          customer_id: customerId,
        },
      })

      return Ok({ customerId: newCustomer.id, subscriptionId: newSubscription.id })
    })

    if (txResult.err) {
      return Err(txResult.err)
    }

    await activateWalletIfSubscriptionIsActive(deps, {
      subscriptionId: txResult.val.subscriptionId,
      projectId,
      context:
        "customer signup wallet activation failed; subscription parked in pending_activation",
    })

    deps.waitUntil(
      deps.analytics.ingestEvents({
        action: "signup",
        version: "1",
        session_id: input.sessionId ?? "",
        project_id: projectId,
        timestamp: new Date().toISOString(),
        payload: {
          customer_id: customerId,
          plan_version_id: planVersion.id,
          page_id: pageId,
          status: "signup_success",
        },
      })
    )

    return Ok({
      success: true,
      url: successUrl,
      customerId: customerId,
    })
  } catch (error) {
    if (isExternalIdConflictError(error)) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_EXTERNAL_ID_CONFLICT",
          message: "External customer id already exists for this project",
        })
      )
    }

    const err = error as Error
    return Ok({
      success: false,
      url: cancelUrl,
      error: `Error while signing up: ${err.message}`,
      customerId: "",
    })
  }
}

export async function signUp(
  deps: SignUpDeps,
  opts: SignUpInput
): Promise<
  Result<
    { success: boolean; url: string; error?: string; customerId: string },
    UnPriceCustomerError | FetchError
  >
> {
  const { input, projectId } = opts

  deps.logger.set({
    business: {
      operation: "customer.sign_up",
      project_id: projectId,
    },
  })

  const planResolution = await resolvePlanVersion(deps, opts)

  if (planResolution.err) {
    return Err(planResolution.err)
  }

  const { planVersion, pageId } = planResolution.val

  if (input.externalId) {
    const { err: existingCustomerErr, val: existingCustomer } =
      await deps.services.customers.getCustomerByExternalId(projectId, input.externalId, {
        skipCache: true,
      })

    if (existingCustomerErr) {
      return Err(existingCustomerErr)
    }

    if (existingCustomer) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_EXTERNAL_ID_CONFLICT",
          message: "External customer id already exists for this project",
        })
      )
    }
  }

  const customerId = newId("customer")
  const successUrl = input.successUrl.replace("{CUSTOMER_ID}", customerId)

  const context: SignUpContext = {
    projectId,
    planVersion,
    pageId,
    input,
    customerId,
    successUrl,
    cancelUrl: input.cancelUrl,
  }

  deps.logger.set({
    business: {
      operation: "customer.sign_up.plan_resolved",
      project_id: projectId,
      customer_id: customerId,
    },
  })

  const capabilities = getPaymentProviderCapabilities(planVersion.paymentProvider)

  if (planVersion.paymentMethodRequired && capabilities.asyncPaymentConfirmation) {
    return handlePaymentRequiredFlow(deps, context)
  }

  return handleDirectProvisioningFlow(deps, context)
}
