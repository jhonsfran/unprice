import { type Database, and, eq, inArray } from "@unprice/db"
import { grants } from "@unprice/db/schema"
import { type UsageMode, hashStringSHA256 } from "@unprice/db/utils"
import {
  type ConfigFeatureVersionType,
  type FeatureType,
  type OverageStrategy,
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
import { deriveMeterKey } from "./domain"
import { UnPriceGrantError } from "./errors"

interface SubjectGrantQuery {
  subjectId: string
  subjectType: "customer" | "project" | "plan" | "plan_version"
}

export type IngestionResolvedState = {
  activeGrantIds: string[]
  customerId: string
  effectiveAt: number
  expiresAt: number | null
  featureSlug: string
  grants: IngestionGrant[]
  limit: number | null
  meterHash: string
  meterConfig: NonNullable<Entitlement["meterConfig"]>
  overageStrategy: OverageStrategy
  projectId: string
  resetConfig: Entitlement["resetConfig"]
}

export type IngestionGrant = {
  amount: number | null
  anchor: number
  currencyCode: string
  effectiveAt: number
  expiresAt: number | null
  featureConfig: ConfigFeatureVersionType
  featurePlanVersionId: string
  featureSlug: string
  grantId: string
  meterConfig: NonNullable<Entitlement["meterConfig"]>
  meterHash: string
  overageStrategy: OverageStrategy
  priority: number
  resetConfig: Entitlement["resetConfig"]
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
   * Create the reset contract a grant carries into ingestion.
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

  private getGrantMeterConfig(grant: z.infer<typeof grantSchemaExtended>) {
    return grant.featurePlanVersion.meterConfig ?? null
  }

  private getGrantUnitOfMeasure(grant: z.infer<typeof grantSchemaExtended>): string {
    return this.normalizeUnitOfMeasure(grant.featurePlanVersion.unitOfMeasure)
  }

  private getSemanticMeterKeyFromConfig(params: {
    meterConfig: NonNullable<Entitlement["meterConfig"]>
    unitOfMeasure: string | null | undefined
  }): string {
    return `${deriveMeterKey(params.meterConfig)}|unit=${encodeURIComponent(
      this.normalizeUnitOfMeasure(params.unitOfMeasure)
    )}`
  }

  private orderGrantsByPriority<T extends { priority: number | null | undefined }>(
    grants: T[]
  ): T[] {
    return [...grants].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  private buildMaterializedMeterConfig(grant: z.infer<typeof grantSchemaExtended>) {
    const meterConfig = this.getGrantMeterConfig(grant)

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

  private resolveGrantFeatureConfig(
    grant: z.infer<typeof grantSchemaExtended>
  ): ConfigFeatureVersionType | null {
    return (grant.featurePlanVersion.config ?? null) as ConfigFeatureVersionType | null
  }

  private resolveGrantCurrencyCode(grant: z.infer<typeof grantSchemaExtended>): string {
    const featureConfig = this.resolveGrantFeatureConfig(grant)
    return this.extractCurrencyCodeFromFeatureConfig(featureConfig) ?? "USD"
  }

  private resolveGrantAmount(grant: z.infer<typeof grantSchemaExtended>): number | null {
    return grant.limit ?? grant.units ?? grant.featurePlanVersion.limit ?? null
  }

  private materializeIngestionGrant(
    grant: z.infer<typeof grantSchemaExtended>
  ): IngestionGrant | null {
    const featureConfig = this.resolveGrantFeatureConfig(grant)
    const meterConfig = this.getGrantMeterConfig(grant)
    const resetConfig = this.getGrantResetSignature(grant)

    if (!featureConfig || !meterConfig || !grant.meterHash) {
      return null
    }

    return {
      amount: this.resolveGrantAmount(grant),
      anchor: resetConfig?.resetAnchor ?? grant.anchor,
      currencyCode: this.resolveGrantCurrencyCode(grant),
      effectiveAt: grant.effectiveAt,
      expiresAt: grant.expiresAt,
      featureConfig,
      featurePlanVersionId: grant.featurePlanVersionId,
      featureSlug: grant.featurePlanVersion.feature.slug,
      grantId: grant.id,
      meterConfig,
      meterHash: grant.meterHash,
      overageStrategy: grant.featurePlanVersion.metadata?.overageStrategy ?? "none",
      priority: grant.priority,
      resetConfig,
    }
  }

  private extractCurrencyCodeFromFeatureConfig(config: unknown): string | null {
    const currencyFromPrice = this.extractCurrencyCode(config, "price")
    if (currencyFromPrice) {
      return currencyFromPrice
    }

    if (!this.isRecord(config) || !Array.isArray(config.tiers)) {
      return null
    }

    for (const tier of config.tiers) {
      const currencyFromTier = this.extractCurrencyCode(tier, "unitPrice")
      if (currencyFromTier) {
        return currencyFromTier
      }
    }

    return null
  }

  private extractCurrencyCode(input: unknown, priceKey: string): string | null {
    if (!this.isRecord(input)) {
      return null
    }

    const price = input[priceKey]
    if (!this.isRecord(price)) {
      return null
    }

    const dinero = price.dinero
    if (!this.isRecord(dinero)) {
      return null
    }

    const currency = dinero.currency
    if (!this.isRecord(currency)) {
      return null
    }

    const code = currency.code
    return typeof code === "string" && code.length > 0 ? code : null
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
  }

  private async buildGrantInsertMeterHash(
    grant: z.infer<typeof grantInsertSchema>
  ): Promise<Partial<z.infer<typeof grantInsertSchema>>> {
    const embeddedPlanFeature = (grant as unknown as { featurePlanVersion?: unknown })
      .featurePlanVersion
    const featurePlanVersion = this.isRecord(embeddedPlanFeature)
      ? embeddedPlanFeature
      : await this.db.query.planVersionFeatures?.findFirst({
          where: (planFeature, { and, eq }) =>
            and(
              eq(planFeature.id, grant.featurePlanVersionId),
              eq(planFeature.projectId, grant.projectId)
            ),
        })

    if (!this.isRecord(featurePlanVersion)) {
      return {}
    }

    const meterConfig = this.isRecord(featurePlanVersion.meterConfig)
      ? featurePlanVersion.meterConfig
      : undefined
    const unitOfMeasure =
      typeof featurePlanVersion.unitOfMeasure === "string" ? featurePlanVersion.unitOfMeasure : null

    if (!meterConfig) {
      return {}
    }

    return {
      meterHash: await hashStringSHA256(
        this.getSemanticMeterKeyFromConfig({
          meterConfig: meterConfig as NonNullable<Entitlement["meterConfig"]>,
          unitOfMeasure,
        })
      ),
    }
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
   * Resolve the event-time metering state directly from the active grants.
   * Grant creation already stores the meter hash, so ingestion only groups
   * active usage grants by their stored semantic meter hash.
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
        Boolean(this.getGrantMeterConfig(grant)) &&
        Boolean(grant.meterHash)
    )

    if (activeUsageGrants.length === 0) {
      return Ok([])
    }

    const grantsByMeterHash = new Map<
      string,
      {
        featureSlug: string
        grants: z.infer<typeof grantSchemaExtended>[]
        meterHash: string
      }
    >()

    for (const grant of activeUsageGrants) {
      const featureSlug = grant.featurePlanVersion.feature.slug
      const meterHash = grant.meterHash

      if (!meterHash) {
        continue
      }

      const groupKey = JSON.stringify({ featureSlug, meterHash })
      const group = grantsByMeterHash.get(groupKey) ?? {
        featureSlug,
        grants: [],
        meterHash,
      }

      group.grants.push(grant)
      grantsByMeterHash.set(groupKey, group)
    }

    const resolvedStates: IngestionResolvedState[] = []

    for (const { featureSlug, grants: groupGrants, meterHash } of grantsByMeterHash.values()) {
      const computedStateResult = await this.computeEntitlementState({
        customerId,
        projectId,
        grants: groupGrants,
      })

      if (computedStateResult.err) {
        return Err(computedStateResult.err)
      }

      const computedState = computedStateResult.val

      if (!computedState.meterConfig) {
        continue
      }

      const orderedGrants = this.orderGrantsByPriority(groupGrants)
      const ingestionGrants = orderedGrants
        .map((grant) => this.materializeIngestionGrant(grant))
        .filter((grant): grant is IngestionGrant => grant !== null)

      if (ingestionGrants.length === 0) {
        return Err(
          new UnPriceGrantError({
            message: `Usage feature "${featureSlug}" has no active grant pricing configs`,
            subjectId: customerId,
          })
        )
      }

      resolvedStates.push({
        activeGrantIds: orderedGrants.map((grant) => grant.id),
        customerId,
        effectiveAt: computedState.effectiveAt,
        expiresAt: computedState.expiresAt,
        featureSlug,
        grants: ingestionGrants,
        limit: computedState.limit,
        meterHash,
        meterConfig: computedState.meterConfig,
        overageStrategy: computedState.metadata?.overageStrategy ?? "none",
        projectId,
        resetConfig: computedState.resetConfig,
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
      const grantConfig = await this.buildGrantInsertMeterHash(newGrant)
      const {
        featurePlanVersion: _featurePlanVersion,
        subscriptionItem: _subscriptionItem,
        ...grantInsert
      } = newGrant as z.infer<typeof grantInsertSchema> & {
        featurePlanVersion?: unknown
        subscriptionItem?: unknown
      }
      const insertedGrants = await this.db
        .insert(grants)
        .values({
          ...grantInsert,
          ...grantConfig,
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

    // Sort by priority (higher first) to preserve consumption order and get the best priority grant.
    // This determines the canonical configuration for the computed entitlement.
    const ordered = this.orderGrantsByPriority(grants)
    const bestPriorityGrant = ordered[0]!
    const winningUnitOfMeasure = this.getGrantUnitOfMeasure(bestPriorityGrant)

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
