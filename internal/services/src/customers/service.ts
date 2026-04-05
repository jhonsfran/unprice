import type { Analytics } from "@unprice/analytics"
import { type Database, and, count, eq, getTableColumns, ilike, or } from "@unprice/db"
import { customers, subscriptions } from "@unprice/db/schema"
import { withDateFilters, withPagination } from "@unprice/db/utils"
import type {
  Customer,
  CustomerPaymentMethod,
  PaymentProvider,
  SubscriptionCache,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { CacheNamespaces, CustomerCache, CustomersProjectCache } from "../cache"
import type { Cache } from "../cache/service"
import type { Metrics } from "../metrics"
import type { PaymentProviderResolver } from "../payment-provider/resolver"
import type { PaymentProviderService } from "../payment-provider/service"
import { cachedQuery } from "../utils/cached-query"
import { toErrorContext } from "../utils/log-context"
import { UnPriceCustomerError } from "./errors"

export class CustomerService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  private readonly paymentProviderResolver: PaymentProviderResolver
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    paymentProviderResolver,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    paymentProviderResolver: PaymentProviderResolver
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.waitUntil = waitUntil
    this.cache = cache
    this.metrics = metrics
    this.paymentProviderResolver = paymentProviderResolver
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
          error: toErrorContext(e),
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
  private async getCustomersProjectData(projectId: string): Promise<CustomersProjectCache[]> {
    const customers = await this.db.query.customers.findMany({
      columns: {
        id: true,
        name: true,
        email: true,
        projectId: true,
        isMain: true,
      },
      where: (customer, { eq }) => eq(customer.projectId, projectId),
    })

    if (!customers) {
      return []
    }

    return customers
  }

  /**
   * Gets the customer data from the database
   * @param customerId - Customer id
   * @param opts - Options
   * @returns Customer data
   */
  public async getCustomersProject(
    projectId: string,
    opts?: {
      skipCache: boolean
    }
  ): Promise<Result<CustomersProjectCache[], FetchError | UnPriceCustomerError>> {
    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getCustomersProject", {
        projectId,
      })
    }

    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customersProject,
      cacheKey: projectId,
      load: () => this.getCustomersProjectData(projectId),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query for getCustomersProjectData, ${err.message}`,
          retry: false,
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch getCustomersProjectData data from cache, retrying...", {
          projectId: projectId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error("error getting getCustomersProjectData", {
        error: toErrorContext(err),
      })

      return Err(
        new FetchError({
          message: `unable to query db for getCustomersProjectData, ${err.message}`,
          retry: false,
        })
      )
    }

    if (!val) {
      return Ok([])
    }

    return Ok(val)
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

  private async getCustomerByExternalIdData(
    projectId: string,
    externalId: string
  ): Promise<CustomerCache | null> {
    const customer = await this.db.query.customers.findFirst({
      with: {
        project: {
          with: {
            workspace: true,
          },
        },
      },
      where: (customer, { and, eq }) =>
        and(eq(customer.projectId, projectId), eq(customer.externalId, externalId)),
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

    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customer,
      cacheKey: customerId,
      load: () => this.getCustomerData(customerId),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query for getCustomerData, ${err.message}`,
          retry: false,
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch getCustomerData data from cache, retrying...", {
          customerId: customerId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error("error getting getCustomerData", {
        error: toErrorContext(err),
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

    if (val.externalId) {
      const cacheKey = `${val.projectId}:${val.externalId}`
      this.waitUntil(this.cache.customerByExternalId.set(cacheKey, val))
    }

    return Ok(val)
  }

  public async getCustomerByExternalId(
    projectId: string,
    externalId: string,
    opts?: {
      skipCache: boolean
    }
  ): Promise<Result<CustomerCache | null, FetchError | UnPriceCustomerError>> {
    const cacheKey = `${projectId}:${externalId}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getCustomerByExternalId", {
        projectId,
        externalId,
      })
    }

    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customerByExternalId,
      cacheKey,
      load: () => this.getCustomerByExternalIdData(projectId, externalId),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query for getCustomerByExternalIdData, ${err.message}`,
          retry: false,
        }),
      onRetry: (attempt, err) => {
        this.logger.warn(
          "Failed to fetch getCustomerByExternalIdData data from cache, retrying...",
          {
            projectId,
            externalId,
            attempt,
            error: toErrorContext(err),
          }
        )
      },
    })

    if (err) {
      this.logger.error("error getting getCustomerByExternalIdData", {
        error: toErrorContext(err),
      })

      return Err(
        new FetchError({
          message: `unable to query db for getCustomerByExternalIdData, ${err.message}`,
          retry: false,
        })
      )
    }

    if (!val) {
      return Ok(null)
    }

    this.waitUntil(this.cache.customer.set(val.id, val))

    return Ok(val)
  }

  public async getCustomerByIdInProject({
    id,
    projectId,
  }: {
    id: string
    projectId: string
  }): Promise<Result<Customer | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        where: (customer, { eq, and }) =>
          and(eq(customer.projectId, projectId), eq(customer.id, id)),
      }),
      (error) =>
        new FetchError({
          message: `error getting customer by id in project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting customer by id in project", {
        error: toErrorContext(err),
        projectId,
        customerId: id,
      })
      return Err(err)
    }

    return Ok((val as Customer | null) ?? null)
  }

  public async updateCustomerRecord({
    id,
    projectId,
    email,
    description,
    metadata,
    name,
    timezone,
    active,
  }: {
    id: string
    projectId: string
    email?: Customer["email"]
    description?: Customer["description"]
    metadata?: Customer["metadata"]
    name?: Customer["name"]
    timezone?: Customer["timezone"]
    active?: Customer["active"]
  }): Promise<Result<{ state: "not_found" } | { state: "ok"; customer: Customer }, FetchError>> {
    const customerData = await this.db.query.customers.findFirst({
      where: (customer, { eq, and }) => and(eq(customer.id, id), eq(customer.projectId, projectId)),
    })

    if (!customerData?.id) {
      return Ok({
        state: "not_found",
      })
    }

    const { val, err } = await wrapResult(
      this.db
        .update(customers)
        .set({
          ...(email && { email }),
          ...(description && { description }),
          ...(name && { name }),
          ...(metadata && {
            metadata: {
              ...customerData.metadata,
              ...metadata,
            },
          }),
          ...(timezone && { timezone }),
          ...(active !== undefined && { active }),
          updatedAtM: Date.now(),
        })
        .where(and(eq(customers.id, id), eq(customers.projectId, projectId)))
        .returning()
        .then((rows) => rows[0] ?? null),
      (error) =>
        new FetchError({
          message: `error updating customer record: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error updating customer record", {
        error: toErrorContext(err),
        projectId,
        customerId: id,
      })
      return Err(err)
    }

    if (!val) {
      return Err(
        new FetchError({
          message: "Error updating customer",
          retry: false,
        })
      )
    }

    return Ok({
      state: "ok",
      customer: val as Customer,
    })
  }

  public async resolveCustomerId(opts: {
    projectId: string
    customerId?: string
    externalId?: string
  }): Promise<
    Result<{ customerId: string; projectId: string }, FetchError | UnPriceCustomerError>
  > {
    const { projectId, customerId, externalId } = opts

    if (customerId) {
      const { err, val } = await this.getCustomer(customerId)

      if (err) {
        return Err(err)
      }

      if (!val || val.projectId !== projectId) {
        return Err(
          new UnPriceCustomerError({
            code: "CUSTOMER_NOT_FOUND",
            message: "Customer not found",
          })
        )
      }

      return Ok({ customerId: val.id, projectId: val.projectId })
    }

    if (!externalId) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_NOT_FOUND",
          message: "Either customerId or externalId is required",
        })
      )
    }

    const { err, val } = await this.getCustomerByExternalId(projectId, externalId)

    if (err) {
      return Err(err)
    }

    if (!val) {
      return Err(
        new UnPriceCustomerError({
          code: "CUSTOMER_NOT_FOUND",
          message: "Customer not found",
        })
      )
    }

    return Ok({ customerId: val.id, projectId: val.projectId })
  }

  public async customerExistsByEmail({
    projectId,
    email,
  }: {
    projectId: string
    email: string
  }): Promise<Result<boolean, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        columns: {
          id: true,
        },
        where: (customer, { eq, and }) =>
          and(eq(customer.projectId, projectId), eq(customer.email, email)),
      }),
      (error) =>
        new FetchError({
          message: `error checking customer existence by email: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error checking customer existence by email", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok(Boolean(val))
  }

  public async getCustomerByEmail({
    projectId,
    email,
  }: {
    projectId: string
    email: string
  }): Promise<Result<Customer | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        where: (customer, { eq, and }) =>
          and(eq(customer.projectId, projectId), eq(customer.email, email)),
      }),
      (error) =>
        new FetchError({
          message: `error getting customer by email: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting customer by email", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
    }

    return Ok((val as Customer | null) ?? null)
  }

  public async getCustomerSubscriptions({
    customerId,
    projectId,
    now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<unknown | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        with: {
          subscriptions: {
            with: {
              customer: true,
              phases: {
                where: (table, { and, gte, lte, isNull, or }) =>
                  and(lte(table.startAt, now), or(isNull(table.endAt), gte(table.endAt, now))),
                orderBy: (table, { desc }) => [desc(table.startAt)],
                limit: 1,
              },
            },
          },
          invoices: {
            orderBy: (table, { desc }) => [desc(table.dueAt)],
          },
        },
        where: (table, { eq, and }) =>
          and(eq(table.id, customerId), eq(table.projectId, projectId)),
        orderBy: (table, { desc }) => [desc(table.createdAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error getting customer subscriptions: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting customer subscriptions", {
        error: toErrorContext(err),
        customerId,
        projectId,
      })
      return Err(err)
    }

    return Ok(val ?? null)
  }

  public async getCustomerInvoices({
    customerId,
    projectId,
  }: {
    customerId: string
    projectId: string
  }): Promise<Result<unknown | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.customers.findFirst({
        with: {
          invoices: {
            orderBy: (table, { desc }) => [desc(table.dueAt)],
          },
        },
        where: (table, { eq, and }) =>
          and(eq(table.id, customerId), eq(table.projectId, projectId)),
        orderBy: (table, { desc }) => [desc(table.createdAtM)],
      }),
      (error) =>
        new FetchError({
          message: `error getting customer invoices: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting customer invoices", {
        error: toErrorContext(err),
        customerId,
        projectId,
      })
      return Err(err)
    }

    return Ok(val ?? null)
  }

  public async getInvoiceById({
    invoiceId,
    customerId,
    projectId,
  }: {
    invoiceId: string
    customerId: string
    projectId: string
  }): Promise<Result<unknown | null, FetchError>> {
    const { val, err } = await wrapResult(
      this.db.query.invoices.findFirst({
        with: {
          customer: true,
          subscription: true,
          invoiceItems: {
            with: {
              featurePlanVersion: {
                with: {
                  planVersion: {
                    with: {
                      plan: true,
                    },
                  },
                  feature: true,
                },
              },
              billingPeriod: true,
            },
          },
        },
        where: (table, { eq, and }) =>
          and(
            eq(table.id, invoiceId),
            eq(table.customerId, customerId),
            eq(table.projectId, projectId)
          ),
      }),
      (error) =>
        new FetchError({
          message: `error getting invoice by id: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error getting invoice by id", {
        error: toErrorContext(err),
        customerId,
        projectId,
      })
      return Err(err)
    }

    return Ok(val ?? null)
  }

  public async listCustomersByProject({
    projectId,
    page,
    pageSize,
    search,
    from,
    to,
  }: {
    projectId: string
    page: number
    pageSize: number
    search?: string
    from?: number
    to?: number
  }): Promise<Result<{ customers: Customer[]; pageCount: number }, FetchError>> {
    const columns = getTableColumns(customers)
    const filter = `%${search ?? ""}%`
    const expressions = [
      search ? or(ilike(columns.name, filter), ilike(columns.email, filter)) : undefined,
      eq(columns.projectId, projectId),
      eq(columns.isMain, false),
    ]

    const { val, err } = await wrapResult(
      this.db.transaction(async (tx) => {
        const query = tx.select().from(customers).$dynamic()
        const whereQuery = withDateFilters<Customer>(
          expressions,
          columns.createdAtM,
          from ?? null,
          to ?? null
        )

        const data = await withPagination(
          query,
          whereQuery,
          [
            {
              column: columns.createdAtM,
              order: "desc",
            },
          ],
          page,
          pageSize
        )

        const total = await tx
          .select({
            count: count(),
          })
          .from(customers)
          .where(whereQuery)
          .execute()
          .then((res) => res[0]?.count ?? 0)

        return {
          customers: data as Customer[],
          pageCount: Math.ceil(total / pageSize),
        }
      }),
      (error) =>
        new FetchError({
          message: `error listing customers by project: ${error.message}`,
          retry: false,
        })
    )

    if (err) {
      this.logger.error("error listing customers by project", {
        error: toErrorContext(err),
        projectId,
      })
      return Err(err)
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
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customerSubscription,
      cacheKey,
      load: () =>
        this.getActiveSubscriptionData({
          customerId,
          projectId,
          now,
        }),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query db for getActiveSubscriptionData, ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            customerId: customerId,
            method: "getActiveSubscription",
          },
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch getActiveSubscriptionData data from cache, retrying...", {
          customerId: customerId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error("error getting customer subscription", {
        error: toErrorContext(err),
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
        params.updates.customerUsageLimitReached !== undefined
          ? params.updates.customerUsageLimitReached
          : currentAcl.customerUsageLimitReached,
      customerDisabled:
        params.updates.customerDisabled !== undefined
          ? params.updates.customerDisabled
          : currentAcl.customerDisabled,
      subscriptionStatus:
        params.updates.subscriptionStatus !== undefined
          ? params.updates.subscriptionStatus
          : currentAcl.subscriptionStatus,
    }

    // Remove the cache entry first to ensure immediate invalidation,
    // then set the new value. This prevents SWR from serving stale data.
    await this.cache.accessControlList.remove(cacheKey)
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
    return this.paymentProviderResolver.resolve({
      customerId,
      projectId,
      provider,
    })
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
      return Err(
        new FetchError({
          message: paymentMethodErr.message,
          retry: false,
        })
      )
    }

    if (requiredPaymentMethod && !paymentMethodId?.paymentMethodId) {
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
          error: toErrorContext(err),
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
        error: toErrorContext(error),
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
    const cacheKey = `${projectId}:${customerId}:${provider}`

    if (opts?.skipCache) {
      this.logger.debug("skipping cache for getPaymentMethods", {
        customerId,
        projectId,
        provider,
        cacheKey,
      })
    }

    // first try to get the payment methods from cache, if not found try to get it from DO,
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.customerPaymentMethods,
      cacheKey,
      load: () =>
        this.getPaymentMethodsData({
          customerId,
          provider,
          projectId,
        }),
      wrapLoadError: (err) =>
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
        }),
      onRetry: (attempt, err) => {
        this.logger.warn("Failed to fetch payment methods data from cache, retrying...", {
          customerId: customerId,
          attempt,
          error: toErrorContext(err),
        })
      },
    })

    if (err) {
      this.logger.error("error getting payment methods", {
        error: toErrorContext(err),
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
