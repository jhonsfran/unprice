import { type Database, and, eq, inArray } from "@unprice/db"
import { entitlements, grants } from "@unprice/db/schema"
import { AGGREGATION_CONFIG, type UsageMode, hashStringSHA256, newId } from "@unprice/db/utils"
import {
  type FeatureType,
  calculateCycleWindow,
  type entitlementGrantsSnapshotSchema,
} from "@unprice/db/validators"
import type {
  Entitlement,
  EntitlementMergingPolicy,
  grantInsertSchema,
  grantSchema,
  grantSchemaExtended,
  planVersionSelectBaseSchema,
  subscriptionPhaseSelectSchema,
  subscriptionSelectSchema,
} from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logging"
import type z from "zod"
import { UnPriceGrantError } from "./errors"

interface SubjectGrantQuery {
  subjectId: string
  subjectType: "customer" | "project" | "plan" | "plan_version"
}

export class GrantsManager {
  private readonly db: Database
  private readonly logger: Logger
  private readonly revalidateInterval: number

  constructor({
    db,
    logger,
    revalidateInterval,
  }: {
    db: Database
    logger: Logger
    revalidateInterval?: number
  }) {
    this.db = db
    this.logger = logger
    this.revalidateInterval = revalidateInterval ?? 300000 // 5 minutes default
  }

  public async deleteGrants(params: {
    grantIds: string[]
    projectId: string
    subjectType: "customer" | "project" | "plan" | "plan_version"
    subjectId: string
  }): Promise<Result<void, FetchError | UnPriceGrantError>> {
    const { grantIds, projectId, subjectType, subjectId } = params

    await this.db
      .update(grants)
      .set({ deleted: true, updatedAtM: Date.now(), deletedAt: Date.now() })
      .where(
        and(
          inArray(grants.id, grantIds),
          eq(grants.projectId, projectId),
          eq(grants.subjectType, subjectType),
          eq(grants.subjectId, subjectId),
          eq(grants.deleted, false)
        )
      )

    return Ok(undefined)
  }

