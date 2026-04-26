import type { Analytics } from "@unprice/analytics"
import { type Database, and, eq, inArray } from "@unprice/db"
import { grants } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
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
import { billingStrategyFor } from "../billing/strategy"
import type { Cache } from "../cache/service"
import type { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import type { LedgerGateway } from "../ledger"
import type { Metrics } from "../metrics"
import { getPaymentProviderCapabilities } from "../payment-provider/service"
import type { RatingService } from "../rating/service"
import { toErrorContext } from "../utils/log-context"
import type { WalletService } from "../wallet"
import { UnPriceSubscriptionError } from "./errors"
import type { SubscriptionMachine } from "./machine"
import type { SubscriptionRepository } from "./repository"
import type { SusbriptionMachineStatus } from "./types"
import { withLockedMachine } from "./withLockedMachine"

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
  private readonly repo: SubscriptionRepository
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private readonly customerService: CustomerService
  private readonly billingService: BillingService
  private readonly ratingService: RatingService
  private readonly ledgerService: LedgerGateway
  private readonly walletService: WalletService | undefined

  constructor({
    db,
    repo,
    logger,
    analytics,
    waitUntil,
    cache,
    metrics,
    customerService,
    billingService,
    ratingService,
    ledgerService,
    walletService,
  }: {
    db: Database
    repo: SubscriptionRepository
    logger: Logger
    analytics: Analytics
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    waitUntil: (promise: Promise<any>) => void
    cache: Cache
    metrics: Metrics
    customerService: CustomerService
    billingService: BillingService
    ratingService: RatingService
    ledgerService: LedgerGateway
    walletService?: WalletService
  }) {
    this.db = db
    this.repo = repo
    this.logger = logger
    this.analytics = analytics
    this.cache = cache
    this.metrics = metrics
    this.waitUntil = waitUntil
    this.customerService = customerService
    this.billingService = billingService
    this.ratingService = ratingService
    this.ledgerService = ledgerService
    this.walletService = walletService
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
        target.effectiveAt <= now && (target.expiresAt === null || target.expiresAt >= now)

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

    // Invalidate entitlement cache so the next read recomputes from grants
    this.waitUntil(
      Promise.all([
        this.cache.customerRelevantEntitlements.remove(`${phase.projectId}:${customerId}:0`),
        this.cache.customerRelevantEntitlements.remove(`${phase.projectId}:${customerId}:30`),
      ])
    )

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
    const subscriptionWithPhases = await this.repo.findSubscriptionWithPhases({
      subscriptionId,
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

    const result = await this.repo.withTransaction(async (txRepo) => {
      const phase = await txRepo.insertPhase({
        id: newId("subscription_phase"),
        projectId,
        planVersionId,
        subscriptionId,
        paymentMethodId: paymentMethodId ?? null,
        paymentProvider: paymentProviderToUse,
        trialEndsAt: trialsEndAt,
        trialUnits: trialUnitsToUse,
        startAt: startAtToUse,
        endAt: endAtToUse,
        metadata: metadata ?? null,
        billingAnchor: billingAnchorToUse ?? 0,
      })

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

      await txRepo.insertItems({ items: subscriptionItemValues })

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
        // Status decision tree, in priority order:
        //   trialing       — plan grants trial units (and a payment method
        //                    is on file if the plan requires one).
        //   pending_payment — invoice-driven mode that bills upfront and
        //                    requires a payment method but no funds have
        //                    settled yet. The bootstrap topup/invoice will
        //                    fire PAYMENT_SUCCESS to flip us to `active`.
        //   active         — pay_in_arrear plans (DO drains the credit_line
        //                    grant), wallet-only plans, and free / no-
        //                    payment-method plans.
        // versionData.whenToBill is non-null in the schema (default
        // "pay_in_advance"), but some legacy/test fixtures omit it. Treat
        // missing as "not advance billing" — same as the prior `===` check.
        const versionStrategy = versionData.whenToBill
          ? billingStrategyFor(versionData.whenToBill)
          : null
        const isAdvancePending =
          versionStrategy?.billPhaseTrigger === "period_start" &&
          paymentMethodRequired &&
          (!paymentMethodId || paymentMethodId === "")
        const status =
          trialUnitsToUse > 0 ? "trialing" : isAdvancePending ? "pending_payment" : "active"
        await txRepo.updateSubscription({
          subscriptionId,
          projectId,
          data: {
            active: true,
            status,
            planSlug: versionData.plan.slug,
            currentCycleStartAt: calculatedBillingCycle.start,
            currentCycleEndAt: calculatedBillingCycle.end,
            renewAt: calculatedBillingCycle.start,
          },
        })

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
          db: db ?? this.db,
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
    const phase = await this.repo.findPhaseWithItemsAndSubscription({
      phaseId,
      projectId,
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

    const result = await this.repo.withTransaction(async (txRepo) => {
      const grantService = this.createGrantManager(this.db)

      const subscriptionPhase = await txRepo.deletePhase({ phaseId, projectId })

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
    const subscriptionWithPhases = await this.repo.findSubscriptionWithPhases({
      subscriptionId,
      projectId,
      phasesFromStartAt: startAt,
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
    const result = await this.repo.withTransaction(async (txRepo) => {
      const subscriptionPhase = await txRepo.updatePhase({
        phaseId: input.id,
        data: {
          startAt: startAt,
          endAt: endAtToUse ?? null,
        },
      })

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
        await txRepo.updateItemUnits({
          projectId,
          updates: itemsToChange.map((item) => ({
            id: item.id,
            units: item.units ?? null,
          })),
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
        db: db ?? this.db,
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

    const newSubscription = await this.repo.insertSubscription({
      id: subscriptionId,
      projectId,
      customerId: customerData.id,
      active: false,
      status: "active",
      timezone: timezoneToUse,
      metadata: metadata ?? null,
      currentCycleStartAt: Date.now(),
      currentCycleEndAt: Date.now(),
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
    return this.repo.findSubscription({ subscriptionId, projectId })
  }

  public async getSubscriptionById({
    subscriptionId,
  }: {
    subscriptionId: string
  }): Promise<Result<unknown | null, UnPriceSubscriptionError>> {
    try {
      const subscriptionData = await this.repo.findSubscriptionFull({ subscriptionId })
      return Ok(subscriptionData ?? null)
    } catch (err) {
      this.logger.error(err, {
        context: "error getting subscription by id",
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
    try {
      const result = await this.repo.listSubscriptionsByProject({
        projectId,
        page,
        pageSize,
        from,
        to,
      })

      return Ok({
        subscriptions: result.subscriptions,
        pageCount: result.pageCount,
      })
    } catch (err) {
      this.logger.error(err, {
        context: "error listing subscriptions by project",
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
      const subscriptionData = await this.repo.listSubscriptionsByPlanVersion({
        planVersionId,
        projectId,
      })

      return Ok(subscriptionData)
    } catch (err) {
      this.logger.error(err, {
        context: "error listing subscriptions by plan version",
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
    lock?: boolean
    ttlMs?: number
    run: (m: SubscriptionMachine) => Promise<T>
  }): Promise<T> {
    try {
      return await withLockedMachine({
        ...args,
        db: this.db,
        repo: this.repo,
        logger: this.logger,
        analytics: this.analytics,
        customer: this.customerService,
        ratingService: this.ratingService,
        ledgerService: this.ledgerService,
        walletService: this.walletService,
        setLockContext: (ctx: Parameters<typeof this.setLockContext>[0]) =>
          this.setLockContext(ctx),
      })
    } catch (e) {
      if (e instanceof Error && e.message === "SUBSCRIPTION_BUSY") {
        throw new UnPriceSubscriptionError({ message: "SUBSCRIPTION_BUSY" })
      }
      throw e
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

  public async activateWallet({
    subscriptionId,
    projectId,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    now?: number
  }): Promise<Result<{ status: SusbriptionMachineStatus }, UnPriceSubscriptionError> | null> {
    if (!this.walletService) return null

    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: false,
        run: async (machine) => {
          const result = await machine.activate()
          if (result.err) throw result.err
          return result.val
        },
      })

      // The activating actor parks failed activations in `pending_activation`
      // (a recoverable, sweeper-driven state) instead of throwing. Surface
      // that as Err here so callers (create.ts, retry sweeper) treat it as
      // a failure and don't return a "succeeded" Result with an empty wallet.
      // See HARD-007.
      if (status === "pending_activation") {
        return Err(
          new UnPriceSubscriptionError({
            message: "Wallet activation failed; subscription parked in pending_activation",
            context: { subscriptionId, projectId, status },
          })
        )
      }

      return Ok({ status })
    } catch (e) {
      return Err(
        e instanceof UnPriceSubscriptionError
          ? e
          : new UnPriceSubscriptionError({ message: (e as Error).message })
      )
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

  public async reconcilePaymentOutcome({
    subscriptionId,
    projectId,
    invoiceId,
    outcome,
    failureMessage,
    now = Date.now(),
  }: {
    subscriptionId: string
    projectId: string
    invoiceId: string
    outcome: "success" | "failure"
    failureMessage?: string
    now?: number
  }): Promise<Result<{ status: SusbriptionMachineStatus }, UnPriceSubscriptionError>> {
    try {
      const status = await this.withSubscriptionMachine({
        subscriptionId,
        projectId,
        now,
        lock: true,
        run: async (machine) => {
          if (outcome === "success") {
            const ok = await machine.reportPaymentSuccess({ invoiceId })
            if (ok.err) {
              throw ok.err
            }
            return ok.val
          }

          const failed = await machine.reportPaymentFailure({
            invoiceId,
            error: failureMessage ?? "Payment failed from provider webhook",
          })
          if (failed.err) {
            throw failed.err
          }
          return failed.val
        },
      })

      return Ok({ status })
    } catch (error) {
      return Err(
        error instanceof UnPriceSubscriptionError
          ? error
          : new UnPriceSubscriptionError({
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to reconcile subscription payment outcome",
            })
      )
    }
  }
}
