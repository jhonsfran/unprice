import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq } from "@unprice/db"
import { newId } from "@unprice/db/utils"
import type {
  CurrentUsage,
  CustomerEntitlement,
  CustomerEntitlementExtended,
  Grant,
  InsertCustomerEntitlement,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger, WideEventInput } from "@unprice/logs"
import { formatMoney } from "@unprice/money"
import type { BillingService } from "../billing"
import type { CacheNamespaces } from "../cache/namespaces"
import type { Cache } from "../cache/service"
import type { CustomerService } from "../customers/service"
import type { Metrics } from "../metrics"
import { cachedQuery } from "../utils/cached-query"
import { UnPriceEntitlementError } from "./errors"
import type { GrantsManager } from "./grants"

import { customerEntitlements, customers, subscriptions } from "@unprice/db/schema"

/**
 * Simplified Entitlement Service
 *
 * Strategy:
 * - Keep usage in cache (DO/Redis) for low latency
 * - Smart revalidation: lightweight version check, only reload if changed
 * - All logic encapsulated in service (minimize round-trips)
 * - Buffering support for batch analytics
 */
export class EntitlementService {
  private readonly grantsManager: GrantsManager
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly cache: Cache
  private readonly metrics: Metrics
  private readonly customerService: CustomerService
  private readonly billingService: BillingService