  public async getGrantsForCustomer(
    params:
      | {
          customerId: string
          projectId: string
          now: number
          startAt?: never
          endAt?: never
        }
      | {
          customerId: string
          projectId: string
          startAt: number
          endAt: number
          now?: never
        }
  ): Promise<
    Result<
      {
        grants: z.infer<typeof grantSchemaExtended>[]
        subscription: z.infer<typeof subscriptionSelectSchema> | null
        phase: z.infer<typeof subscriptionPhaseSelectSchema> | null
        planVersion: z.infer<typeof planVersionSelectBaseSchema> | null
      },
      FetchError | UnPriceGrantError
    >
  > {
    const { customerId, projectId, now, startAt, endAt } = params

    // get all grants for a project and customer
    // get the customer's subscription to find planId
    const customerSubscription = await this.db.query.customers.findFirst({
      with: {
        subscriptions: {
          with: {
            phases: {
              where: (phase, { and, lte, or, isNull, gt }) => {
                // filter by startAt and endAt if provided otherwise filter by now
                if (startAt !== undefined) {
                  // Find phases that overlap with the [startAt, endAt] range
                  return and(
                    lte(phase.startAt, endAt),
                    or(isNull(phase.endAt), gt(phase.endAt, startAt))
                  )
                }
                // Otherwise use now to find the active phase
                return and(lte(phase.startAt, now), or(isNull(phase.endAt), gt(phase.endAt, now)))
              },
              limit: 1,
              with: {
                planVersion: {
                  with: {
                    plan: true,
                  },
                },
              },
            },
          },
        },
      },
      where: (customer, { and, eq }) =>
        and(eq(customer.id, customerId), eq(customer.projectId, projectId)),
    })

    if (!customerSubscription) {
      return Err(
        new UnPriceGrantError({
          message: "No customer found for project",
          subjectId: customerId,
        })
      )
    }

    const subscription = customerSubscription?.subscriptions[0] ?? null
    const currentPhase = subscription?.phases[0] ?? null
    const planId = currentPhase?.planVersion?.plan?.id ?? null
    const planVersionId = currentPhase?.planVersion?.id ?? null

    // Build list of subjects to query grants for
    const subjects: SubjectGrantQuery[] = [
      { subjectId: customerId, subjectType: "customer" },
      { subjectId: projectId, subjectType: "project" },
    ]

    if (planId) {
      subjects.push({ subjectId: planId, subjectType: "plan" })
    }

    if (planVersionId) {
      subjects.push({ subjectId: planVersionId, subjectType: "plan_version" })
    }

    // Query all active grants for all subjects in the period of the current cycle
    try {
      const allGrants = await Promise.all(
        subjects.map((subject) =>
          this.db.query.grants.findMany({
            with: {
              featurePlanVersion: {
                with: {
                  feature: true,
                },
              },
            },
            where: (grant, { and, eq, gt, lte, or, isNull }) => {
              const maxEffectiveAt = startAt !== undefined ? endAt : now
              const minExpiresAt = startAt !== undefined ? startAt : now

              return and(
                eq(grant.projectId, projectId),
                eq(grant.subjectId, subject.subjectId),
                eq(grant.subjectType, subject.subjectType),
                eq(grant.deleted, false),
                // Grant is effective: effectiveAt <= maxEffectiveAt (endAt if range provided, otherwise now)
                lte(grant.effectiveAt, maxEffectiveAt),
                // Grant hasn't expired: expiresAt is null OR expiresAt >= minExpiresAt (startAt if range provided, otherwise now)
                or(isNull(grant.expiresAt), gt(grant.expiresAt, minExpiresAt))
              )
            },
            orderBy: (grant, { desc }) => desc(grant.priority),
          })
        )
      )

      return Ok({
        grants: allGrants.flat(),
        subscription: subscription ?? null,
        phase: currentPhase ?? null,
        planVersion: currentPhase?.planVersion ?? null,
      })
    } catch (error) {
      this.logger.error("Error getting grants for customer", {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        },
        customerId,
        projectId,
      })
      return Err(
        new FetchError({
          message: `Failed to get grants for customer: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Creates grants with validation to ensure configuration consistency.
   * Grants are append only, so if new grants are created that are already present, we need to delete the old ones
   * Grants are duplicated if they shared the same subjectId, subjectType, featurePlanVersionId, and effectiveAt and expiresAt
   * Grants with different subjectId and subsjecttype are not duplicated and we need to check for configuration consistency with overlapping grants
   * @param params - The parameters for creating grants
   * @param params.grants - The grants to create
   * @returns The result of creating grants
   * @throws UnPriceGrantError if the grants cannot be created
   * @throws FetchError if the grants cannot be created
   */
  public async createGrant(params: {
    grant: z.infer<typeof grantInsertSchema>
  }): Promise<Result<z.infer<typeof grantSchema>, UnPriceGrantError>> {
    const { grant: newGrant } = params

    // priority map for the grants types
    const priorityMap = {
      subscription: 10,
      addon: 20,
      trial: 60,
      promotion: 70,
      manual: 80,
    } as const

    // We don't care which grant is inserted, we just want to make sure it's unique
    // the merging logic will handle the rest
    try {
      const insertedGrants = await this.db
        .insert(grants)
        .values({
          ...newGrant,
          priority: priorityMap[newGrant.type],
        })
        .onConflictDoNothing({
          target: [
            grants.projectId,
            grants.subjectId,
            grants.subjectType,
            grants.type,
            grants.effectiveAt,
            grants.expiresAt,
            grants.featurePlanVersionId,
          ],
        })
        .returning()
        .catch((error) => {
          this.logger.error("Error creating grants", {
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: error instanceof Error ? error.name : undefined,
              stack: error instanceof Error ? error.stack : undefined,
            },
            grantId: newGrant.id,
          })

          throw error
        })
        .then((rows) => rows[0])

      if (!insertedGrants) {
        return Err(
          new UnPriceGrantError({
            message: `Failed to create grant: ${newGrant.id}`,
            grantId: newGrant.id,
            subjectId: newGrant.subjectId,
          })
        )
      }

      return Ok(insertedGrants)
    } catch (error) {
      this.logger.error("Error creating grants", {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        },
        grantId: newGrant.id,
      })

      return Err(
        new UnPriceGrantError({
          message: `Failed to create grants: ${error instanceof Error ? error.message : String(error)}`,
        })
      )
    }
  }

  public async renewGrantsForCustomer(params: {
    customerId: string
    projectId: string
    now: number
  }): Promise<Result<(typeof grants.$inferSelect)[], FetchError | UnPriceGrantError>> {
    const { customerId, projectId, now } = params

    const { val: result, err: getGrantsErr } = await this.getGrantsForCustomer({
      customerId,
      projectId,
      now,
    })

    if (getGrantsErr) {
      return Err(getGrantsErr)
    }

    const { grants: allGrants } = result

    // only renew grants with auto renew true and not trial and subscription
    const autoRenewGrants = allGrants.filter(
      (grant) => grant.autoRenew && grant.type !== "trial" && grant.type !== "subscription"
    )

    const renewedGrants = []
    for (const grant of autoRenewGrants) {
      const cycle = calculateCycleWindow({
        now: now,
        effectiveStartDate: grant.effectiveAt,
        effectiveEndDate: grant.expiresAt ?? null,
        config: {
          name: grant.featurePlanVersion.billingConfig.name,
          interval: grant.featurePlanVersion.billingConfig.billingInterval,
          intervalCount: grant.featurePlanVersion.billingConfig.billingIntervalCount,
          anchor: grant.anchor,
          planType: grant.featurePlanVersion.billingConfig.planType,
        },
        trialEndsAt: null,
      })

      if (!cycle) {
        return Err(
          new UnPriceGrantError({
            message: "Failed to calculate cycle window",
            subjectId: grant.subjectId,
          })
        )
      }

      // create the grant
      const createGrantResult = await this.createGrant({
        grant: {
          ...grant,
          effectiveAt: cycle.start,
          expiresAt: cycle.end,
        },
      })

      if (createGrantResult.err) {
        this.logger.error("Failed to renew grant", {
          error: {
            message: createGrantResult.err.message,
            type: createGrantResult.err.name,
            stack: createGrantResult.err.stack,
          },
          grantId: grant.id,
          subjectId: grant.subjectId,
        })
        continue
      }

      renewedGrants.push(createGrantResult.val)
    }

    return Ok(renewedGrants)
  }

  /**
   * Computes all entitlements for a customer by aggregating grants from:
   * - Customer-level grants (subjectSource: "customer")
   * - Project-level grants (subjectSource: "project")
   * - Plan-level grants (subjectSource: "plan") from customer's subscription
   *
   * Creates versioned snapshots that are valid until the next cycle end.
   * @param customerId - Customer id to compute the entitlements for
   * @param projectId - Project id to compute the entitlements for
   * @param now - Current time to compute the entitlements for
   * @returns Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>
   * @throws UnPriceGrantError if the entitlements cannot be computed
   * @throws FetchError if the entitlements cannot be computed
   */
  public async computeGrantsForCustomer({
    customerId,
    projectId,
    now,
    featureSlug,
  }: {
    customerId: string
    projectId: string
    now: number
    featureSlug?: string
  }): Promise<Result<(typeof entitlements.$inferSelect)[], FetchError | UnPriceGrantError>> {
    try {
      const { val: result, err: getGrantsErr } = await this.getGrantsForCustomer({
        customerId,
        projectId,
        now,
      })

      if (getGrantsErr) {
        return Err(getGrantsErr)
      }

      const { grants: allGrants } = result

      // Group grants by feature slug
      const grantsByFeature = new Map<string, typeof allGrants>()

      for (const grant of allGrants) {
        const grantFeatureSlug = grant.featurePlanVersion.feature.slug

        // Optimization: skip if we are looking for a specific feature
        if (featureSlug && grantFeatureSlug !== featureSlug) {
          continue
        }

        if (!grantsByFeature.has(grantFeatureSlug)) {
          grantsByFeature.set(grantFeatureSlug, [])
        }

        // add the grant to the list of grants for the feature
        grantsByFeature.get(grantFeatureSlug)!.push(grant)
      }

      // Compute entitlements for each feature
      const computedEntitlements: (typeof entitlements.$inferSelect)[] = []

      for (const [featureSlugItem, featureGrants] of grantsByFeature.entries()) {
        if (featureGrants.length === 0) continue

        // optimization
        if (featureSlug && featureSlug !== featureSlugItem) {
          continue
        }

        // compute the entitlement for each feature in the current cycle
        // this is idempotent, so if the entitlement already exists, it will be updated
        const entitlementResult = await this.computeEntitlementFromGrants({
          grants: featureGrants,
          customerId,
          projectId,
        })

        if (entitlementResult.err) {
          this.logger.error(entitlementResult.err.message, {
            featureSlug: featureSlugItem,
            customerId,
            projectId,
          })

          return Err(entitlementResult.err)
        }

        computedEntitlements.push(entitlementResult.val)
      }

      return Ok(computedEntitlements)
    } catch (error) {
      this.logger.error("Error computing entitlements for customer", {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        },
        customerId,
        projectId,
      })

      return Err(
        new FetchError({
          message: `Failed to compute entitlements: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Computes the entitlement state from a list of grants without saving to the database.
   * This logic is shared between the entitlement computation and the billing estimation.
   */
  public async computeEntitlementState(params: {
    projectId: string
    customerId: string
    grants: z.infer<typeof grantSchemaExtended>[]
  }): Promise<Result<Omit<Entitlement, "id">, UnPriceGrantError>> {
    const { grants, customerId, projectId } = params

    if (grants.length === 0) {
      return Err(new UnPriceGrantError({ message: "No grants provided" }))
    }

    // verify all grants have the same feature slug
    const featureSlug = grants[0]!.featurePlanVersion.feature.slug
    const hasSameFeatureSlug = grants.every(
      (g) => g.featurePlanVersion.feature.slug === featureSlug
    )

    if (!hasSameFeatureSlug) {
      return Err(new UnPriceGrantError({ message: "All grants must have the same feature slug" }))
    }

    // Sort by priority (higher first) to preserve consumption order and get the best priority grant
    // This determines the "intent" (feature type) of the entitlement configuration
    const ordered = [...grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    const bestPriorityGrant = ordered[0]!

    const grantsSnapshot = ordered.map((g) => ({
      id: g.id,
      type: g.type,
      name: g.name,
      effectiveAt: g.effectiveAt,
      expiresAt: g.expiresAt,
      limit: g.limit,
      priority: g.priority,
      config: g.featurePlanVersion.config, // Keep config for pricing calculations
    }))

    // Merge grants according to merging policy derived from feature type
    const merged = this.mergeGrants({
      grants: grantsSnapshot,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      usageMode: bestPriorityGrant.featurePlanVersion.config.usageMode,
    })

    // The effective configuration should come from the "winning" grant(s)
    // If merged.grants is empty (shouldn't happen if grants.length > 0), fall back to bestPriorityGrant
    // But since we filter grants in mergeGrants, we need to find the corresponding full grant object
    // for the winning grant ID to get full configuration (resetConfig etc).

    const winningGrantSnapshot = merged.grants[0] ?? grantsSnapshot[0]!
    const winningGrant = grants.find((g) => g.id === winningGrantSnapshot.id) ?? bestPriorityGrant

    // Merge overage strategy from all grants based on merging policy
    let overageStrategy = winningGrant.featurePlanVersion.metadata?.overageStrategy ?? "none"
    if (merged.mergingPolicy === "sum" || merged.mergingPolicy === "max") {
      if (grants.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "always")) {
        overageStrategy = "always"
      } else if (
        grants.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "last-call")
      ) {
        overageStrategy = "last-call"
      }
    } else if (merged.mergingPolicy === "min") {
      if (grants.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "none")) {
        overageStrategy = "none"
      } else if (
        grants.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "last-call")
      ) {
        overageStrategy = "last-call"
      } else {
        overageStrategy = "always"
      }
    }

    const winningGrantMetadata = {
      ...(winningGrant.featurePlanVersion.metadata ?? {}),
      overageStrategy,
      realtime: winningGrant.featurePlanVersion.metadata?.realtime ?? false,
      notifyUsageThreshold: winningGrant.featurePlanVersion.metadata?.notifyUsageThreshold ?? 90,
      blockCustomer: winningGrant.featurePlanVersion.metadata?.blockCustomer ?? false,
      hidden: winningGrant.featurePlanVersion.metadata?.hidden ?? false,
    }

    // Derive overall effective/expires for cycle computation
    // Compute cycle window from reset config (half-open style via bounds)
    // Use the winning grant's reset config
    const resetConfig = winningGrant.featurePlanVersion.resetConfig
      ? {
          ...winningGrant.featurePlanVersion.resetConfig,
          resetAnchor: winningGrant.anchor,
        }
      : null

    // use the winning grant's billing config
    const billingConfig = winningGrant.featurePlanVersion.billingConfig
      ? {
          name: winningGrant.featurePlanVersion.billingConfig.name,
          resetInterval: winningGrant.featurePlanVersion.billingConfig.billingInterval,
          resetIntervalCount: winningGrant.featurePlanVersion.billingConfig.billingIntervalCount,
          planType: winningGrant.featurePlanVersion.billingConfig.planType,
          resetAnchor: winningGrant.anchor,
        }
      : null

    const localResetConfig = resetConfig ?? billingConfig ?? null

    // Compute version hash + current cycle boundaries
    const version = await hashStringSHA256(
      JSON.stringify({
        grants: merged.grants,
      })
    )

    const config = AGGREGATION_CONFIG[bestPriorityGrant.featurePlanVersion.aggregationMethod]

    // period scoped entitlements use the merged effective at and expires at
    // lifetime scoped entitlements use the winning grant's effective at and expires at
    const effectiveAt = config.reset ? merged.effectiveAt : winningGrant.effectiveAt
    const expiresAt = config.reset ? merged.expiresAt : winningGrant.expiresAt
    const defaultResetConfig = config.reset ? localResetConfig : null

    return Ok({
      limit: merged.limit,
      mergingPolicy: merged.mergingPolicy,
      effectiveAt: effectiveAt,
      expiresAt: expiresAt,
      resetConfig: defaultResetConfig,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      aggregationMethod: bestPriorityGrant.featurePlanVersion.aggregationMethod,
      grants: merged.grants,
      featureSlug,
      customerId,
      projectId,
      version,
      nextRevalidateAt: Date.now() + this.revalidateInterval,
      computedAt: Date.now(),
      createdAtM: Date.now(),
      updatedAtM: Date.now(),
      metadata: winningGrantMetadata,
    })
  }

  /**
   * Computes a single entitlement from a list of grants for a feature.
   * This is the core merging logic.
   * @param grants - List of grants to compute the entitlement from
   * @param customerId - Customer id
   * @param projectId - Project id
   * @param featureSlug - Feature slug to compute the entitlement for
   * @param now - Current time
   * @param timezone - Timezone to use for the entitlement
   * @param cycleEndAt - Cycle end at to use for the entitlement
   * @returns Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>
   * @throws UnPriceGrantError if no grants are provided
   * @throws FetchError if the entitlement cannot be computed
   */
  private async computeEntitlementFromGrants({
    grants,
    customerId,
    projectId,
  }: {
    grants: z.infer<typeof grantSchemaExtended>[]
    customerId: string
    projectId: string
  }): Promise<Result<typeof entitlements.$inferSelect, FetchError | UnPriceGrantError>> {
    const computedStateResult = await this.computeEntitlementState({
      grants,
      customerId,
      projectId,
    })

    if (computedStateResult.err) {
      return Err(
        new UnPriceGrantError({
          message: computedStateResult.err.message,
          subjectId: customerId,
        })
      )
    }

    const computedState = computedStateResult.val

    // get the current entitlement for the customer and feature
    const currentEntitlement = await this.db.query.entitlements.findFirst({
      where: (entitlement, { and, eq }) =>
        and(
          eq(entitlement.projectId, projectId),
          eq(entitlement.customerId, customerId),
          eq(entitlement.featureSlug, computedState.featureSlug)
        ),
    })

    // Prepare base entitlement data
    const entitlementData = {
      id: currentEntitlement?.id ?? newId("entitlement"),
      projectId,
      customerId,
      featureSlug: computedState.featureSlug,
      featureType: computedState.featureType,
      limit: computedState.limit,
      aggregationMethod: computedState.aggregationMethod,
      resetConfig: computedState.resetConfig,
      mergingPolicy: computedState.mergingPolicy,
      grants: computedState.grants,
      version: computedState.version,
      effectiveAt: computedState.effectiveAt,
      expiresAt: computedState.expiresAt,
      nextRevalidateAt: Date.now() + this.revalidateInterval,
      computedAt: Date.now(),
      updatedAtM: Date.now(),
      metadata: computedState.metadata,
    }

    const newEntitlement = await this.db
      .insert(entitlements)
      .values(entitlementData)
      .onConflictDoUpdate({
        target: [entitlements.projectId, entitlements.customerId, entitlements.featureSlug],
        set: entitlementData,
      })
      .returning()
      .catch((error) => {
        this.logger.error(`Error computeEntitlementFromGrants: ${error.message}`, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: error instanceof Error ? error.name : undefined,
            stack: error instanceof Error ? error.stack : undefined,
          },
          entitlementId: entitlementData.id,
        })
        return null
      })
      .then((rows) => rows?.[0] ?? null)

