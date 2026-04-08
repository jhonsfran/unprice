import type { Analytics } from "@unprice/analytics"
import { type Database, type SQL, and, count, eq, getTableColumns, inArray, sql } from "@unprice/db"
import {
  customers,
  grants,
  subscriptionItems,
  subscriptionPhases,
  subscriptions,
} from "@unprice/db/schema"
import { newId, withDateFilters, withPagination } from "@unprice/db/utils"
import {
  type GrantType,
  type InsertSubscription,
  type InsertSubscriptionPhase,
  type OverageStrategy,
  type Subscription,
  type SubscriptionItemConfig,
  type SubscriptionPhase,
  calculateCycleWindow,
  calculateDateAt,
  createDefaultSubscriptionConfig,
  getAnchor,
} from "@unprice/db/validators"
import { Err, Ok, type Result, type SchemaError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { env } from "../../env"
import type { BillingService } from "../billing/service"
import type { Cache } from "../cache/service"
import type { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import type { LedgerService } from "../ledger/service"
import type { Metrics } from "../metrics"
import { getPaymentProviderCapabilities } from "../payment-provider/service"
import type { RatingService } from "../rating/service"
import { toErrorContext } from "../utils/log-context"
import { UnPriceSubscriptionError } from "./errors"
import { SubscriptionMachine } from "./machine"
import { SubscriptionLock } from "./subscriptionLock"
import type { SusbriptionMachineStatus } from "./types"

type PhaseGrantType = Extract<GrantType, "trial" | "subscription">

interface PhaseGrantItemInput {
  id: string
  units: number | null
  featurePlanVersionId: string
  featureLimit: number | null
  overageStrategy: OverageStrategy
}

interface PhaseGrantTarget {
  key: string
  type: PhaseGrantType
  subscriptionItemId: string
  featurePlanVersionId: string
  effectiveAt: number
  expiresAt: number | null
  limit: number | null
  units: number | null
  overageStrategy: OverageStrategy
  anchor: number
}

type PhaseOwnedGrant = typeof grants.$inferSelect

export class SubscriptionService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly customerService: CustomerService
  private readonly billingService: BillingService
  private readonly ratingService: RatingService
  private readonly ledgerService: LedgerService

  constructor({
    db,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    customerService,
    billingService,
    ratingService,
    ledgerService,
  }: {
    db: Database
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    customerService: CustomerService
    billingService: BillingService
    ratingService: RatingService
    ledgerService: LedgerService
  }) {
    this.db = db
    this.logger = logger
    this.analytics = analytics
    this.cache = cache
    this.metrics = metrics
    this.waitUntil = waitUntil
    this.customerService = customerService
    this.billingService = billingService
    this.ratingService = ratingService
    this.ledgerService = ledgerService
  }

  private setLockContext(context: {
    type?: "metric" | "normal" | "wide_event"
    resource?: string
    action?: string
    acquired?: boolean
    ttl_ms?: number
    max_hold_ms?: number
  }) {
    this.logger.set({ lock: context })
  }

  /**
   * Creates a GrantsManager bound to the current transaction so phase changes and
   * grant sync stay atomic.
   */
  private createGrantManager(db: Database) {
    return new GrantsManager({
      db,
      logger: this.logger,
    })
  }

  /**
   * Builds a stable reconciliation key for a phase-owned grant.
   *
   * We key by `featurePlanVersionId + grant type` because a phase currently
   * materializes at most one subscription item per feature plan version.
   */
  private getPhaseGrantKey(input: {
    featurePlanVersionId: string
    type: PhaseGrantType
  }) {
    return `${input.featurePlanVersionId}:${input.type}`
  }

  /**
   * Normalizes phase items into the minimal grant-sync shape used by the
   * reconciliation helpers below.
   */
  private normalizePhaseGrantItems(
    items: Array<{
      id: string
      units: number | null
      featurePlanVersionId?: string | null
      featurePlanVersion?: {
        id?: string
        limit?: number | null
        metadata?: { overageStrategy?: OverageStrategy } | null
      } | null
    }>
  ): PhaseGrantItemInput[] {
    return items
      .map((item) => {
        const featurePlanVersionId =
          item.featurePlanVersionId ?? item.featurePlanVersion?.id ?? null

        if (!featurePlanVersionId) {
          return null
        }

        return {
          id: item.id,
          units: item.units,
          featurePlanVersionId,
          featureLimit: item.featurePlanVersion?.limit ?? null,
          overageStrategy: item.featurePlanVersion?.metadata?.overageStrategy ?? "none",
        }
      })
      .filter((item): item is PhaseGrantItemInput => item !== null)
  }

  /**
   * Expands a phase into the concrete grant records that should exist for it.
   *
   * Trials produce a `trial` grant followed by a `subscription` grant for the
   * remaining window; non-trial phases produce only a `subscription` grant.
   */
  private buildPhaseGrantTargets({
    phase,
    items,
  }: {
    phase: {
      id: string
      billingAnchor: number
      startAt: number
      endAt: number | null
      trialEndsAt: number | null
    }
    items: PhaseGrantItemInput[]
  }): PhaseGrantTarget[] {
    const targets: PhaseGrantTarget[] = []

    const grantWindows: Array<{
      type: PhaseGrantType
      effectiveAt: number
      expiresAt: number | null
    }> = []

    if (phase.trialEndsAt && phase.trialEndsAt > phase.startAt) {
      grantWindows.push({
        type: "trial",
        effectiveAt: phase.startAt,
        expiresAt: phase.trialEndsAt,
      })

      if (phase.endAt === null || phase.trialEndsAt < phase.endAt) {
        grantWindows.push({
          type: "subscription",
          effectiveAt: phase.trialEndsAt,
          expiresAt: phase.endAt,
        })
      }
    } else {
      grantWindows.push({
        type: "subscription",
        effectiveAt: phase.startAt,
        expiresAt: phase.endAt,
      })
    }

    for (const item of items) {
      for (const grantWindow of grantWindows) {
        targets.push({
          key: this.getPhaseGrantKey({
            featurePlanVersionId: item.featurePlanVersionId,
            type: grantWindow.type,
          }),
          type: grantWindow.type,
          subscriptionItemId: item.id,
          featurePlanVersionId: item.featurePlanVersionId,
          effectiveAt: grantWindow.effectiveAt,
          expiresAt: grantWindow.expiresAt,
          limit: item.units ?? item.featureLimit ?? null,
          units: item.units,
          overageStrategy: item.overageStrategy,
          anchor: phase.billingAnchor,
        })
      }
    }

    return targets
  }

  /**
   * Compares the mutable billing attributes of a grant with the desired phase
   * target. Metadata is intentionally excluded so it stays informational only.
   */
  private hasSameGrantConfiguration(existingGrant: PhaseOwnedGrant, target: PhaseGrantTarget) {
    return (
      existingGrant.featurePlanVersionId === target.featurePlanVersionId &&
      existingGrant.type === target.type &&
      existingGrant.limit === target.limit &&
      existingGrant.units === target.units &&
      existingGrant.overageStrategy === target.overageStrategy &&
      existingGrant.anchor === target.anchor
    )
  }

  /**
   * Same configuration plus identical time bounds, used for future-dated grants
   * that can be kept as-is during phase edits.
   */
  private hasExactFutureGrant(existingGrant: PhaseOwnedGrant, target: PhaseGrantTarget) {
    return (
      this.hasSameGrantConfiguration(existingGrant, target) &&
      existingGrant.effectiveAt === target.effectiveAt &&
      existingGrant.expiresAt === target.expiresAt
    )
  }

  /**
   * Reconciles the grants that should exist for a subscription phase.
   *
   * Rules:
   * - active phase changes end the old grants at `now` and create replacements
   * - future phase changes replace only future-dated grants
   * - metadata is written for observability, but ownership matching is derived
   *   from the phase's feature plan versions and time window
   */
  private async syncPhaseGrants({
    customerId,
    subscriptionId,
    phase,
    items,
    db,
    now,
  }: {
    customerId: string
    subscriptionId: string
    phase: {
      id: string
      projectId: string
      billingAnchor: number
      startAt: number
      endAt: number | null
      trialEndsAt: number | null
    }
    items: PhaseGrantItemInput[]
    db: Database
    now: number
  }): Promise<Result<void, UnPriceSubscriptionError>> {
    const grantsManager = this.createGrantManager(db)
    const featurePlanVersionIds = [...new Set(items.map((item) => item.featurePlanVersionId))]
    const { err: existingErr, val: phaseOwnedGrants } = await grantsManager.getPhaseOwnedGrants({
      projectId: phase.projectId,
      customerId,
      subscriptionPhaseId: phase.id,
      featurePlanVersionIds,
      phaseStartAt: phase.startAt,
      phaseEndAt: phase.endAt,
    })

    if (existingErr) {
      return Err(
        new UnPriceSubscriptionError({
          message: existingErr.message,
        })
      )
    }

    const isActivePhase = phase.startAt <= now && (phase.endAt ?? Number.POSITIVE_INFINITY) >= now

    if (!isActivePhase && phaseOwnedGrants.length === 0) {
      return Ok(undefined)
    }

    const desiredTargets = this.buildPhaseGrantTargets({
      phase,
      items,
    })

    const currentGrantsByKey = new Map<string, PhaseOwnedGrant[]>()
    const futureGrantsByKey = new Map<string, PhaseOwnedGrant[]>()

    for (const grant of phaseOwnedGrants) {
      const key = this.getPhaseGrantKey({
        featurePlanVersionId: grant.featurePlanVersionId,
        type: grant.type as PhaseGrantType,
      })

      if (grant.effectiveAt > now) {
        futureGrantsByKey.set(key, [...(futureGrantsByKey.get(key) ?? []), grant])
        continue
      }

      if (grant.expiresAt === null || grant.expiresAt > now) {
        currentGrantsByKey.set(key, [...(currentGrantsByKey.get(key) ?? []), grant])
      }
    }

    const keepGrantIds = new Set<string>()
    const grantIdsToExpire = new Set<string>()
    const grantIdsToDelete = new Set<string>()
    const grantExpiryUpdates = new Map<string, number | null>()
    const targetsToCreate: PhaseGrantTarget[] = []

    for (const target of desiredTargets) {
      const currentCandidates = currentGrantsByKey.get(target.key) ?? []
      const futureCandidates = futureGrantsByKey.get(target.key) ?? []
      const targetIsCurrent =
        target.effectiveAt <= now && (target.expiresAt === null || target.expiresAt > now)

      if (targetIsCurrent) {
        const currentMatch = currentCandidates.find((grant) =>
          this.hasSameGrantConfiguration(grant, target)
        )

        if (currentMatch) {
          keepGrantIds.add(currentMatch.id)

          if (currentMatch.expiresAt !== target.expiresAt) {
            grantExpiryUpdates.set(currentMatch.id, target.expiresAt)
          }
        } else {
          for (const grant of currentCandidates) {
            grantIdsToExpire.add(grant.id)
          }

          targetsToCreate.push({
            ...target,
            effectiveAt: now,
          })
        }

        for (const grant of futureCandidates) {
          grantIdsToDelete.add(grant.id)
        }
        continue
      }

      const futureMatch = futureCandidates.find((grant) => this.hasExactFutureGrant(grant, target))

      if (futureMatch) {
        keepGrantIds.add(futureMatch.id)
      } else {
        for (const grant of futureCandidates) {
          grantIdsToDelete.add(grant.id)
        }

        targetsToCreate.push(target)
      }

      for (const grant of currentCandidates) {
        grantIdsToExpire.add(grant.id)
      }
    }

    for (const grantsByKey of currentGrantsByKey.values()) {
      for (const grant of grantsByKey) {
        if (!keepGrantIds.has(grant.id)) {
          grantIdsToExpire.add(grant.id)
        }
      }
    }

    for (const grantsByKey of futureGrantsByKey.values()) {
      for (const grant of grantsByKey) {
        if (!keepGrantIds.has(grant.id)) {
          grantIdsToDelete.add(grant.id)
        }
      }
    }

    for (const grantId of grantIdsToDelete) {
      grantIdsToExpire.delete(grantId)
      grantExpiryUpdates.delete(grantId)
    }

    if (grantIdsToExpire.size > 0) {
      await db
        .update(grants)
        .set({
          expiresAt: now,
          updatedAtM: now,
        })
        .where(
          and(inArray(grants.id, [...grantIdsToExpire]), eq(grants.projectId, phase.projectId))
        )
    }

    for (const [grantId, expiresAt] of grantExpiryUpdates.entries()) {
      if (grantIdsToExpire.has(grantId) || grantIdsToDelete.has(grantId)) continue

      await db
        .update(grants)
        .set({
          expiresAt,
          updatedAtM: now,
        })
        .where(and(eq(grants.id, grantId), eq(grants.projectId, phase.projectId)))
    }

    if (grantIdsToDelete.size > 0) {
      const deletePhaseOwnedGrantsResult = await grantsManager.deletePhaseOwnedGrants({
        projectId: phase.projectId,
        customerId,
        subscriptionPhaseId: phase.id,
        featurePlanVersionIds,
        phaseStartAt: phase.startAt,
        phaseEndAt: phase.endAt,
        grantIds: [...grantIdsToDelete],
      })

      if (deletePhaseOwnedGrantsResult.err) {
        return Err(
          new UnPriceSubscriptionError({
            message: deletePhaseOwnedGrantsResult.err.message,
          })
        )
      }
    }

    for (const target of targetsToCreate) {
      const createGrantResult = await grantsManager.createGrant({
        grant: {
          id: newId("grant"),
          name: "Base Plan",
          projectId: phase.projectId,
          effectiveAt: target.effectiveAt,
          expiresAt: target.expiresAt,
          type: target.type,
          subjectType: "customer",
          subjectId: customerId,
          featurePlanVersionId: target.featurePlanVersionId,
          autoRenew: false,
          limit: target.limit,
          overageStrategy: target.overageStrategy,
          units: target.units,
          anchor: target.anchor,
          metadata: {
            subscriptionId,
            subscriptionPhaseId: phase.id,
            subscriptionItemId: target.subscriptionItemId,
          },
        },
      })

      if (createGrantResult.err) {
        return Err(
          new UnPriceSubscriptionError({
            message: createGrantResult.err.message,
          })
        )
      }
    }

    return Ok(undefined)
  }

  private validatePhasesAction({
    phases,
    phase,
    action,
    now,
  }: {
    phases: SubscriptionPhase[]
    phase: Pick<SubscriptionPhase, "startAt" | "endAt" | "id">
    action: "update" | "create"
    now: number
  }): Result<void, UnPriceSubscriptionError> {
    const orderedPhases = phases.sort((a, b) => a.startAt - b.startAt)

    if (orderedPhases.length === 0) {
      return Ok(undefined)
    }

    if (action === "update") {
      const phaseToUpdate = orderedPhases.find((p) => p.id === phase.id)
      if (!phaseToUpdate) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Phase not found",
          })
        )
      }

      // validate if the phase is active
      // if this phase is active customer can't change the start date
      // we don't use the phase passed as parameter because it's the one with the new dates
      const isActivePhase =
        phaseToUpdate.startAt <= now && (phaseToUpdate.endAt ?? Number.POSITIVE_INFINITY) >= now

      if (isActivePhase && phase.startAt !== phaseToUpdate.startAt) {
        return Err(
          new UnPriceSubscriptionError({
            message: "The phase is active, you can't change the start date",
          })
        )
      }
    }

    if (action === "create") {
      // active phase is the one where now is between startAt and endAt or endAt is undefined
      const activePhase = orderedPhases.find((p) => {
        return phase.startAt >= p.startAt && (p.endAt ? phase.startAt <= p.endAt : true)
      })

      if (activePhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "There is already an active phase in the same date range",
          })
        )
      }
    }

    // verify phases don't overlap result the phases that overlap
    const overlappingPhases = orderedPhases.filter((p) => {
      const startAtPhase = p.startAt
      const endAtPhase = p.endAt ?? Number.POSITIVE_INFINITY

      return (
        (startAtPhase < (phase.endAt ?? Number.POSITIVE_INFINITY) ||
          startAtPhase === (phase.endAt ?? Number.POSITIVE_INFINITY)) &&
        (endAtPhase > phase.startAt || endAtPhase === phase.startAt)
      )
    })

    if (overlappingPhases.length > 0 && overlappingPhases.some((p) => p.id !== phase.id)) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases overlap, there is already a phase in the same date range",
        })
      )
    }

    // check if the phases are consecutive with one another starting from the end date of the previous phase
    // the phase that the customer is updating need to be check with the new dates
    const consecutivePhases = orderedPhases.filter((p, index) => {
      let phaseToCheck = p
      if (p.id === phase.id) {
        phaseToCheck = {
          ...p,
          startAt: phase.startAt,
          endAt: phase.endAt ?? null,
        }
      }

      if (index === 0) {
        return true
      }

      const previousPhaseOriginal = orderedPhases[index - 1]
      if (!previousPhaseOriginal) {
        return false
      }

      let previousPhase = previousPhaseOriginal
      if (previousPhaseOriginal.id === phase.id) {
        previousPhase = {
          ...previousPhaseOriginal,
          startAt: phase.startAt,
          endAt: phase.endAt ?? null,
        } as typeof previousPhaseOriginal
      }

      return previousPhase.endAt !== null && previousPhase.endAt + 1 === phaseToCheck.startAt
    })

    if (consecutivePhases.length !== orderedPhases.length) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phases are not consecutive",
        })
      )
    }

    return Ok(undefined)
  }

  // creating a phase is a 2 step process:
  // 1. validate the input
  // 2. validate the subscription exists
  // 3. validate there is no active phase in the same start - end range for the subscription
  // 4. validate the config items are valid and there is no active subscription item in the same features
  // 5. create the phase
  // 6. create the items
  // 7. create entitlements
  public async createPhase({
    input,
    projectId,
    db,
    now,
  }: {
    input: InsertSubscriptionPhase
    projectId: string
    db?: Database
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const {
      planVersionId,
      trialUnits,
      metadata,
      config,
      paymentProvider,
      paymentMethodId,
      startAt,
      endAt,
      subscriptionId,
    } = input

    const startAtToUse = startAt ?? now
    const endAtToUse = endAt ?? undefined

    // if the end date is in the past, set it to the current date
    if (endAtToUse && endAtToUse < now) {
      return Err(
        new UnPriceSubscriptionError({
          message: "End date is in the past",
        })
      )
    }

    // get subscription with phases from start date
    const subscriptionWithPhases = await (db ?? this.db).query.subscriptions.findFirst({
      where: (sub, { eq }) => eq(sub.id, subscriptionId),
      with: {
        phases: true,
      },
    })

    if (!subscriptionWithPhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription not found",
        })
      )
    }

    // don't allow to create phase when the subscription is not active
    if (!subscriptionWithPhases.active && subscriptionWithPhases.status !== "active") {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription must be active to create a new phase. Please contact support.",
        })
      )
    }

    // validate if the phase is already in the subscription
    const activePhase = subscriptionWithPhases.phases.find((p) => {
      return p.startAt <= now && (p.endAt ?? Number.POSITIVE_INFINITY) >= now
    })

    if (activePhase?.planVersionId === planVersionId) {
      return Err(
        new UnPriceSubscriptionError({
          message:
            "There is already an active phase with the same plan version, you can't create a new phase with the same plan version",
        })
      )
    }

    // validate phases
    const validatePhasesAction = this.validatePhasesAction({
      phases: subscriptionWithPhases.phases,
      phase: {
        id: newId("subscription_phase"),
        startAt: startAtToUse,
        endAt: endAtToUse ?? null,
      },
      action: "create",
      now,
    })

    if (validatePhasesAction.err) {
      return validatePhasesAction
    }

    const versionData = await (db ?? this.db).query.versions.findFirst({
      with: {
        planFeatures: {
          with: {
            feature: true,
          },
        },
        plan: true,
        project: true,
      },
      where(fields, operators) {
        return operators.and(
          operators.eq(fields.id, planVersionId),
          operators.eq(fields.projectId, projectId)
        )
      },
    })

    if (!versionData?.id) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Version not found. Please check the planVersionId",
        })
      )
    }

    if (versionData.status !== "published") {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version is not published, only published versions can be subscribed to",
        })
      )
    }

    if (versionData.active !== true) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version is not active, only active versions can be subscribed to",
        })
      )
    }

    if (!versionData.planFeatures || versionData.planFeatures.length === 0) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Plan version has no features",
        })
      )
    }

    // check if payment method is required for the plan version
    const paymentMethodRequired = versionData.paymentMethodRequired
    const trialUnitsToUse =
      paymentMethodRequired && paymentMethodId && paymentMethodId !== ""
        ? (trialUnits ?? versionData.trialUnits ?? 0)
        : 0
    const billingAnchorToUse = getAnchor(
      startAtToUse,
      versionData.billingConfig.billingInterval,
      versionData.billingConfig.billingAnchor
    )

    // TODO: evaluate if we need to use the billing interval of the subscription
    // const billingIntervalToUse = versionData.billingConfig.billingInterval
    // const subscriptionTimezone = subscriptionWithPhases.timezone

    // calculate the day of creation of the subscription
    // important to keep in mind the timezone of the project
    // if (billingAnchorToUse === "dayOfCreation") {
    //   billingAnchorToUse = getDate(toZonedTime(startAtToUse, subscriptionTimezone))
    // }
    const paymentProviderToUse = paymentProvider ?? versionData.paymentProvider
    const providerCaps = getPaymentProviderCapabilities(paymentProviderToUse)

    // skip payment method validation for providers without async payment confirmation
    if (
      paymentMethodRequired &&
      providerCaps.asyncPaymentConfirmation &&
      (!paymentMethodId || paymentMethodId === "")
    ) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Payment method is required for this plan version",
        })
      )
    }

    // check the subscription items configuration
    let configItemsSubscription: SubscriptionItemConfig[] = []

    if (!config) {
      // if no items are passed, configuration is created from the default quantities of the plan version
      const { err, val } = createDefaultSubscriptionConfig({
        planVersion: versionData,
      })

      if (err) {
        this.logger.set({ error: toErrorContext(err) })
        return Err(
          new UnPriceSubscriptionError({
            message: err.message,
          })
        )
      }

      configItemsSubscription = val
    } else {
      configItemsSubscription = config
    }

    // calculate trials only if payment method is set and required for the plan version
    let trialsEndAt = null
    if (trialUnitsToUse > 0) {
      trialsEndAt = calculateDateAt({
        startDate: startAtToUse,
        config: {
          interval: versionData.billingConfig.billingInterval,
          units: trialUnitsToUse,
        },
      })
    }

    // get the billing cycle for the subscription given the start date
    const calculatedBillingCycle = calculateCycleWindow({
      effectiveStartDate: startAtToUse,
      effectiveEndDate: endAtToUse ?? null,
      trialEndsAt: trialsEndAt,
      now: startAtToUse, // we use the start date to calculate the billing cycle
      config: {
        name: versionData.billingConfig.name,
        interval: versionData.billingConfig.billingInterval,
        intervalCount: versionData.billingConfig.billingIntervalCount,
        planType: versionData.billingConfig.planType,
        anchor: billingAnchorToUse,
      },
    })

    if (!calculatedBillingCycle) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Failed to calculate billing cycle",
        })
      )
    }

    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const phase = await trx
        .insert(subscriptionPhases)
        .values({
          id: newId("subscription_phase"),
          projectId,
          planVersionId,
          subscriptionId,
          paymentMethodId,
          paymentProvider: paymentProviderToUse,
          trialEndsAt: trialsEndAt,
          trialUnits: trialUnitsToUse,
          startAt: startAtToUse,
          endAt: endAtToUse,
          metadata,
          billingAnchor: billingAnchorToUse ?? 0,
        })
        .returning()
        .catch((e) => {
          this.logger.error(e.message)
          throw e
        })
        .then((re) => re[0])

      if (!phase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while creating subscription phase",
          })
        )
      }

      // add items to the subscription
      const subscriptionItemValues = configItemsSubscription.map((item) => ({
        id: newId("subscription_item"),
        subscriptionPhaseId: phase.id,
        projectId: projectId,
        featurePlanVersionId: item.featurePlanId,
        units: item.units ?? null,
        subscriptionId,
      }))

      await trx
        .insert(subscriptionItems)
        .values(subscriptionItemValues)
        .returning()
        .catch((e) => {
          this.logger.error(e.message)
          trx.rollback()
          throw e
        })

      const normalizedPhaseItems = this.normalizePhaseGrantItems(
        subscriptionItemValues.map((item) => {
          const featurePlanVersion = versionData.planFeatures.find(
            (planFeature) => planFeature.id === item.featurePlanVersionId
          )

          return {
            id: item.id,
            units: item.units,
            featurePlanVersionId: item.featurePlanVersionId,
            featurePlanVersion: featurePlanVersion
              ? {
                  id: featurePlanVersion.id,
                  feature: { id: featurePlanVersion.feature.id },
                  limit: featurePlanVersion.limit ?? null,
                  metadata: featurePlanVersion.metadata ?? null,
                }
              : null,
          }
        })
      )

      // update the status of the subscription if the phase is active
      const isActivePhase = phase.startAt <= now && (phase.endAt ?? Number.POSITIVE_INFINITY) >= now

      if (isActivePhase) {
        const status = trialUnitsToUse > 0 ? "trialing" : "active"
        await trx
          .update(subscriptions)
          .set({
            active: true,
            status,
            planSlug: versionData.plan.slug,
            currentCycleStartAt: calculatedBillingCycle.start,
            currentCycleEndAt: calculatedBillingCycle.end,
            renewAt: calculatedBillingCycle.start, // we schedule the renewal for the start of the cycle always
          })
          .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.projectId, projectId)))

        // Update the access control list status in the cache
        this.waitUntil(
          this.customerService.updateAccessControlList({
            customerId: subscriptionWithPhases.customerId,
            projectId,
            updates: { subscriptionStatus: status },
          })
        )

        const syncPhaseGrantsResult = await this.syncPhaseGrants({
          customerId: subscriptionWithPhases.customerId,
          subscriptionId,
          phase,
          items: normalizedPhaseItems,
          db: trx,
          now,
        })

        if (syncPhaseGrantsResult.err) {
          return syncPhaseGrantsResult
        }
      }

      return Ok(phase)
    })

    // generate the billing periods for the new phase on background
    // this can fail but background jobs can retry
    this.waitUntil(
      // TODO: report the event to analytics with more context
      // this.analytics.trackEvent({
      //   event: "subscription.phase.created",
      //   properties: {
      //     subscriptionId,
      //   },
      // })
      !["test"].includes(env.NODE_ENV)
        ? this.billingService.generateBillingPeriods({
            subscriptionId,
            projectId,
            now: Date.now(), // get the periods until the current date
          })
        : Promise.resolve(undefined)
    )

    return result
  }

  public async removePhase({
    phaseId,
    projectId,
    now,
  }: {
    phaseId: string
    projectId: string
    now: number
  }): Promise<Result<boolean, UnPriceSubscriptionError | SchemaError>> {
    // only allow that are not active
    // and are not in the past
    const phase = await this.db.query.subscriptionPhases.findFirst({
      with: {
        items: true,
        subscription: {
          with: {
            customer: true,
          },
        },
      },
      where: (phase, { eq, and }) => and(eq(phase.id, phaseId), eq(phase.projectId, projectId)),
    })

    if (!phase) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    const isActivePhase = phase.startAt <= now && (phase.endAt ?? Number.POSITIVE_INFINITY) >= now
    const isInThePast = phase.startAt < now

    if (isActivePhase || isInThePast) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase is active or in the past, can't remove",
        })
      )
    }

    const result = await this.db.transaction(async (trx) => {
      const grantService = this.createGrantManager(trx)

      // removing the phase will cascade to the subscription items and entitlements
      const subscriptionPhase = await trx
        .delete(subscriptionPhases)
        .where(and(eq(subscriptionPhases.id, phaseId), eq(subscriptionPhases.projectId, projectId)))
        .returning()
        .then((re) => re[0])

      if (!subscriptionPhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while removing subscription phase",
          })
        )
      }

      // remove the grants for the customer - soft delete
      const deletePhaseOwnedGrantsResult = await grantService.deletePhaseOwnedGrants({
        projectId,
        customerId: phase.subscription.customerId,
        subscriptionPhaseId: phase.id,
        featurePlanVersionIds: [...new Set(phase.items.map((item) => item.featurePlanVersionId))],
        phaseStartAt: phase.startAt,
        phaseEndAt: phase.endAt,
      })

      if (deletePhaseOwnedGrantsResult.err) {
        return Err(
          new UnPriceSubscriptionError({
            message: deletePhaseOwnedGrantsResult.err.message,
          })
        )
      }

      return Ok(true)
    })

    return result
  }

  public async updatePhase({
    input,
    subscriptionId,
    projectId,
    db,
    now,
  }: {
    input: SubscriptionPhase
    subscriptionId: string
    projectId: string
    db?: Database
    now: number
  }): Promise<Result<SubscriptionPhase, UnPriceSubscriptionError | SchemaError>> {
    const { startAt, endAt, items, id: phaseId } = input

    let endAtToUse = endAt ?? undefined

    // if the end date is in the past, set it to the current date
    if (endAt && endAt < now) {
      endAtToUse = now
    }

    // get subscription with phases from start date
    const subscriptionWithPhases = await (db ?? this.db).query.subscriptions.findFirst({
      where: (sub, { eq, and }) => and(eq(sub.id, subscriptionId), eq(sub.projectId, projectId)),
      with: {
        phases: {
          where: (phase, { gte }) => gte(phase.startAt, startAt),
          with: {
            items: {
              with: {
                featurePlanVersion: {
                  with: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!subscriptionWithPhases) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription not found",
        })
      )
    }

    if (!subscriptionWithPhases.active) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Subscription is not active",
        })
      )
    }

    // order phases by startAt
    const phases = subscriptionWithPhases.phases

    const phaseToUpdate = phases.find((p) => p.id === input.id)

    if (!phaseToUpdate) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Phase not found",
        })
      )
    }

    // update the phase with the new dates
    const phase = {
      ...phaseToUpdate,
      startAt,
      endAt: endAtToUse ?? null,
    }

    const validatePhasesAction = this.validatePhasesAction({
      phases,
      phase,
      action: "update",
      now,
    })

    if (validatePhasesAction.err) {
      return validatePhasesAction
    }

    // we allow to set the end date before the current billing cycle end date to allow mid-cycle cancellations
    // if the end date is less than the current date, it will be set to the current date by endAtToUse logic above
    const result = await (db ?? this.db).transaction(async (trx) => {
      // create the subscription phase
      const subscriptionPhase = await trx
        .update(subscriptionPhases)
        .set({
          startAt: startAt,
          endAt: endAtToUse ?? null,
        })
        .where(eq(subscriptionPhases.id, input.id))
        .returning()
        .then((re) => re[0])

      if (!subscriptionPhase) {
        return Err(
          new UnPriceSubscriptionError({
            message: "Error while updating subscription phase",
          })
        )
      }

      // add items to the subscription if they are different from the current items
      const itemsFromPhase =
        subscriptionWithPhases.phases.find((p) => p.id === phaseId)?.items ?? []

      // if the items units are different we need to add them
      const itemsToChange = items?.filter((item) => {
        const itemFromPhase = itemsFromPhase.find((i) => i.id === item.id)
        return itemFromPhase?.units !== item.units
      })

      if (itemsToChange?.length) {
        const sqlChunksItems: SQL[] = []

        const ids: string[] = []
        sqlChunksItems.push(sql`(case`)

        for (const item of itemsToChange) {
          sqlChunksItems.push(
            item.units === null
              ? sql`when ${subscriptionItems.id} = ${item.id} then NULL`
              : sql`when ${subscriptionItems.id} = ${item.id} then cast(${item.units} as int)`
          )
          ids.push(item.id)
        }

        sqlChunksItems.push(sql`end)`)

        const finalSqlItems: SQL = sql.join(sqlChunksItems, sql.raw(" "))

        await trx
          .update(subscriptionItems)
          .set({ units: finalSqlItems })
          .where(
            and(inArray(subscriptionItems.id, ids), eq(subscriptionItems.projectId, projectId))
          )
          .catch((e) => {
            this.logger.error(e.message)
            throw new UnPriceSubscriptionError({
              message: `Error while updating subscription items: ${e.message}`,
            })
          })
      }

      const updatedPhaseItems = itemsFromPhase.map((item) => {
        const changedItem = itemsToChange?.find((candidate) => candidate.id === item.id)
        return {
          ...item,
          units: changedItem?.units ?? item.units,
        }
      })

      const syncPhaseGrantsResult = await this.syncPhaseGrants({
        customerId: subscriptionWithPhases.customerId,
        subscriptionId,
        phase: {
          id: subscriptionPhase.id,
          projectId,
          billingAnchor: subscriptionPhase.billingAnchor,
          startAt: subscriptionPhase.startAt,
          endAt: subscriptionPhase.endAt,
          trialEndsAt: subscriptionPhase.trialEndsAt,
        },
        items: this.normalizePhaseGrantItems(updatedPhaseItems),
        db: trx,
        now,
      })

      if (syncPhaseGrantsResult.err) {
        return syncPhaseGrantsResult
      }

      return Ok(subscriptionPhase)
    })

    if (!result.err) {
      this.waitUntil(
        env.NODE_ENV !== "test"
          ? this.billingService.generateBillingPeriods({
              subscriptionId,
              projectId,
              now: Date.now(),
            })
          : Promise.resolve(undefined)
      )
    }

    return result
  }

  public async createSubscription({
    input,
    projectId,
    db,
  }: {
    input: Omit<InsertSubscription, "phases">
    projectId: string
    db?: Database
  }): Promise<Result<Subscription, UnPriceSubscriptionError | SchemaError>> {
    const { customerId, metadata, timezone } = input

    const trx = db ?? this.db

    const customerData = await trx.query.customers.findFirst({
      with: {
        subscriptions: {
          // get active subscriptions of the customer
          where: (sub, { eq }) => eq(sub.active, true),
        },
        project: true,
      },
      where: (customer, operators) =>
        operators.and(
          operators.eq(customer.id, customerId),
          operators.eq(customer.projectId, projectId)
        ),
    })

    if (!customerData?.id) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Customer not found. Please check the customerId",
        })
      )
    }

    // if customer is not active, throw an error
    if (!customerData.active) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Customer is not active",
        })
      )
    }

    // IMPORTANT: for now we only allow one subscription per customer
    if (customerData.subscriptions.length > 0) {
      return Ok(customerData.subscriptions[0]!)
    }

    // project defaults
    const timezoneToUse = timezone || customerData.project.timezone

    const subscriptionId = newId("subscription")

    const newSubscription = await trx
      .insert(subscriptions)
      .values({
        id: subscriptionId,
        projectId,
        customerId: customerData.id,
        active: false,
        status: "active",
        timezone: timezoneToUse,
        metadata: metadata,
        // provisional values
        currentCycleStartAt: Date.now(),
        currentCycleEndAt: Date.now(),
      })
      .returning()
      .then((re) => re[0])
      .catch((e) => {
        this.logger.error(e.message)
        return null
      })

    if (!newSubscription) {
      return Err(
        new UnPriceSubscriptionError({
          message: "Error while creating subscription",
        })
      )
    }

    return Ok(newSubscription)
  }

  public async getSubscriptionData({
    subscriptionId,
    projectId,
  }: {
    subscriptionId: string
    projectId: string
  }): Promise<Subscription | null> {
    const subscriptionData = await this.db.query.subscriptions.findFirst({
      with: {
        project: true,
      },
      where: (subscription, operators) =>
        operators.and(
          operators.eq(subscription.id, subscriptionId),
          operators.eq(subscription.projectId, projectId)
        ),
    })

    if (!subscriptionData?.id) {
      return null
    }

    return subscriptionData
  }

  public async getSubscriptionById({
    subscriptionId,
  }: {
    subscriptionId: string
  }): Promise<Result<unknown | null, UnPriceSubscriptionError>> {
    try {
      const subscriptionData = await this.db.query.subscriptions.findFirst({
        where: (subscription, { eq }) => eq(subscription.id, subscriptionId),
        with: {
          phases: {
            with: {
              planVersion: {
                with: {
                  plan: true,
                },
              },
              items: {
                with: {
                  featurePlanVersion: {
                    with: {
                      feature: true,
                    },
                  },
                },
              },
            },
            orderBy: (phases, { asc }) => asc(phases.startAt),
          },
        },
      })

      return Ok(subscriptionData ?? null)
    } catch (err) {
      this.logger.error("error getting subscription by id", {
        error: toErrorContext(err),
        subscriptionId,
      })
      return Err(
        new UnPriceSubscriptionError({
          message: err instanceof Error ? err.message : "Error getting subscription by id",
        })
      )
    }
  }

  public async listSubscriptionsByProject({
    projectId,
    page,
    pageSize,
    from,
    to,
  }: {
    projectId: string
    page: number
    pageSize: number
    from?: number | null
    to?: number | null
  }): Promise<Result<{ subscriptions: unknown[]; pageCount: number }, UnPriceSubscriptionError>> {
    const columns = getTableColumns(subscriptions)
    const customerColumns = getTableColumns(customers)

    try {
      const expressions = [eq(columns.projectId, projectId)]

      const { data, total } = await this.db.transaction(async (tx) => {
        const query = tx
          .select({
            subscriptions: subscriptions,
            customer: customerColumns,
          })
          .from(subscriptions)
          .innerJoin(
            customers,
            and(
              eq(subscriptions.customerId, customers.id),
              eq(customers.projectId, subscriptions.projectId)
            )
          )
          .$dynamic()

        const whereQuery = withDateFilters<Subscription>(
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
          .from(subscriptions)
          .where(whereQuery)
          .execute()
          .then((res) => res[0]?.count ?? 0)

        const subscriptionsData = data.map((row) => ({
          ...row.subscriptions,
          customer: row.customer,
        }))

        return {
          data: subscriptionsData,
          total,
        }
      })

      return Ok({
        subscriptions: data,
        pageCount: Math.ceil(total / pageSize),
      })
    } catch (err) {
      this.logger.error("error listing subscriptions by project", {
        error: toErrorContext(err),
        projectId,
      })

      return Err(
        new UnPriceSubscriptionError({
          message: "There was an error listing subscriptions. Contact support.",
        })
      )
    }
  }

  public async listSubscriptionsByPlanVersion({
    planVersionId,
    projectId,
  }: {
    planVersionId: string
    projectId: string
  }): Promise<Result<Subscription[], UnPriceSubscriptionError>> {
    try {
      const subscriptionData = await this.db.query.subscriptions.findMany({
        with: {
          phases: {
            where: (phase, { eq }) => eq(phase.planVersionId, planVersionId),
          },
        },
        where: (subscription, { eq }) => eq(subscription.projectId, projectId),
      })

      return Ok(subscriptionData as Subscription[])
    } catch (err) {
      this.logger.error("error listing subscriptions by plan version", {
        error: toErrorContext(err),
        planVersionId,
        projectId,
      })
      return Err(
        new UnPriceSubscriptionError({
          message:
            err instanceof Error ? err.message : "Error listing subscriptions by plan version",
        })
      )
    }
  }

  private async withSubscriptionMachine<T>(args: {
    subscriptionId: string
    projectId: string
    now: number
    // new options
    lock?: boolean
    ttlMs?: number
    run: (m: SubscriptionMachine) => Promise<T>
  }): Promise<T> {
    const { subscriptionId, projectId, now, run, lock: shouldLock = true, ttlMs = 30_000 } = args

    // create the lock if it should be locked
    const lock = shouldLock
      ? new SubscriptionLock({ db: this.db, projectId, subscriptionId })
      : null

    if (lock) {
      const acquired = await lock.acquire({
        ttlMs,
        now,
        staleTakeoverMs: 120_000,
        ownerStaleMs: ttlMs,
      })
      this.setLockContext({
        type: "normal",
        resource: "subscription",
        action: "acquire",
        acquired,
        ttl_ms: ttlMs,
      })

      if (!acquired) {
        this.logger.warn("subscription lock acquire returned false; lock may be held", {
          subscriptionId,
          projectId,
          ttlMs,
        })
      }
      if (!acquired) throw new UnPriceSubscriptionError({ message: "SUBSCRIPTION_BUSY" })
    }

    // heartbeat to keep the lock alive for long transitions
    const stopHeartbeat = lock
      ? (() => {
          let stopped = false
          const startedAt = Date.now()
          const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 2))
          const maxHoldMs = Math.max(ttlMs * 10, 2 * 60_000) // cap renewals to avoid indefinite locks

          const interval = setInterval(async () => {
            if (stopped) return
            const elapsed = Date.now() - startedAt
            if (elapsed > maxHoldMs) {
              this.setLockContext({
                type: "normal",
                resource: "subscription",
                action: "heartbeat_stopped",
                acquired: false,
                ttl_ms: ttlMs,
                max_hold_ms: maxHoldMs,
              })
              this.logger.warn("subscription lock heartbeat maxHoldMs reached; stopping renew", {
                subscriptionId,
                projectId,
                ttlMs,
                maxHoldMs,
              })
              stopped = true
              clearInterval(interval)
              return
            }
            try {
              const ok = await lock.extend({ ttlMs })
              if (!ok) {
                this.setLockContext({
                  type: "normal",
                  resource: "subscription",
                  action: "extend",
                  acquired: false,
                  ttl_ms: ttlMs,
                })
                this.logger.warn("subscription lock extend returned false; lock may be lost", {
                  subscriptionId,
                  projectId,
                })
              }
            } catch (e) {
              this.setLockContext({
                type: "normal",
                resource: "subscription",
                action: "extend_error",
                acquired: false,
                ttl_ms: ttlMs,
              })
              this.logger.error("subscription lock heartbeat extend failed", {
                error: toErrorContext(e),
                subscriptionId,
                projectId,
              })
            }
          }, renewEveryMs)

          return () => {
            stopped = true
            clearInterval(interval)
          }
        })()
      : () => {}

    const { err, val: machine } = await SubscriptionMachine.create({
      now,
      subscriptionId,
      projectId,
      logger: this.logger,
      analytics: this.analytics,
      customer: this.customerService,
      ratingService: this.ratingService,
      ledgerService: this.ledgerService,
      db: this.db,
    })

    if (err) {
      stopHeartbeat()
      if (lock) await lock.release()
      throw err
    }

    try {
      return await run(machine)
    } finally {
      await machine.shutdown()
      stopHeartbeat()
      if (lock) await lock.release()
    }
  }

  public async renewSubscription({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<Result<{ status: SusbriptionMachineStatus }, UnPriceSubscriptionError>> {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        run: async (machine) => {
          const s1 = await machine.renew()
          if (s1.err) throw s1.err
          return s1.val
        },
      })
      return Ok({ status })
    } catch (e) {
      return Err(e as UnPriceSubscriptionError)
    }
  }

  public async invoiceSubscription({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<
    Result<
      {
        status: SusbriptionMachineStatus
      },
      UnPriceSubscriptionError
    >
  > {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true, // we need to lock the subscription to avoid cross-worker races
        run: async (machine) => {
          const i = await machine.invoice()
          if (i.err) throw i.err
          return i.val
        },
      })
      return Ok({ status })
    } catch (e) {
      return Err(e as UnPriceSubscriptionError)
    }
  }
}
