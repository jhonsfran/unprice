import { type Database, and, eq, inArray } from "@unprice/db"
import { grants } from "@unprice/db/schema"
import { type UsageMode, hashStringSHA256 } from "@unprice/db/utils"
import {
  type FeatureType,
  type OverageStrategy,
  calculateCycleWindow,
  type entitlementGrantsSnapshotSchema,
  getAnchor,
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
import type { Logger } from "@unprice/logs"
import type z from "zod"
import { UnPriceGrantError } from "./errors"

interface SubjectGrantQuery {
  subjectId: string
  subjectType: "customer" | "project" | "plan" | "plan_version"
}

export type IngestionResolvedState = {
  activeGrantIds: string[]
  customerId: string
  featureSlug: string
  limit: number | null
  meterConfig: NonNullable<Entitlement["meterConfig"]>
  overageStrategy: OverageStrategy
  projectId: string
  resetConfig: Entitlement["resetConfig"]
  streamEndAt: number | null
  streamId: string
  streamStartAt: number
}

export type ResolvedFeatureStateAtTimestamp =
  | {
      kind: "feature_inactive"
    }
  | {
      kind: "feature_missing"
    }
  | {
      entitlement: Omit<Entitlement, "id">
      kind: "non_usage"
    }
  | {
      kind: "usage"
      state: IngestionResolvedState
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

  private normalizeUnitOfMeasure(unit: string | null | undefined): string {
    const trimmed = unit?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : "units"
  }

  private resolveResetAnchor(params: {
    effectiveAt: number
    resetConfig: NonNullable<
      z.infer<typeof grantSchemaExtended>["featurePlanVersion"]["resetConfig"]
    >
  }): number {
    const { effectiveAt, resetConfig } = params

    if (resetConfig.resetAnchor === "dayOfCreation") {
      return getAnchor(effectiveAt, resetConfig.resetInterval, "dayOfCreation")
    }

    return resetConfig.resetAnchor
  }

  /**
   * craete a stable signarute to find if stacked grants are fungible
   * @param grant
   * @returns
   */
  private getGrantResetSignature(grant: z.infer<typeof grantSchemaExtended>) {
    if (grant.featurePlanVersion.resetConfig) {
      return {
        name: grant.featurePlanVersion.resetConfig.name,
        resetInterval: grant.featurePlanVersion.resetConfig.resetInterval,
        resetIntervalCount: grant.featurePlanVersion.resetConfig.resetIntervalCount,
        planType: grant.featurePlanVersion.resetConfig.planType,
        resetAnchor: this.resolveResetAnchor({
          effectiveAt: grant.effectiveAt,
          resetConfig: grant.featurePlanVersion.resetConfig,
        }),
      }
    }

    if (grant.featurePlanVersion.billingConfig) {
      return {
        name: grant.featurePlanVersion.billingConfig.name,
        resetInterval: grant.featurePlanVersion.billingConfig.billingInterval,
        resetIntervalCount: grant.featurePlanVersion.billingConfig.billingIntervalCount,
        planType: grant.featurePlanVersion.billingConfig.planType,
        resetAnchor: grant.anchor,
      }
    }

    return null
  }

  /**
   * Every grant id tight to a feature plan version. The signature is calculated with the config
   * normalizing all its fields to a stable contract, this only applies for usage based features
   *
   * @param grant
   * @returns
   */
  private getGrantFungibilitySignature(grant: z.infer<typeof grantSchemaExtended>) {
    const { featurePlanVersion } = grant
    const config = featurePlanVersion.config

    const usageMode =
      featurePlanVersion.featureType === "usage" &&
      config &&
      typeof config === "object" &&
      "usageMode" in config
        ? ((config.usageMode as UsageMode | null | undefined) ?? null)
        : null

    // stable signature to avoid recomputations
    const meterConfig =
      featurePlanVersion.featureType === "usage" && featurePlanVersion.meterConfig
        ? {
            eventId: featurePlanVersion.meterConfig.eventId,
            eventSlug: featurePlanVersion.meterConfig.eventSlug,
            aggregationMethod: featurePlanVersion.meterConfig.aggregationMethod,
            aggregationField: featurePlanVersion.meterConfig.aggregationField?.trim() ?? null,
            filters: featurePlanVersion.meterConfig.filters
              ? Object.fromEntries(
                  Object.entries(featurePlanVersion.meterConfig.filters).sort(([left], [right]) =>
                    left.localeCompare(right)
                  )
                )
              : null,
            groupBy: featurePlanVersion.meterConfig.groupBy
              ? [...featurePlanVersion.meterConfig.groupBy].sort()
              : null,
            windowSize: featurePlanVersion.meterConfig.windowSize ?? null,
          }
        : null

    return {
      featureType: featurePlanVersion.featureType,
      unitOfMeasure: this.normalizeUnitOfMeasure(featurePlanVersion.unitOfMeasure),
      usageMode,
      meterConfig,
      resetConfig: this.getGrantResetSignature(grant),
    }
  }

  private buildMaterializedMeterConfig(grant: z.infer<typeof grantSchemaExtended>) {
    const meterConfig = grant.featurePlanVersion.meterConfig

    if (!meterConfig) {
      return null
    }

    return {
      eventId: meterConfig.eventId,
      eventSlug: meterConfig.eventSlug,
      aggregationMethod: meterConfig.aggregationMethod,
      ...(meterConfig.aggregationField?.trim()
        ? { aggregationField: meterConfig.aggregationField.trim() }
        : {}),
      ...(meterConfig.filters
        ? {
            filters: Object.fromEntries(
              Object.entries(meterConfig.filters).sort(([left], [right]) =>
                left.localeCompare(right)
              )
            ),
          }
        : {}),
      ...(meterConfig.groupBy ? { groupBy: [...meterConfig.groupBy].sort() } : {}),
      ...(meterConfig.windowSize ? { windowSize: meterConfig.windowSize } : {}),
    }
  }

  private serializeGrantFungibilitySignature(value: unknown): string {
    return JSON.stringify(value)
  }

  /**
   * Compare 2 signatures and defines its differences
   * @param expected
   * @param actual
   * @returns
   */
  private getGrantFungibilityDifferences(
    expected: ReturnType<GrantsManager["getGrantFungibilitySignature"]>,
    actual: ReturnType<GrantsManager["getGrantFungibilitySignature"]>
  ): string[] {
    const differences: string[] = []

    if (expected.featureType !== actual.featureType) {
      differences.push("featureType")
    }

    if (expected.unitOfMeasure !== actual.unitOfMeasure) {
      differences.push("unitOfMeasure")
    }

    if (expected.usageMode !== actual.usageMode) {
      differences.push("usageMode")
    }

    if (
      this.serializeGrantFungibilitySignature(expected.meterConfig) !==
      this.serializeGrantFungibilitySignature(actual.meterConfig)
    ) {
      differences.push("meterConfig")
    }

    if (
      this.serializeGrantFungibilitySignature(expected.resetConfig) !==
      this.serializeGrantFungibilitySignature(actual.resetConfig)
    ) {
      differences.push("resetConfig")
    }

    return differences
  }

  /**
   * In order to process stacked grants, we need to validate if their configurations are mergeable.
   * Basically they are mergable if the
   * @param params
   * @returns
   */
  private assertFungibleGrantSet(params: {
    grants: z.infer<typeof grantSchemaExtended>[]
    featureSlug: string
    customerId: string
  }): Result<
    {
      orderedGrants: z.infer<typeof grantSchemaExtended>[]
      signature: ReturnType<GrantsManager["getGrantFungibilitySignature"]>
    },
    UnPriceGrantError
  > {
    const orderedGrants = [...params.grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    const baselineGrant = orderedGrants[0]

    if (!baselineGrant) {
      return Err(new UnPriceGrantError({ message: "No grants provided" }))
    }

    // compare the bast priotiry grant with the rest by its signatures.
    const baselineSignature = this.getGrantFungibilitySignature(baselineGrant)
    const nonFungibleGrants = orderedGrants
      .slice(1)
      .map((grant) => ({
        grant,
        differences: this.getGrantFungibilityDifferences(
          baselineSignature,
          this.getGrantFungibilitySignature(grant)
        ),
      }))
      .filter(({ differences }) => differences.length > 0)

    // Do not accept grants that are not fungible.
    if (nonFungibleGrants.length > 0) {
      const nonFungibleGrantSummary = nonFungibleGrants
        .map(({ grant, differences }) => `${grant.id} (${differences.join(", ")})`)
        .join(", ")

      return Err(
        new UnPriceGrantError({
          message: `Cannot materialize feature "${params.featureSlug}" into a
          single entitlement because the current schema only allows one active entitlement
          per feature slug. Stacked grants must be fungible and share featureType, unitOfMeasure,
          usageMode, meterConfig, and resetConfig. Non-fungible grants: ${nonFungibleGrantSummary}`,
          subjectId: params.customerId,
        })
      )
    }

    return Ok({
      orderedGrants,
      signature: baselineSignature,
    })
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

  /**
   * Returns subscription-sourced grants that belong to a specific phase window.
   *
   * Lookup is based on the phase's subscription items (`featurePlanVersionId`) plus
   * the phase time range, so metadata remains informational instead of acting as
   * the primary ownership key.
   */
  public async getPhaseOwnedGrants(params: {
    projectId: string
    customerId: string
    subscriptionPhaseId: string
    featurePlanVersionIds: string[]
    phaseStartAt: number
    phaseEndAt: number | null
  }): Promise<Result<z.infer<typeof grantSchema>[], FetchError | UnPriceGrantError>> {
    const {
      projectId,
      customerId,
      subscriptionPhaseId,
      featurePlanVersionIds,
      phaseStartAt,
      phaseEndAt,
    } = params

    if (featurePlanVersionIds.length === 0) {
      return Ok([])
    }

    try {
      const customerGrants = await this.db.query.grants.findMany({
        where: (grant, { and, eq, inArray, lte, gt, or, isNull }) =>
          and(
            eq(grant.projectId, projectId),
            eq(grant.subjectType, "customer"),
            eq(grant.subjectId, customerId),
            eq(grant.deleted, false),
            inArray(grant.featurePlanVersionId, featurePlanVersionIds),
            inArray(grant.type, ["subscription", "trial"]),
            phaseEndAt ? lte(grant.effectiveAt, phaseEndAt) : undefined,
            or(isNull(grant.expiresAt), gt(grant.expiresAt, phaseStartAt))
          ),
        orderBy: (grant, { desc }) => desc(grant.effectiveAt),
      })

      return Ok(customerGrants)
    } catch (error) {
      this.logger.error(error, {
        context: "Error getting phase-owned grants",
        projectId,
        customerId,
        subscriptionPhaseId,
      })

      return Err(
        new FetchError({
          message: `Failed to get phase-owned grants: ${error instanceof Error ? error.message : String(error)}`,
          retry: true,
        })
      )
    }
  }

  /**
   * Soft-deletes the subset of grants that belong to a phase.
   *
   * Callers can optionally pass explicit `grantIds` when they already resolved the
   * precise rows to remove during a reconciliation pass.
   */
  public async deletePhaseOwnedGrants(params: {
    projectId: string
    customerId: string
    subscriptionPhaseId: string
    featurePlanVersionIds: string[]
    phaseStartAt: number
    phaseEndAt: number | null
    grantIds?: string[]
  }): Promise<Result<void, FetchError | UnPriceGrantError>> {
    const {
      projectId,
      customerId,
      subscriptionPhaseId,
      featurePlanVersionIds,
      phaseStartAt,
      phaseEndAt,
      grantIds,
    } = params

    const { err, val: phaseOwnedGrants } = await this.getPhaseOwnedGrants({
      projectId,
      customerId,
      subscriptionPhaseId,
      featurePlanVersionIds,
      phaseStartAt,
      phaseEndAt,
    })

    if (err) {
      return Err(err)
    }

    const idsToDelete = grantIds?.length
      ? phaseOwnedGrants.filter((grant) => grantIds.includes(grant.id)).map((grant) => grant.id)
      : phaseOwnedGrants.map((grant) => grant.id)

    if (idsToDelete.length === 0) {
      return Ok(undefined)
    }

    return this.deleteGrants({
      grantIds: idsToDelete,
      projectId,
      subjectType: "customer",
      subjectId: customerId,
    })
  }

  // Get the grants for the customer. Every customer can have different grants coming from different subjects like:
  // - plan
  // - plan version
  // - project
  // TODO: this is doing a lot, we could decrease complexity
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
    // TODO: this is called multiple times per every entitlement call, we should take a look and improve performance.
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
              orderBy: (phase, { desc }) => desc(phase.startAt),
              ...(startAt === undefined ? { limit: 1 } : {}),
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
          code: "CUSTOMER_NOT_FOUND",
          subjectId: customerId,
        })
      )
    }

    const subscription = customerSubscription?.subscriptions[0] ?? null
    const currentPhase = subscription?.phases[0] ?? null

    // Build list of subjects to query grants for
    const subjects: SubjectGrantQuery[] = [
      { subjectId: customerId, subjectType: "customer" },
      { subjectId: projectId, subjectType: "project" },
    ]

    // if there is an active phase add the plan and the plan version as subjects
    if (currentPhase) {
      subjects.push({ subjectId: currentPhase.planVersionId, subjectType: "plan_version" })
      subjects.push({ subjectId: currentPhase.planVersion.planId, subjectType: "plan" })
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
      this.logger.error(error, {
        context: "Error getting grants for customer",
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
   * Resolve the event-time metering state directly from grants.
   *
   * Resolves event-time metering state directly from grants.
   * The important distinction is:
   *
   * - Grants answer "what is true at this event timestamp?"
   * - The stream answers "which counter should accumulate this event?"
   *
   * For each feature with active usage grants at `timestamp` we:
   *
   * 1. Keep only grants active at the event time.
   * 2. Enforce fungibility so stacked grants agree on meter/reset shape.
   * 3. Reuse `computeEntitlementState()` to derive the effective limit/config
   *    for that moment in time.
   * 4. Build a stable `streamId` from customer + project + feature + the
   *    fungibility signature.
   * 5. Expand from the active grants to the full continuous coverage interval
   *    of that same stream so the reset anchor stays stable across mid-cycle
   *    grant changes.
   *
   * Example:
   *
   * - grant A: [Mar 1, Mar 10) limit 100
   * - grant B: [Mar 10, Mar 20) limit 150
   *
   * On Mar 15 the active limit is 150, but the stream still started on Mar 1.
   * That lets ingestion keep using the same monthly counter instead of
   * accidentally creating a new counter on Mar 10. This mean we can add new grants mid cycle if needed without
   * affecting the current counters
   */
  public async resolveIngestionStatesFromGrants(params: {
    customerId: string
    grants: z.infer<typeof grantSchemaExtended>[]
    projectId: string
    timestamp: number
  }): Promise<Result<IngestionResolvedState[], UnPriceGrantError>> {
    const { customerId, grants, projectId, timestamp } = params
    const activeUsageGrants = grants.filter(
      (grant) =>
        this.isGrantActiveAt(grant, timestamp) &&
        grant.featurePlanVersion.featureType === "usage" &&
        Boolean(grant.featurePlanVersion.meterConfig)
    )

    if (activeUsageGrants.length === 0) {
      return Ok([])
    }

    const grantsByFeature = new Map<string, z.infer<typeof grantSchemaExtended>[]>()

    for (const grant of activeUsageGrants) {
      const featureSlug = grant.featurePlanVersion.feature.slug
      const existing = grantsByFeature.get(featureSlug) ?? []
      grantsByFeature.set(featureSlug, [...existing, grant])
    }

    const resolvedStates: IngestionResolvedState[] = []

    for (const [featureSlug, featureGrants] of grantsByFeature.entries()) {
      const { err: fungibilityErr, val: fungibleGrantSet } = this.assertFungibleGrantSet({
        grants: featureGrants,
        featureSlug,
        customerId,
      })

      if (fungibilityErr) {
        return Err(fungibilityErr)
      }

      const computedStateResult = await this.computeEntitlementState({
        customerId,
        projectId,
        grants: featureGrants,
      })

      if (computedStateResult.err) {
        return Err(computedStateResult.err)
      }

      const computedState = computedStateResult.val

      if (!computedState.meterConfig) {
        continue
      }

      const serializedSignature = this.serializeGrantFungibilitySignature(
        fungibleGrantSet.signature
      )
      const sameStreamGrants = grants.filter((grant) => {
        if (grant.featurePlanVersion.feature.slug !== featureSlug) {
          return false
        }

        return (
          this.serializeGrantFungibilitySignature(this.getGrantFungibilitySignature(grant)) ===
          serializedSignature
        )
      })
      // We intentionally derive stream coverage from all grants with the same
      // stream signature, not only the grants active at `timestamp`.
      // This keeps the stream anchor stable across temporary stacked grants or
      // back-to-back renewals that should continue accumulating in one period.
      const coverage = this.findContinuousCoverageBounds({
        grants: sameStreamGrants,
        timestamp,
      }) ?? {
        end: computedState.expiresAt,
        start: computedState.effectiveAt,
      }

      // This is very important as is the key that allow us to rotate the DO
      const streamId = `stream_${await hashStringSHA256(
        JSON.stringify({
          customerId,
          featureSlug,
          projectId,
          signature: fungibleGrantSet.signature,
        })
      )}`

      // stream is the list of grants that are fungible. They are fungible because they share meter config, reset config and feature.
      resolvedStates.push({
        activeGrantIds: fungibleGrantSet.orderedGrants.map((grant) => grant.id),
        customerId,
        featureSlug,
        limit: computedState.limit,
        meterConfig: computedState.meterConfig,
        overageStrategy: computedState.metadata?.overageStrategy ?? "none",
        projectId,
        resetConfig: computedState.resetConfig,
        streamEndAt: coverage.end,
        streamId,
        streamStartAt: coverage.start,
      })
    }

    return Ok(resolvedStates)
  }

  public async resolveFeatureStateAtTimestamp(params: {
    customerId: string
    featureSlug: string
    grants: z.infer<typeof grantSchemaExtended>[]
    projectId: string
    timestamp: number
  }): Promise<Result<ResolvedFeatureStateAtTimestamp, UnPriceGrantError>> {
    const { customerId, featureSlug, grants, projectId, timestamp } = params
    const featureGrants = grants.filter(
      (grant) => grant.featurePlanVersion.feature.slug === featureSlug
    )

    if (featureGrants.length === 0) {
      return Ok({
        kind: "feature_missing",
      })
    }

    const activeFeatureGrants = featureGrants.filter((grant) =>
      this.isGrantActiveAt(grant, timestamp)
    )

    if (activeFeatureGrants.length === 0) {
      return Ok({
        kind: "feature_inactive",
      })
    }

    const computedStateResult = await this.computeEntitlementState({
      customerId,
      projectId,
      grants: activeFeatureGrants,
    })

    if (computedStateResult.err) {
      return Err(computedStateResult.err)
    }

    if (
      computedStateResult.val.featureType !== "usage" ||
      computedStateResult.val.meterConfig === null
    ) {
      return Ok({
        kind: "non_usage",
        entitlement: computedStateResult.val,
      })
    }

    const resolvedStatesResult = await this.resolveIngestionStatesFromGrants({
      customerId,
      grants: featureGrants,
      projectId,
      timestamp,
    })

    if (resolvedStatesResult.err) {
      return Err(resolvedStatesResult.err)
    }

    const matchedState = resolvedStatesResult.val.find((state) => state.featureSlug === featureSlug)

    if (!matchedState) {
      return Err(
        new UnPriceGrantError({
          message: `Unable to resolve usage stream for feature "${featureSlug}"`,
        })
      )
    }

    return Ok({
      kind: "usage",
      state: matchedState,
    })
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
          this.logger.error(error, {
            context: "Error creating grants",
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
      this.logger.error(error, {
        context: "Error creating grants",
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
        this.logger.error(createGrantResult.err, {
          context: "Failed to renew grant",
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

    const { err: fungibilityErr, val: fungibleGrantSet } = this.assertFungibleGrantSet({
      grants,
      featureSlug,
      customerId,
    })

    if (fungibilityErr) {
      return Err(fungibilityErr)
    }

    // Sort by priority (higher first) to preserve consumption order and get the best priority grant.
    // This determines the canonical configuration for the computed entitlement.
    const ordered = fungibleGrantSet.orderedGrants
    const bestPriorityGrant = ordered[0]!
    const winningUnitOfMeasure = fungibleGrantSet.signature.unitOfMeasure

    const grantsSnapshot = ordered.map((g) => ({
      id: g.id,
      type: g.type,
      name: g.name,
      effectiveAt: g.effectiveAt,
      expiresAt: g.expiresAt,
      limit: g.limit,
      priority: g.priority,
      unitOfMeasure: this.normalizeUnitOfMeasure(g.featurePlanVersion.unitOfMeasure),
      config: g.featurePlanVersion.config, // Keep config for pricing calculations
      featurePlanVersionId: g.featurePlanVersionId,
    }))

    // Merge grants according to merging policy derived from feature type
    const merged = this.mergeGrants({
      grants: grantsSnapshot,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      usageMode: bestPriorityGrant.featurePlanVersion.config?.usageMode,
    })

    // The effective configuration should come from the "winning" grant(s)
    // If merged.grants is empty (shouldn't happen if grants.length > 0), fall back to bestPriorityGrant
    // But since we filter grants in mergeGrants, we need to find the corresponding full grant object
    // for the winning grant ID to get full configuration (resetConfig etc).
    const winningGrantSnapshot = merged.grants[0] ?? grantsSnapshot[0]!
    const winningGrant = ordered.find((g) => g.id === winningGrantSnapshot.id) ?? bestPriorityGrant

    // Merge overage strategy from all grants based on merging policy
    let overageStrategy = winningGrant.featurePlanVersion.metadata?.overageStrategy ?? "none"
    if (merged.mergingPolicy === "sum" || merged.mergingPolicy === "max") {
      if (ordered.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "always")) {
        overageStrategy = "always"
      } else if (
        ordered.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "last-call")
      ) {
        overageStrategy = "last-call"
      }
    } else if (merged.mergingPolicy === "min") {
      if (ordered.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "none")) {
        overageStrategy = "none"
      } else if (
        ordered.some((g) => g.featurePlanVersion.metadata?.overageStrategy === "last-call")
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
          resetAnchor: this.resolveResetAnchor({
            effectiveAt: winningGrant.effectiveAt,
            resetConfig: winningGrant.featurePlanVersion.resetConfig,
          }),
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
    const isUsageFeature = bestPriorityGrant.featurePlanVersion.featureType === "usage"
    const meterConfig = isUsageFeature ? this.buildMaterializedMeterConfig(bestPriorityGrant) : null

    if (isUsageFeature && !meterConfig) {
      return Err(
        new UnPriceGrantError({
          message: "Usage feature plan version is missing meter configuration",
          subjectId: customerId,
        })
      )
    }

    return Ok({
      limit: merged.limit,
      mergingPolicy: merged.mergingPolicy,
      effectiveAt: merged.effectiveAt,
      expiresAt: merged.expiresAt,
      resetConfig: isUsageFeature ? localResetConfig : null,
      meterConfig,
      featureType: bestPriorityGrant.featurePlanVersion.featureType,
      unitOfMeasure: winningUnitOfMeasure,
      grants: merged.grants,
      featureSlug,
      customerId,
      projectId,
      isCurrent: true,
      createdAtM: Date.now(),
      updatedAtM: Date.now(),
      metadata: winningGrantMetadata,
    })
  }

  private isGrantActiveAt(grant: z.infer<typeof grantSchemaExtended>, timestamp: number): boolean {
    return (
      grant.effectiveAt <= timestamp && (grant.expiresAt === null || timestamp < grant.expiresAt)
    )
  }

  /**
   * Find the continuous interval of a logical stream that contains `timestamp`.
   *
   * "Continuous" here means overlapping or touching grant intervals after we
   * have already limited the input to grants with the same feature + same
   * fungibility signature.
   *
   * This is used for reset-period anchoring, not for deciding which grants are
   * active. Active grants are filtered separately by `isGrantActiveAt()`.
   *
   * Example:
   *
   * - g1: [Mar 1, Mar 15)
   * - g2: [Mar 15, Mar 31)
   *
   * These should behave like one continuous stream for period-key
   * computation, so this helper returns [Mar 1, Mar 31) for any timestamp in
   * that merged interval.
   */
  private findContinuousCoverageBounds(params: {
    grants: z.infer<typeof grantSchemaExtended>[]
    timestamp: number
  }): {
    end: number | null
    start: number
  } | null {
    if (params.grants.length === 0) {
      return null
    }

    const intervals = params.grants
      .map((grant) => ({
        end: grant.expiresAt,
        start: grant.effectiveAt,
      }))
      .sort(
        (left, right) =>
          left.start - right.start ||
          this.normalizeCoverageEnd(left.end) - this.normalizeCoverageEnd(right.end)
      )
    const merged: Array<{ end: number | null; start: number }> = []

    for (const interval of intervals) {
      const previous = merged.at(-1)

      if (!previous) {
        merged.push({ ...interval })
        continue
      }

      if (interval.start <= this.normalizeCoverageEnd(previous.end)) {
        previous.end =
          previous.end === null || interval.end === null
            ? null
            : Math.max(previous.end, interval.end)
        continue
      }

      merged.push({ ...interval })
    }

    return (
      merged.find(
        (interval) =>
          interval.start <= params.timestamp &&
          (interval.end === null || params.timestamp < interval.end)
      ) ?? null
    )
  }

  private normalizeCoverageEnd(end: number | null): number {
    return end ?? Number.POSITIVE_INFINITY
  }

  /**
   * Merges grants according to the specified feature type and its implicit merging policy.
   * Returns the calculated limit, overage setting, the winning grants, and the effective date range.
   * @param params
   * @returns
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
    const winningUnitOfMeasure = this.normalizeUnitOfMeasure(sorted[0]?.unitOfMeasure)
    const unitScoped = sorted.filter(
      (grant) => this.normalizeUnitOfMeasure(grant.unitOfMeasure) === winningUnitOfMeasure
    )
    const scopedGrants = unitScoped.length > 0 ? unitScoped : sorted

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

    let result: {
      limit: number | null
      grants: z.infer<typeof entitlementGrantsSnapshotSchema>[]
      effectiveAt: number
      expiresAt: number | null
      mergingPolicy: EntitlementMergingPolicy
    }

    switch (policy) {
      case "sum": {
        const hasUnlimited = scopedGrants.some((g) => g.limit === null)
        const limit = hasUnlimited ? null : scopedGrants.reduce((sum, g) => sum + (g.limit ?? 0), 0)

        // For sum, the validity range is the union of all grants
        const minStart = Math.min(...scopedGrants.map((g) => g.effectiveAt))
        const hasNoExpiry = scopedGrants.some((g) => g.expiresAt === null)
        const expiryTimes = scopedGrants
          .map((g) => g.expiresAt)
          .filter((e): e is number => e !== null)

        result = {
          limit,
          grants: scopedGrants,
          effectiveAt: minStart,
          expiresAt: hasNoExpiry ? null : expiryTimes.length > 0 ? Math.max(...expiryTimes) : null,
          mergingPolicy: policy,
        }
        break
      }

      case "max": {
        const hasUnlimited = scopedGrants.some((g) => g.limit === null)
        const limits = scopedGrants.map((g) => g.limit).filter((l): l is number => l !== null)

        const maxLimit = hasUnlimited ? null : limits.length > 0 ? Math.max(...limits) : null

        // Filter grants: keep only the highest priority grant that offers the max limit
        // This ensures we have a single deterministic configuration source
        const winningGrant = scopedGrants.find((g) => g.limit === maxLimit) || scopedGrants[0]!

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
        // If all grants are unlimited, result is unlimited.
        // Otherwise take the smallest numeric limit (ignoring unlimited grants).
        const limits = scopedGrants.map((g) => g.limit).filter((l): l is number => l !== null)
        const allUnlimited = limits.length === 0
        const minLimit = allUnlimited ? null : Math.min(...limits)

        // Filter grants: keep only the highest priority grant that offers the min limit
        const winningGrant = scopedGrants.find((g) => g.limit === minLimit) || scopedGrants[0]!

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
        const highest = scopedGrants[0]!
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
        const highest = scopedGrants[0]!
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
