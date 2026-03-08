import type { Analytics } from "@unprice/analytics"
import { type Database, type SQL, and, eq, inArray, sql } from "@unprice/db"
import { subscriptionItems, subscriptionPhases, subscriptions } from "@unprice/db/schema"
import { newId } from "@unprice/db/utils"
import {
  type InsertSubscription,
  type InsertSubscriptionPhase,
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
import { BillingService } from "../billing/service"
import type { Cache } from "../cache/service"
import { CustomerService } from "../customers/service"
import { GrantsManager } from "../entitlements/grants"
import type { Metrics } from "../metrics"
import { toErrorContext } from "../utils/log-context"
import { unprice } from "../utils/unprice"
import { UnPriceSubscriptionError } from "./errors"
import { SubscriptionMachine } from "./machine"
import { SubscriptionLock } from "./subscriptionLock"
import type { SusbriptionMachineStatus } from "./types"

export class SubscriptionService {
  private readonly db: Database
  private readonly logger: Logger
  private readonly analytics: Analytics
  private readonly cache: Cache
  private readonly metrics: Metrics
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  private readonly waitUntil: (promise: Promise<any>) => void
  private customerService: CustomerService
  private billingService: BillingService
  private grantService: GrantsManager

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
    this.cache = cache
    this.metrics = metrics
    this.waitUntil = waitUntil
    this.customerService = new CustomerService({
      db,
      logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    })
    this.billingService = new BillingService({
      db,
      logger,
      analytics,
      waitUntil,
      cache,
      metrics,
    })

    this.grantService = new GrantsManager({
      db: db ?? this.db,
      logger: this.logger,
    })
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
    const isFirstPhase = subscriptionWithPhases.phases.length === 0

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
    // let's skip the payment method validation if the payment provider is sandbox
    const paymentProvider = versionData.paymentProvider

    // validate payment method is required and if not provided
    if (
      paymentMethodRequired &&
      paymentProvider !== "sandbox" &&
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
      await trx
        .insert(subscriptionItems)
        .values(
          configItemsSubscription.map((item) => ({
            id: newId("subscription_item"),
            subscriptionPhaseId: phase.id,
            projectId: projectId,
            featurePlanVersionId: item.featurePlanId,
            units: item.units,
            subscriptionId,
          }))
        )
        .returning()
        .catch((e) => {
          this.logger.error(e.message)
          trx.rollback()
          throw e
        })

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

        // reset entitlements if the phase is not the first one and the phase is active
        if (!isFirstPhase && isActivePhase) {
          // TODO: change this when implementing webhooks service + qstash
          this.waitUntil(
            unprice.customers.resetEntitlements({
              customerId: subscriptionWithPhases.customerId,
              projectId,
            })
          )
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
      await this.grantService.deleteGrants({
        grantIds: phase.items.map((item) => item.id) ?? [],
        projectId,
        subjectType: "customer",
        subjectId: phase.subscription.customerId,
      })
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
            items: true,
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

        await (db ?? this.db)
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

        // TODO: update the units for the entitlements and recompute the entitlements
        // we need to cut access if needed or extend the access if needed
        // await this.computeGrantsForPhase({
        //   itemsIds: itemsToChange.map((item) => item.id),
        //   projectId,
        //   customerId: subscriptionWithPhases.customerId,
        //   db: trx,
        //   type: "subscription",
        // })
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

    // execute this in a transaction
    const result = await trx.transaction(async (innerTrx) => {
      try {
        // create the subscription
        const subscriptionId = newId("subscription")

        // create the subscription and then phases
        const newSubscription = await innerTrx
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
      } catch (e) {
        this.logger.error("Error creating subscription", {
          error: JSON.stringify(e),
        })

        return Err(
          new UnPriceSubscriptionError({
            message: "Error while creating subscription",
          })
        )
      }
    })

    if (result.err) {
      return Err(result.err)
    }

    const subscription = result.val

    return Ok(subscription)
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
                error: e instanceof Error ? e.message : String(e),
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
