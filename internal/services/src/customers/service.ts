import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { customerSessions, customers, subscriptions } from "@unprice/db/schema"
import { AesGCM, newId } from "@unprice/db/utils"
import type {
  Customer,
  CustomerPaymentMethod,
  CustomerSignUp,
  PaymentProvider,
  Plan,
  PlanVersion,
  Project,
  SubscriptionCache,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import { env } from "../../env"
import type { CacheNamespaces, CustomerCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import { PaymentProviderService } from "../payment-provider/service"
import { SubscriptionService } from "../subscriptions/service"
import { retry } from "../utils/retry"
import { UnPriceCustomerError } from "./errors"

type SignUpContext = {
  input: CustomerSignUp
  projectId: string
  planVersion: PlanVersion & { project: Project; plan: Plan }
  pageId: string | null
  customerId: string
  successUrl: string
  cancelUrl: string
}

export class CustomerService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
  }

  /**
   * Gets the active subscription data from the database
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param now - Current time
   * @returns Active subscription data
   */
  private async getActiveSubscriptionData({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<SubscriptionCache | null> {
    const subscription = await this.db.query.subscriptions
      .findFirst({
        with: {
          customer: {
            columns: {
              active: true,
            },
          },
          project: {
            columns: {
              enabled: true,
            },
          },
          phases: {
            with: {
              planVersion: true,
            },
            where: (phase, { and, or, isNull, gte, lte }) =>
              and(lte(phase.startAt, now), or(isNull(phase.endAt), gte(phase.endAt, now))),
            limit: 1,
          },
        },
        where: and(
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.projectId, projectId)
        ),
      })
      .then((res) => {
        if (!res) {
          return null
        }

        return {
          ...res,
          activePhase: res.phases[0] ?? null,
        }
      })
      .catch((e) => {
        this.logger.error("error getting getActiveSubscriptionData from db", {
          error: e.message,
        })

        return null
      })

    // return explicitly null to avoid cache miss
    // this is useful to avoid cache revalidation on keys that don't exist
    if (!subscription) {
      return null
    }

    return subscription as SubscriptionCache
  }

  /**
   * Gets the customer data from the database
   * @param customerId - Customer id
   * @returns Customer data
   */
  private async getCustomerData(customerId: string): Promise<CustomerCache | null> {
    const customer = await this.db.query.customers.findFirst({
      with: {
        project: {
          with: {
            workspace: true,
          },
        },
      },
      where: (customer, { eq }) => eq(customer.id, customerId),
    })

    if (!customer) {
      return null
    }

    return customer
  }

  /**
   * Gets the customer data from the database
   * @param customerId - Customer id
   * @param opts - Options
   * @returns Customer data
   */
  public async getCustomer(
    customerId: string,
    opts?: {
      skipCache: boolean
    }
  ): Promise<Result<CustomerCache | null, FetchError | UnPriceCustomerError>> {
    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getCustomer", {
        customerId,
      })
    }

    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getCustomerData(customerId),
          (err) =>
            new FetchError({
              message: `unable to query for getCustomerData, ${err.message}`,
              retry: false,
            })
        )
      : await retry(
          3,
          async () => this.cache.customer.swr(customerId, () => this.getCustomerData(customerId)),
          (attempt, err) => {
            this.logger.warn("Failed to fetch getCustomerData data from cache, retrying...", {
              customerId: customerId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting getCustomerData", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: `unable to query db for getCustomerData, ${err.message}`,
          retry: false,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    return Ok(val)
  }

  /**
   * Gets the active subscription for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param now - Current time
   * @param opts - Options
   * @returns Active subscription
   */
  public async getActiveSubscription({
    customerId,
    projectId,
    now,
    opts,
  }: {
    customerId: string
    projectId: string
    now: number
    opts?: {
      skipCache: boolean
    }
  }): Promise<Result<SubscriptionCache, FetchError | UnPriceCustomerError>> {
    const cacheKey = `${projectId}:${customerId}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getActiveSubscription", {
        customerId,
        projectId,
      })
    }

    // swr handle cache stampede and other problems for us :)
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getActiveSubscriptionData({
            customerId,
            projectId,
            now,
          }),
          (err) =>
            new FetchError({
              message: `unable to query db for getActiveSubscriptionData, ${err.message}`,
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                method: "getActiveSubscription",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerSubscription.swr(cacheKey, () =>
              this.getActiveSubscriptionData({
                customerId,
                projectId,
                now,
              })
            ),
          (attempt, err) => {
            this.logger.warn(
              "Failed to fetch getActiveSubscriptionData data from cache, retrying...",
              {
                customerId: customerId,
                attempt,
                error: err.message,
              }
            )
          }
        )

    if (err) {
      this.logger.error("error getting customer subscription", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: false,
          cause: err,
        })
      )
    }

    if (opts?.skipCache) {
      // set the cache to null to avoid cache miss if the subscription is not found
      this.waitUntil(this.cache.customerSubscription.set(cacheKey, val ?? null))
    }

    if (!val) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription not found or is not active for this customer",
        })
      )
    }

    if (val.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_ACTIVE",
          message: "subscription is not active",
        })
      )
    }

    if (!val.activePhase) {
      return Err(
        new UnPriceCustomerError({
          code: "SUBSCRIPTION_NOT_FOUND",
          message: "subscription doesn't have an active phase",
        })
      )
    }

    if (val.project.enabled === false) {
      return Err(
        new UnPriceCustomerError({
          code: "PROJECT_DISABLED",
          message: "project is disabled",
        })
      )
    }

    if (val.customer.active === false) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_DISABLED",
          message: "customer is disabled",
        })
      )
    }

    return Ok(val)
  }

  public async invalidateAccessControlList(customerId: string, projectId: string): Promise<void> {
    await this.cache.accessControlList.remove(`${projectId}:${customerId}`)
  }

  /**
   * Updates the access control list in the cache
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param updates - Updates to the ACL
   * @returns void
   */
  public async updateAccessControlList(params: {
    customerId: string
    projectId: string
    updates: Partial<NonNullable<CacheNamespaces["accessControlList"]>>
  }): Promise<void> {
    const cacheKey = `${params.projectId}:${params.customerId}`
    const { val: currentAcl } = await this.cache.accessControlList.get(cacheKey)

    // If not in cache, we don't set it to avoid partial state.
    // The next getAccessControlList call will fetch the full fresh state from DB.
    if (!currentAcl) {
      // set only the updates
      await this.cache.accessControlList.set(cacheKey, {
        customerUsageLimitReached: params.updates.customerUsageLimitReached ?? null,
        customerDisabled: params.updates.customerDisabled ?? null,
        subscriptionStatus: params.updates.subscriptionStatus ?? null,
      })
      return
    }

    const newAcl = {
      customerUsageLimitReached:
        params.updates.customerUsageLimitReached ?? currentAcl.customerUsageLimitReached,
      customerDisabled: params.updates.customerDisabled ?? currentAcl.customerDisabled,
      subscriptionStatus: params.updates.subscriptionStatus ?? currentAcl.subscriptionStatus,
    }

    await this.cache.accessControlList.set(cacheKey, newAcl)
  }

  /**
   * Gets the payment provider for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param provider - Payment provider
   * @returns Payment provider
   */
  public async getPaymentProvider({
    customerId,
    projectId,
    provider,
  }: {
    customerId?: string
    projectId: string
    provider: PaymentProvider
  }): Promise<Result<PaymentProviderService, FetchError | UnPriceCustomerError>> {
    let customerData: Customer | undefined

    // validate customer if provided
    if (customerId) {
      customerData = await this.db.query.customers.findFirst({
        where: (customer, { and, eq }) => and(eq(customer.id, customerId)),
      })

      if (!customerData) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_NOT_FOUND",
            message: "Customer not found",
          })
        )
      }
    }

    // get config payment provider
    const config = await this.db.query.paymentProviderConfig
      .findFirst({
        where: (config, { and, eq }) =>
          and(
            eq(config.projectId, projectId),
            eq(config.paymentProvider, provider),
            eq(config.active, true)
          ),
      })
      .catch((e) => {
        this.logger.error("error getting payment provider config", {
          error: e.message,
          customerId,
          projectId,
          provider,
        })

        throw e
      })

    if (!config) {
      return Err(
        new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)

    const decryptedKey = await aesGCM.decrypt({
      iv: config.keyIv,
      ciphertext: config.key,
    })

    const paymentProviderService = new PaymentProviderService({
      providerCustomerId: customerData?.stripeCustomerId ?? undefined,
      logger: this.logger,
      paymentProvider: provider,
      token: decryptedKey,
    })

    return Ok(paymentProviderService)
  }

  /**
   * Validates the payment method status for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param paymentProvider - Optional payment provider
   * @param requiredPaymentMethod - Whether payment method is required
   * @returns Payment method validation result
   */
  public async validatePaymentMethod({
    customerId,
    projectId,
    paymentProvider,
    requiredPaymentMethod = false,
  }: {
    customerId: string
    projectId: string
    paymentProvider?: PaymentProvider
    requiredPaymentMethod?: boolean
  }): Promise<
    Result<
      {
        paymentMethodId: string | null
        requiredPaymentMethod: boolean
      },
      FetchError | UnPriceCustomerError
    >
  > {
    // If payment method is not required or no provider, return early
    if (!requiredPaymentMethod || !paymentProvider) {
      return Ok({
        paymentMethodId: null,
        requiredPaymentMethod: false,
      })
    }

    const { val: paymentProviderService, err: paymentProviderErr } = await this.getPaymentProvider({
      customerId,
      projectId,
      provider: paymentProvider,
    })

    if (paymentProviderErr) {
      return Err(paymentProviderErr)
    }

    const { err: paymentMethodErr, val: paymentMethodId } =
      await paymentProviderService.getDefaultPaymentMethodId()

    if (paymentMethodErr) {
      this.logger.error(
        `Payment validation failed: ${paymentMethodErr.message} for project ${projectId} and payment provider ${paymentProvider}`
      )
      return Err(
        new FetchError({
          message: paymentMethodErr.message,
          retry: false,
        })
      )
    }

    if (requiredPaymentMethod && !paymentMethodId?.paymentMethodId) {
      this.logger.error(
        `Required payment method not found for project ${projectId} and payment provider ${paymentProvider}`
      )
      return Err(
        new FetchError({
          message: "Required payment method not found",
          retry: false,
        })
      )
    }

    return Ok({
      paymentMethodId: paymentMethodId.paymentMethodId,
      requiredPaymentMethod: true,
    })
  }

  /**
   * Gets the payment methods for a customer
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param provider - Payment provider
   * @returns Payment methods
   */
  private async getPaymentMethodsData({
    customerId,
    projectId,
    provider,
  }: {
    customerId: string
    projectId: string
    provider: PaymentProvider
  }): Promise<CustomerPaymentMethod[]> {
    const { val: paymentProviderService, err } = await this.getPaymentProvider({
      customerId,
      projectId,
      provider,
    })

    if (err) {
      return []
    }

    try {
      const customerId = paymentProviderService.getCustomerId()

      // if no customer id, return empty array
      if (!customerId) {
        return []
      }

      const { err, val } = await paymentProviderService.listPaymentMethods({
        limit: 5,
      })

      if (err) {
        this.logger.error("payment provider error", {
          customerId,
          projectId,
          provider,
          error: err.message,
        })
        return []
      }

      return val
    } catch (err) {
      const error = err as Error

      this.logger.error("payment provider error", {
        customerId,
        projectId,
        provider,
        error: error.message,
      })
      return []
    }
  }

  /**
   * Gets the payment methods for a customer
   * @param customerId - Customer id
   * @param provider - Payment provider
   * @param projectId - Project id
   * @param opts - Options
   * @returns Payment methods
   */
  public async getPaymentMethods({
    customerId,
    provider,
    projectId,
    opts,
  }: {
    customerId: string
    provider: PaymentProvider
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
    }
  }): Promise<Result<CustomerPaymentMethod[], FetchError | UnPriceCustomerError>> {
    // first try to get the payment methods from cache, if not found try to get it from DO,
    const { val, err } = opts?.skipCache
      ? await wrapResult(
          this.getPaymentMethodsData({
            customerId,
            provider,
            projectId,
          }),
          (err) =>
            new FetchError({
              message: "unable to query payment methods from db",
              retry: false,
              context: {
                error: err.message,
                url: "",
                customerId: customerId,
                provider: provider,
                method: "getPaymentMethods",
              },
            })
        )
      : await retry(
          3,
          async () =>
            this.cache.customerPaymentMethods.swr(`${customerId}:${provider}`, () =>
              this.getPaymentMethodsData({
                customerId,
                provider,
                projectId,
              })
            ),
          (attempt, err) => {
            this.logger.warn("Failed to fetch payment methods data from cache, retrying...", {
              customerId: customerId,
              attempt,
              error: err.message,
            })
          }
        )

    if (err) {
      this.logger.error("error getting payment methods", {
        error: err.message,
      })

      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    if (!val) {
      return Ok([])
    }

    return Ok(val)
  }

  /**
   * Signs up a customer for a project
   * @param opts - Options
   * @returns Sign up result
   */
  public async signUp(opts: {
    input: CustomerSignUp
    projectId: string
  }): Promise<
    Result<
      { success: boolean; url: string; error?: string; customerId: string },
      UnPriceCustomerError | FetchError
    >
  > {
    const { input, projectId } = opts

    // Step 1: Resolve the Plan Version (Pure Logic)
    const planResolution = await this.resolvePlanVersion({
      input,
      projectId,
    })

    if (planResolution.err) {
      return Err(planResolution.err)
    }

    const { planVersion, pageId } = planResolution.val
    const customerId = newId("customer")
    const successUrl = input.successUrl.replace("{CUSTOMER_ID}", customerId)

    // Step 2: Prepare the Customer Context
    const context: SignUpContext = {
      projectId,
      planVersion,
      pageId,
      input,
      customerId,
      successUrl,
      cancelUrl: input.cancelUrl,
    }

    // Step 3: Branch Logic
    if (planVersion.paymentMethodRequired) {
      return this.handlePaymentRequiredFlow(context)
    }

    return this.handleDirectProvisioningFlow(context)
  }

  /**
   * Helper: Encapsulates all the "Plan Guessing" logic
   */
  private async resolvePlanVersion(opts: {
    input: CustomerSignUp
    projectId: string
  }): Promise<
    Result<
      { planVersion: PlanVersion & { project: Project; plan: Plan }; pageId: string | null },
      UnPriceCustomerError
    >
  > {
    const { input, projectId } = opts
    const { planVersionId, defaultCurrency, planSlug, sessionId, billingInterval } = input

    let planVersion: (PlanVersion & { project: Project; plan: Plan }) | null = null
    let pageId: string | null = null

    if (sessionId) {
      // if session id is provided, we need to get the plan version from the session
      // get the session from analytics
      const data = await this.analytics.getPlanClickBySessionId({
        session_id: sessionId,
        action: "plan_click",
      })

      const session = data.data.at(0)

      if (!session) {
        return Err(
          new UnPriceCustomerError({
            code: "PLAN_VERSION_NOT_FOUND",
            message: "Session not found",
          })
        )
      }

      pageId = session.payload.page_id

      planVersion = await this.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(eq(version.id, session.payload.plan_version_id), eq(version.projectId, projectId)),
        })
        .then((data) => data ?? null)
    } else if (planVersionId) {
      planVersion = await this.db.query.versions
        .findFirst({
          with: {
            project: true,
            plan: true,
          },
          where: (version, { eq, and }) =>
            and(
              eq(version.id, planVersionId),
              eq(version.projectId, projectId),
              // filter by currency if provided
              defaultCurrency ? eq(version.currency, defaultCurrency) : undefined
            ),
        })
        .then((data) => data ?? null)
    } else if (planSlug) {
      // find the plan version by the plan slug
      const plan = await this.db.query.plans
        .findFirst({
          with: {
            versions: {
              with: {
                project: true,
                plan: true,
              },
              where: (version, { eq, and }) =>
                and(
                  // filter by latest version
                  eq(version.latest, true),
                  // filter by project
                  eq(version.projectId, projectId),
                  // filter by currency if provided
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

          // filter by billing interval if provided
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

    // if no plan version is provided, we use the default plan
    if (!planVersion) {
      // if no plan version is provided, we use the default plan
      const defaultPlan = await this.db.query.plans.findFirst({
        where: (plan, { eq, and }) =>
          and(eq(plan.projectId, projectId), eq(plan.defaultPlan, true)),
      })

      if (!defaultPlan) {
        return Err(
          new UnPriceCustomerError({
            code: "NO_DEFAULT_PLAN_FOUND",
            message: "Default plan not found, provide a plan version id, slug or session id",
          })
        )
      }

      planVersion = await this.db.query.versions
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

    // validate the currency if provided
    if (currency !== planVersion.currency) {
      return Err(
        new UnPriceCustomerError({
          code: "CURRENCY_MISMATCH",
          message:
            "Currency mismatch, the project default currency does not match the plan version currency",
        })
      )
    }

    return Ok({ planVersion, pageId })
  }

  /**
   * Helper: Handles the external Payment Provider interaction
   */
  private async handlePaymentRequiredFlow(
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

    // For the main project we use the default key
    // get config payment provider
    const configPaymentProvider = await this.db.query.paymentProviderConfig.findFirst({
      where: (config, { and, eq }) =>
        and(
          eq(config.projectId, projectId),
          eq(config.paymentProvider, paymentProvider),
          eq(config.active, true)
        ),
    })

    if (!configPaymentProvider) {
      return Err(
        new UnPriceCustomerError({
          code: "PAYMENT_PROVIDER_CONFIG_NOT_FOUND",
          message: "Payment provider config not found or not active",
        })
      )
    }

    const aesGCM = await AesGCM.withBase64Key(env.ENCRYPTION_KEY)

    const decryptedKey = await aesGCM.decrypt({
      iv: configPaymentProvider.keyIv,
      ciphertext: configPaymentProvider.key,
    })

    const paymentProviderService = new PaymentProviderService({
      logger: this.logger,
      paymentProvider: paymentProvider,
      token: decryptedKey,
    })

    // create a session with the data of the customer, the plan version and the success and cancel urls
    // pass the session id to stripe metadata and then once the customer adds a payment method, we call our api to create the subscription
    const customerSessionId = newId("customer_session")
    const customerSession = await this.db
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

    // send event to analytics for tracking conversions
    this.waitUntil(
      this.analytics.ingestEvents({
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

  /**
   * Helper: Handles the Atomic Database Transaction
   */
  private async handleDirectProvisioningFlow(
    context: SignUpContext
  ): Promise<
    Result<
      { success: boolean; url: string; error?: string; customerId: string },
      UnPriceCustomerError | FetchError
    >
  > {
    const { input, projectId, planVersion, customerId, pageId, successUrl, cancelUrl } = context
    const { email, name, config, timezone, metadata } = input

    const currency = input.defaultCurrency ?? planVersion.project.defaultCurrency

    try {
      await this.db.transaction(async (trx) => {
        const newCustomer = await trx
          .insert(customers)
          .values({
            id: customerId,
            name: name ?? email,
            email: email,
            projectId: projectId,
            defaultCurrency: currency,
            timezone: timezone ?? planVersion.project.timezone,
            active: true,
            metadata: metadata,
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

        const subscriptionService = new SubscriptionService({
          logger: this.logger,
          analytics: this.analytics,
          waitUntil: this.waitUntil,
          cache: this.cache,
          metrics: this.metrics,
          db: this.db,
        })

        const { err, val: newSubscription } = await subscriptionService.createSubscription({
          input: {
            customerId: newCustomer.id,
            projectId: projectId,
            timezone: timezone ?? planVersion.project.timezone,
          },
          projectId: projectId,
          db: trx,
        })

        if (err) {
          this.logger.error("Error creating subscription", {
            error: err.message,
          })

          trx.rollback()
          throw err
        }

        // create the phase
        const { err: createPhaseErr } = await subscriptionService.createPhase({
          input: {
            planVersionId: planVersion.id,
            startAt: Date.now(),
            config: config,
            paymentMethodRequired: planVersion.paymentMethodRequired,
            customerId: newCustomer.id,
            subscriptionId: newSubscription.id,
          },
          projectId: projectId,
          db: trx,
          now: Date.now(),
        })

        if (createPhaseErr) {
          trx.rollback()

          return Err(
            new UnPriceCustomerError({
              code: "PHASE_NOT_CREATED",
              message: "Error creating phase",
            })
          )
        }

        return { newCustomer, newSubscription }
      })

      // send event to analytics for tracking conversions
      this.waitUntil(
        this.analytics.ingestEvents({
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
      const err = error as Error

      return Ok({
        success: false,
        url: cancelUrl,
        error: `Error while signing up: ${err.message}`,
        customerId: "",
      })
    }
  }

  // TODO: to implement
  // signout means cancel all subscriptions and deactivate the customer
  // cancel all entitlements
  public async signOut(opts: {
    customerId: string
    projectId: string
  }): Promise<Result<{ success: boolean; message?: string }, UnPriceCustomerError | FetchError>> {
    const { customerId, projectId } = opts

    // cancel all subscriptions
    const customerSubs = await this.db.query.subscriptions.findMany({
      where: (subscription, { eq, and }) =>
        and(eq(subscription.customerId, customerId), eq(subscription.projectId, projectId)),
    })

    // all this should be in a transaction
    await this.db.transaction(async (tx) => {
      const cancelSubs = await Promise.all(
        customerSubs.map(async () => {
          // TODO: cancel the subscription
          return true
        })
      )
        .catch((err) => {
          return Err(
            new FetchError({
              message: err.message,
              retry: false,
            })
          )
        })
        .then(() => true)

      if (!cancelSubs) {
        return Err(
          new UnPriceCustomerError({
            code: "SUBSCRIPTION_NOT_CANCELED",
            message: "Error canceling subscription",
          })
        )
      }

      // Deactivate the customer
      await tx
        .update(customers)
        .set({
          active: false,
        })
        .where(eq(customers.id, customerId))
        .catch((err) => {
          return Err(
            new FetchError({
              message: err.message,
              retry: false,
            })
          )
        })
    })

    // Invalidate the ACL cache so the next request fetches the disabled status
    await this.invalidateAccessControlList(customerId, projectId)

    return Ok({
      success: true,
    })
  }
}