    if (!newEntitlement) {
      return Err(
        new UnPriceGrantError({
          message: `Failed to compute entitlement from grants for feature slug: ${computedState.featureSlug}`,
          subjectId: customerId,
        })
      )
    }

    return Ok(newEntitlement)
  }

  /**
   * Merges grants according to the specified feature type and its implicit merging policy.
   * Returns the calculated limit, overage setting, the winning grants, and the effective date range.
   */
  public mergeGrants(params: {
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    featureType?: FeatureType | undefined
    usageMode?: UsageMode | undefined
    policy?: EntitlementMergingPolicy | undefined
  }): {
    limit: number | null
    grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
    effectiveAt: number
    expiresAt: number | null
    mergingPolicy: EntitlementMergingPolicy
  } {
    const { grants, featureType, usageMode, policy: explicitPolicy } = params

    if (grants.length === 0) {
      return {
        limit: null,
        grants: [],
        effectiveAt: 0,
        expiresAt: null,
        mergingPolicy: "replace",
      }
    }

    // Sort by priority (higher priority first)
    const sorted = [...grants].sort((a, b) => b.priority - a.priority)

    let policy = explicitPolicy

    // If no explicit policy, derive from feature type
    if (!policy) {
      if (!featureType) {
        // Fallback to replace if neither is provided
        policy = "replace"
      } else {
        switch (featureType) {
          case "usage":
            // for usage, we sum the usage of all the grants
            // but if the usage mode is tier, we take the max limit
            if (usageMode === "tier") {
              policy = "max"
            } else {
              policy = "sum"
            }
            break
          case "tier":
          case "package":
            policy = "max"
            break
          default:
            policy = "replace"
            break
        }
      }
    }

    // Helper to get default date range if no specific logic applies
    // Actually we should calculate dates based on the winners
    // But initial implementation can use the sorted list

    let result: {
      limit: number | null
      grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
      effectiveAt: number
      expiresAt: number | null
      mergingPolicy: EntitlementMergingPolicy
    }

    switch (policy) {
      case "sum": {
        const limit = sorted.reduce((sum, g) => sum + (g.limit ?? 0), 0)

        // For sum, the validity range is the union of all grants
        const minStart = Math.min(...sorted.map((g) => g.effectiveAt))
        // max end or null if no expires at
        const maxEnd = Math.max(...sorted.map((g) => g.expiresAt ?? Number.NEGATIVE_INFINITY))

        result = {
          limit: limit > 0 ? limit : null,
          // we take all the grants that were used to calculate the limit
          grants: sorted,
          effectiveAt: minStart,
          expiresAt: maxEnd === Number.NEGATIVE_INFINITY ? null : maxEnd,
          mergingPolicy: policy,
        }
        break
      }

      case "max": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)

        const maxLimit = limits.length > 0 ? Math.max(...limits) : null

        // Filter grants: keep only the highest priority grant that offers the max limit
        // This ensures we have a single deterministic configuration source
        const winningGrant = sorted.find((g) => g.limit === maxLimit) || sorted[0]!

        result = {
          limit: maxLimit,
          // we take the highest limit grant that was used to calculate the limit
          grants: [winningGrant],
          effectiveAt: winningGrant.effectiveAt,
          expiresAt: winningGrant.expiresAt,
          mergingPolicy: policy,
        }
        break
      }

      case "min": {
        const limits = sorted.map((g) => g.limit).filter((l): l is number => l !== null)

        const minLimit = limits.length > 0 ? Math.min(...limits) : null

        // Filter grants: keep only the highest priority grant that offers the min limit
        const winningGrant = sorted.find((g) => g.limit === minLimit) || sorted[0]!

        result = {
          limit: minLimit,
          // we take the lowest limit grant that was used to calculate the limit
          grants: [winningGrant],
          effectiveAt: winningGrant.effectiveAt,
          expiresAt: winningGrant.expiresAt,
          mergingPolicy: policy,
        }
        break
      }

      case "replace": {
        // Highest priority grant replaces all others
        const highest = sorted[0]!
        result = {
          limit: highest.limit,
          // grants are replaced, so we take the highest priority grant
          grants: [highest],
          effectiveAt: highest.effectiveAt,
          expiresAt: highest.expiresAt,
          mergingPolicy: policy,
        }
        break
      }

      default: {
        // Fallback to replace
        const highest = sorted[0]!
        result = {
          limit: highest.limit ?? null,
          // grants are replaced, so we take the highest priority grant
          grants: [highest],
          effectiveAt: highest.effectiveAt,
          expiresAt: highest.expiresAt,
          mergingPolicy: policy,
        }
        break
      }
    }

    return result
  }
}