  constructor(opts: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    customerService: CustomerService
    grantsManager: GrantsManager
    billingService: BillingService
  }) {
    this.grantsManager = opts.grantsManager
    this.db = opts.db
    this.logger = opts.logger
    this.analytics = opts.analytics
    this.waitUntil = opts.waitUntil
    this.cache = opts.cache
    this.metrics = opts.metrics
    this.customerService = opts.customerService
    this.billingService = opts.billingService
  }

  /**
   * Helper to add structured entitlement context to wide events.
   * Groups everything under "entitlements" key for clear identification in logs.
   * Keeps only essential information for debugging.
   */
  private addEntitlementContext(context: WideEventInput["entitlements"]) {
    this.logger.set({ entitlements: context })
  }

  private async findCustomerEntitlementBySourceWindow({
    db,
    entitlement,
  }: {
    db: Database
    entitlement: InsertCustomerEntitlement
  }) {
    return db.query.customerEntitlements.findFirst({
      where: (table, { and: andOp, eq: eqOp, isNull }) =>
        andOp(
          eqOp(table.projectId, entitlement.projectId),
          eqOp(table.customerId, entitlement.customerId),
          eqOp(table.featurePlanVersionId, entitlement.featurePlanVersionId),
          entitlement.subscriptionId == null
            ? isNull(table.subscriptionId)
            : eqOp(table.subscriptionId, entitlement.subscriptionId),
          entitlement.subscriptionPhaseId == null
            ? isNull(table.subscriptionPhaseId)
            : eqOp(table.subscriptionPhaseId, entitlement.subscriptionPhaseId),
          entitlement.subscriptionItemId == null
            ? isNull(table.subscriptionItemId)
            : eqOp(table.subscriptionItemId, entitlement.subscriptionItemId),
          eqOp(table.effectiveAt, entitlement.effectiveAt),
          entitlement.expiresAt == null
            ? isNull(table.expiresAt)
            : eqOp(table.expiresAt, entitlement.expiresAt)
        ),
    })
  }

  private async assertNoOverlappingActiveFeatureEntitlement({
    db,
    entitlement,
  }: {
    db: Database
    entitlement: InsertCustomerEntitlement
  }): Promise<Result<void, FetchError | UnPriceEntitlementError>> {
    try {
      const targetFeaturePlanVersion = await db.query.planVersionFeatures.findFirst({
        where: (table, { and: andOp, eq: eqOp }) =>
          andOp(
            eqOp(table.projectId, entitlement.projectId),
            eqOp(table.id, entitlement.featurePlanVersionId)
          ),
      })

      if (!targetFeaturePlanVersion) {
        return Err(
          new UnPriceEntitlementError({
            message: "Feature plan version not found for entitlement",
            context: {
              projectId: entitlement.projectId,
              featurePlanVersionId: entitlement.featurePlanVersionId,
            },
          })
        )
      }

      const overlappingEntitlements = await db.query.customerEntitlements.findMany({
        with: {
          featurePlanVersion: true,
        },
        where: (table, { and: andOp, eq: eqOp, gt, isNull, lt, or }) => {
          const conditions = [
            eqOp(table.projectId, entitlement.projectId),
            eqOp(table.customerId, entitlement.customerId),
            or(isNull(table.expiresAt), gt(table.expiresAt, entitlement.effectiveAt)),
          ]

          if (entitlement.expiresAt !== null && entitlement.expiresAt !== undefined) {
            conditions.push(lt(table.effectiveAt, entitlement.expiresAt))
          }

          return andOp(...conditions)
        },
      })

      const conflictingEntitlement = overlappingEntitlements.find(
        (existing) =>
          existing.featurePlanVersion?.featureId === targetFeaturePlanVersion.featureId &&
          existing.id !== entitlement.id
      )

      if (conflictingEntitlement) {
        return Err(
          new UnPriceEntitlementError({
            message: "Customer already has an active entitlement for this feature",
            context: {
              projectId: entitlement.projectId,
              customerId: entitlement.customerId,
              featureId: targetFeaturePlanVersion.featureId,
              existingCustomerEntitlementId: conflictingEntitlement.id,
              requestedFeaturePlanVersionId: entitlement.featurePlanVersionId,
              requestedEffectiveAt: entitlement.effectiveAt,
              requestedExpiresAt: entitlement.expiresAt ?? null,
            },
          })
        )
      }

      return Ok(undefined)
    } catch (error) {
      this.logger.error(error, {
        context: "Error checking active customer entitlement uniqueness",
        customerId: entitlement.customerId,
        projectId: entitlement.projectId,
        featurePlanVersionId: entitlement.featurePlanVersionId,
      })

      return Err(
        new FetchError({
          message: `Failed to check active customer entitlement uniqueness: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async createCustomerEntitlement(params: {
    entitlement: InsertCustomerEntitlement
    db?: Database
  }): Promise<Result<CustomerEntitlement, FetchError | UnPriceEntitlementError>> {
    const trx = params.db ?? this.db
    const entitlement = {
      ...params.entitlement,
      id: params.entitlement.id ?? newId("customer_entitlement"),
    }

    try {
      const existing = await this.findCustomerEntitlementBySourceWindow({
        db: trx,
        entitlement,
      })

      if (existing) {
        return Ok(existing)
      }

      const uniquenessResult = await this.assertNoOverlappingActiveFeatureEntitlement({
        db: trx,
        entitlement,
      })

      if (uniquenessResult.err) {
        return Err(uniquenessResult.err)
      }

      const inserted = await trx
        .insert(customerEntitlements)
        .values(entitlement)
        .onConflictDoNothing({
          target: [
            customerEntitlements.projectId,
            customerEntitlements.customerId,
            customerEntitlements.featurePlanVersionId,
            customerEntitlements.subscriptionId,
            customerEntitlements.subscriptionPhaseId,
            customerEntitlements.subscriptionItemId,
            customerEntitlements.effectiveAt,
            customerEntitlements.expiresAt,
          ],
        })
        .returning()
        .then((rows) => rows[0] ?? null)

      if (inserted) {
        return Ok(inserted)
      }

      const existingAfterConflict = await this.findCustomerEntitlementBySourceWindow({
        db: trx,
        entitlement,
      })

      if (!existingAfterConflict) {
        return Err(
          new UnPriceEntitlementError({
            message: "Customer entitlement conflict could not be resolved",
            context: {
              projectId: entitlement.projectId,
              customerId: entitlement.customerId,
              featurePlanVersionId: entitlement.featurePlanVersionId,
            },
          })
        )
      }

      return Ok(existingAfterConflict)
    } catch (error) {
      this.logger.error(error, {
        context: "Error creating customer entitlement",
        customerId: entitlement.customerId,
        projectId: entitlement.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to create customer entitlement: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async getCustomerEntitlementsForCustomer(
    params:
      | {
          customerId: string
          projectId: string
          now: number
          startAt?: never
          endAt?: never
          db?: Database
        }
      | {
          customerId: string
          projectId: string
          startAt: number
          endAt: number
          now?: never
          db?: Database
        }
  ): Promise<Result<CustomerEntitlementExtended[], FetchError>> {
    const trx = params.db ?? this.db
    const maxEffectiveAt = params.startAt !== undefined ? params.endAt : params.now
    const minExpiresAt = params.startAt !== undefined ? params.startAt : params.now

    try {
      const rows = await trx.query.customerEntitlements.findMany({
        with: {
          featurePlanVersion: {
            with: {
              feature: true,
            },
          },
          subscriptionPhase: {
            columns: {
              creditLinePolicy: true,
            },
          },
          grants: {
            where: (grant, { and: andOp, gt, isNull, lte, or }) =>
              andOp(
                lte(grant.effectiveAt, maxEffectiveAt),
                or(isNull(grant.expiresAt), gt(grant.expiresAt, minExpiresAt))
              ),
            orderBy: (grant, { asc, desc }) => [
              desc(grant.priority),
              asc(grant.expiresAt),
              asc(grant.id),
            ],
          },
        },
        where: (entitlement, { and: andOp, eq: eqOp, gt, isNull, lte, or }) =>
          andOp(
            eqOp(entitlement.projectId, params.projectId),
            eqOp(entitlement.customerId, params.customerId),
            lte(entitlement.effectiveAt, maxEffectiveAt),
            or(isNull(entitlement.expiresAt), gt(entitlement.expiresAt, minExpiresAt))
          ),
        orderBy: (entitlement, { asc }) => asc(entitlement.effectiveAt),
      })

      return Ok(rows as CustomerEntitlementExtended[])
    } catch (error) {
      this.logger.error(error, {
        context: "Error getting customer entitlements",
        customerId: params.customerId,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to get customer entitlements: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async customerExists(params: {
    customerId: string
    projectId: string
    db?: Database
  }): Promise<Result<boolean, FetchError>> {
    const trx = params.db ?? this.db

    try {
      const row = await trx.query.customers.findFirst({
        columns: { id: true },
        where: (customer, { and: andOp, eq: eqOp }) =>
          andOp(eqOp(customer.id, params.customerId), eqOp(customer.projectId, params.projectId)),
      })

      return Ok(!!row)
    } catch (error) {
      this.logger.error(error, {
        context: "Error checking customer existence",
        customerId: params.customerId,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to check customer existence: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async expireCustomerEntitlement(params: {
    id: string
    projectId: string
    expiresAt: number | null
    db?: Database
  }): Promise<Result<CustomerEntitlement, FetchError | UnPriceEntitlementError>> {
    const trx = params.db ?? this.db

    try {
      const updated = await trx
        .update(customerEntitlements)
        .set({
          expiresAt: params.expiresAt,
          updatedAtM: Date.now(),
        })
        .where(
          and(
            eq(customerEntitlements.id, params.id),
            eq(customerEntitlements.projectId, params.projectId)
          )
        )
        .returning()
        .then((rows) => rows[0] ?? null)

      if (!updated) {
        return Err(
          new UnPriceEntitlementError({
            message: "Customer entitlement not found",
            context: { id: params.id, projectId: params.projectId },
          })
        )
      }

      return Ok(updated)
    } catch (error) {
      this.logger.error(error, {
        context: "Error expiring customer entitlement",
        entitlementId: params.id,
        projectId: params.projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to expire customer entitlement: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async getPhaseOwnedEntitlements(params: {
    projectId: string
    customerId: string
    subscriptionPhaseId: string
    featurePlanVersionIds: string[]
    phaseStartAt: number
    phaseEndAt: number | null
    db?: Database
  }): Promise<Result<Array<CustomerEntitlement & { grants?: Grant[] }>, FetchError>> {
    const trx = params.db ?? this.db

    if (params.featurePlanVersionIds.length === 0) {
      return Ok([])
    }

    try {
      const rows = await trx.query.customerEntitlements.findMany({
        with: {
          grants: {
            where: (grant, { and: andOp, gt, isNull, lte, or }) =>
              andOp(
                params.phaseEndAt ? lte(grant.effectiveAt, params.phaseEndAt) : undefined,
                or(isNull(grant.expiresAt), gt(grant.expiresAt, params.phaseStartAt))
              ),
          },
        },
        where: (entitlement, { and: andOp, eq: eqOp, gt, inArray: inArrayOp, isNull, lte, or }) =>
          andOp(
            eqOp(entitlement.projectId, params.projectId),
            eqOp(entitlement.customerId, params.customerId),
            eqOp(entitlement.subscriptionPhaseId, params.subscriptionPhaseId),
            inArrayOp(entitlement.featurePlanVersionId, params.featurePlanVersionIds),
            params.phaseEndAt ? lte(entitlement.effectiveAt, params.phaseEndAt) : undefined,
            or(isNull(entitlement.expiresAt), gt(entitlement.expiresAt, params.phaseStartAt))
          ),
        orderBy: (entitlement, { desc }) => desc(entitlement.effectiveAt),
      })

      return Ok(rows as Array<CustomerEntitlement & { grants?: Grant[] }>)
    } catch (error) {
      this.logger.error(error, {
        context: "Error getting phase-owned customer entitlements",
        projectId: params.projectId,
        customerId: params.customerId,
        subscriptionPhaseId: params.subscriptionPhaseId,
      })

      return Err(
        new FetchError({
          message: `Failed to get phase-owned customer entitlements: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retry: true,
        })
      )
    }
  }

  public async loadCustomerEntitlementsForCache({
    projectId,
    customerId,
    historicalDays = 30,
  }: {
    projectId: string
    customerId: string
    historicalDays?: number
  }): Promise<Result<CustomerEntitlementExtended[], FetchError>> {
    const now = Date.now()

    return historicalDays > 0
      ? this.getCustomerEntitlementsForCustomer({
          customerId,
          projectId,
          startAt: now - historicalDays * 24 * 60 * 60 * 1000,
          endAt: now,
        })
      : this.getCustomerEntitlementsForCustomer({
          customerId,
          projectId,
          now,
        })
  }

  public async getAccessControlList(params: {
    customerId: string
    projectId: string
    now?: number
  }): Promise<CacheNamespaces["accessControlList"]> {
    const { customerId, projectId, now } = params
    const cacheKey = `${projectId}:${customerId}`
    const { val: acl, err: aclErr } = await this.cache.accessControlList.swr(
      cacheKey,
      async (_key: string) => {
        const { val: usage, err: usageErr } = await this.getCurrentUsage({
          customerId,
          projectId,
          opts: {
            now: now,
          },
        })

        if (usageErr) {
          this.logger.error(usageErr, {
            customerId,
            projectId,
            context: "Failed to get current usage",
          })
          return null
        }

        // if any of the groups has a usage >= limit then the customer is blocked
        // only for usage features with hard limits
        const customerUsageLimitReached = usage.groups.some((group) =>
          group.features.some(
            (feature) =>
              feature &&
              feature.type === "usage" &&
              feature.usageBar.limitType === "hard" &&
              feature.usageBar.limit !== undefined &&
              feature.usageBar.limit > 0 &&
              feature.usageBar.current >= feature.usageBar.limit
          )
        )

        // check if customer is disabled
        const [customer] = await this.db
          .select({ active: customers.active })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.projectId, projectId)))
          .limit(1)

        const customerDisabled = customer ? !customer.active : false

        // check if customer has due invoices (past due subscription)
        const [subscription] = await this.db
          .select({ status: subscriptions.status })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.customerId, customerId),
              eq(subscriptions.projectId, projectId),
              eq(subscriptions.active, true)
            )
          )
          .limit(1)

        const subscriptionStatus = subscription ? subscription.status : null

        const result = {
          customerUsageLimitReached,
          customerDisabled,
          subscriptionStatus,
        }

        return result
      }
    )

    if (aclErr) {
      this.logger.error(aclErr, {
        customerId,
        projectId,
        context: "Failed to check if customer is blocked",
      })
      return null
    }

    return acl ?? null
  }

  public async getCurrentUsage({
    customerId,
    projectId,
    opts,
  }: {
    customerId: string
    projectId: string
    opts?: {
      skipCache?: boolean // skip cache to force revalidation
      now?: number
    }
  }): Promise<Result<CurrentUsage, UnPriceEntitlementError | FetchError>> {
    const cacheKey = `${projectId}:${customerId}`

    // first try to get the entitlement from cache, if not found try to get it from DO,
    const { val, err } = await cachedQuery({
      skipCache: opts?.skipCache,
      cache: this.cache.getCurrentUsage,
      cacheKey,
      load: () =>
        this._getCurrentUsage({
          customerId,
          projectId,
          now: opts?.now ?? Date.now(),
        }),
      wrapLoadError: (err) =>
        new FetchError({
          message: `unable to query usage from _getCurrentUsage - ${err.message}`,
          retry: false,
          context: {
            error: err.message,
            url: "",
            customerId: customerId,
            projectId: projectId,
            method: "_getCurrentUsage",
          },
        }),
    })

    if (err) {
      return Err(
        new FetchError({
          message: err.message,
          retry: true,
          cause: err,
        })
      )
    }

    // set the cache with the fresh value from DB
    this.waitUntil(this.cache.getCurrentUsage.set(cacheKey, val ?? null))

    if (!val) {
      return Ok(this.buildEmptyUsageResponse("USD"))
    }

    return Ok(val)
  }

  /**
   * Get current usage data
   */
  private async _getCurrentUsage({
    customerId,
    projectId,
    now: _now,
  }: {
    customerId: string
    projectId: string
    now: number
  }): Promise<CurrentUsage | null> {
    // TODO: rebuild current usage from customer_entitlements plus the
    // DO/analytics runtime. Customer access should not be derived by grouping
    // grants.
    const subscription = await this.db.query.subscriptions.findFirst({
      where: (table, { and: andOp, eq: eqOp }) =>
        andOp(
          eqOp(table.projectId, projectId),
          eqOp(table.customerId, customerId),
          eqOp(table.active, true)
        ),
    })

    return {
      ...this.buildEmptyUsageResponse("USD"),
      planName: subscription?.planSlug ?? "No Plan",
    }
  }

  private buildEmptyUsageResponse(currency: string): CurrentUsage {
    return {
      planName: "No Plan",
      billingPeriod: "monthly",
      billingPeriodLabel: "mo",
      currency,
      groups: [],
      priceSummary: {
        totalPrice: formatMoney("0", currency),
        flatTotal: formatMoney("0", currency),
        tieredTotal: formatMoney("0", currency),
        packageTotal: formatMoney("0", currency),
        usageTotal: formatMoney("0", currency),
      },
    }
  }
}
