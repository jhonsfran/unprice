import type { Database } from "@unprice/db"
import { type Dinero, isZero, newId, toSnapshot } from "@unprice/db/utils"
import { calculateCycleWindow, calculateDateAt } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { formatAmountForProvider } from "@unprice/money"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { isNegative } from "dinero.js"
import { DrizzleBillingRepository } from "../billing/repository.drizzle"
import type { CustomerService } from "../customers/service"
import { type LedgerEntry, type LedgerGateway, customerAccountKeys } from "../ledger"
import type { RatingService } from "../rating/service"
import { toErrorContext } from "../utils/log-context"
import type { SubscriptionRepository } from "./repository"
import type { SubscriptionContext } from "./types"

export async function loadSubscription(payload: {
  context: SubscriptionContext
  logger: Logger
  repo: SubscriptionRepository
  customerService: CustomerService
}): Promise<SubscriptionContext> {
  const { context, logger, repo, customerService } = payload
  const { subscriptionId, projectId, now } = context

  const result = await repo.findSubscriptionForMachine({
    subscriptionId,
    projectId,
    now,
  })

  if (!result) {
    throw new Error(`Subscription with ID ${subscriptionId} not found`)
  }

  const { phases, customer, subscription } = result

  // phase can be undefined if the subscription is paused or ended but still the machine can be in active state
  //  for instance the subscription was pasued there is no current phase but there is an option to resume and
  // subscribe to a new phase
  const currentPhase = phases[0]

  // check the payment method as well
  const { val, err: validatePaymentMethodErr } = await customerService.validatePaymentMethod({
    customerId: customer.id,
    projectId: projectId,
    paymentProvider: currentPhase?.paymentProvider,
    requiredPaymentMethod: currentPhase?.planVersion.paymentMethodRequired,
  })

  if (validatePaymentMethodErr) {
    logger.error(`Error validating payment method: ${validatePaymentMethodErr.message}`)
    throw validatePaymentMethodErr
  }

  const { paymentMethodId, requiredPaymentMethod } = val

  let resultPhase = null

  if (currentPhase) {
    const { items, planVersion, ...phase } = currentPhase
    resultPhase = {
      ...phase,
      items: items ?? [],
      planVersion: planVersion ?? null,
    }
  }

  return {
    now,
    subscriptionId: subscription.id,
    projectId: subscription.projectId,
    customer,
    currentPhase: resultPhase,
    subscription,
    paymentMethodId,
    requiredPaymentMethod,
  }
}

// renew only takes care of the subscription
// responsabilities:
// manage subscription/phase lifecycle at term boundaries.
// Apply scheduled plan changes, end trials, auto-renew or end phases, update subscriptions.currentCycleStartAt/EndAt.
// Orchestrate phase transitions and invariants, not charges.
// will pick up the current phase and appply the changes to the subscription
export async function renewSubscription(opts: {
  context: SubscriptionContext
  logger: Logger
  customerService: CustomerService
  repo: SubscriptionRepository
}) {
  const { context, logger, repo } = opts
  const { subscription, currentPhase } = context

  if (!currentPhase) throw new Error("No active phase found")

  const current = calculateCycleWindow({
    now: context.now,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    config: {
      name: currentPhase.planVersion.billingConfig.name,
      interval: currentPhase.planVersion.billingConfig.billingInterval,
      intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
      planType: currentPhase.planVersion.billingConfig.planType,
      anchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!current) throw new Error("No current cycle window found")

  logger.debug(
    `Current billing window: ${new Date(current.start).toUTCString()} - ${new Date(current.end).toUTCString()}`
  )

  // next window (advance boundary for both modes)
  const next = calculateCycleWindow({
    now: current.end + 1,
    trialEndsAt: currentPhase.trialEndsAt,
    effectiveEndDate: currentPhase.endAt ?? null,
    config: {
      name: currentPhase.planVersion.billingConfig.name,
      interval: currentPhase.planVersion.billingConfig.billingInterval,
      intervalCount: currentPhase.planVersion.billingConfig.billingIntervalCount,
      planType: currentPhase.planVersion.billingConfig.planType,
      anchor: currentPhase.billingAnchor,
    },
    effectiveStartDate: currentPhase.startAt,
  })

  if (!next) throw new Error("No next cycle window found")

  logger.debug(
    `Next billing window: ${new Date(next.start).toUTCString()} - ${new Date(next.end).toUTCString()}`
  )

  // idempotent no-op if already at the correct window
  if (
    subscription.currentCycleStartAt === current.start &&
    subscription.currentCycleEndAt === current.end &&
    subscription.renewAt === next.start
  ) {
    return {
      subscription,
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
      renewAt: next.start,
    }
  }

  try {
    // update subscription for ui purposes
    const subscriptionUpdated = await repo.updateSubscription({
      subscriptionId: subscription.id,
      projectId: subscription.projectId,
      data: {
        planSlug: currentPhase.planVersion.plan.slug,
        renewAt: next.start,
        currentCycleStartAt: current.start,
        currentCycleEndAt: current.end,
      },
    })

    if (!subscriptionUpdated) {
      throw new Error("Subscription not updated")
    }

    return {
      subscription: subscriptionUpdated,
      currentCycleStartAt: current.start,
      currentCycleEndAt: current.end,
    }
  } catch (error) {
    logger.error(error, {
      context: "Error while renewing subscription",
      subscriptionId: subscription.id,
    })
    throw error
  }
}

// invoicing scheduler
// this will materialize all the pending invoices for the current phase or ended phases in the last N days
// the idea is to keep a record of every billing cycle for the subscription
// this way we can rely on these records to finalize and bill the invoices
export async function invoiceSubscription({
  context,
  logger,
  db,
  repo,
  ratingService,
  ledgerService,
}: {
  context: SubscriptionContext
  logger: Logger
  db: Database
  repo: SubscriptionRepository
  ratingService: RatingService
  ledgerService: LedgerGateway
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context
  const billingRepo = new DrizzleBillingRepository(db)

  const periodItemsGroups = await billingRepo.listPendingPeriodGroups({
    projectId: subscription.projectId,
    subscriptionId: subscription.id,
    now,
  })

  logger.info(`Invoicing for ${periodItemsGroups.length} periodItemsGroups`)

  for (const periodItemGroup of periodItemsGroups) {
    const phase = await repo.findPhaseForBilling({
      phaseId: periodItemGroup.subscriptionPhaseId,
      projectId: periodItemGroup.projectId,
      subscriptionId: periodItemGroup.subscriptionId,
    })

    if (!phase || !phase.planVersion || !phase.subscription) {
      continue
    }

    const billingPeriodsToInvoice = await billingRepo.listPendingPeriodsForStatement({
      projectId: periodItemGroup.projectId,
      subscriptionId: periodItemGroup.subscriptionId,
      subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
      statementKey: periodItemGroup.statementKey,
    })

    if (billingPeriodsToInvoice.length === 0) {
      continue
    }

    // 1) Rate each pending period and post deterministic ledger entries first.
    //    Entries are tagged with the statement_key so the invoicing query below
    //    can enumerate them via the gateway's metadata-filtered view.
    for (const period of billingPeriodsToInvoice) {
      const feature = period.subscriptionItem.featurePlanVersion.feature
      const nonUsageQuantity = period.subscriptionItem.units ?? 0
      const usageData =
        period.subscriptionItem.featurePlanVersion.featureType === "usage"
          ? undefined
          : [{ featureSlug: feature.slug, usage: nonUsageQuantity }]

      const ratingResult = await ratingService.rateBillingPeriod({
        projectId: period.projectId,
        customerId: period.customerId,
        featureSlug: feature.slug,
        startAt: period.cycleStartAt,
        endAt: period.cycleEndAt,
        usageData,
      })

      if (ratingResult.err) {
        logger.error(ratingResult.err, {
          billingPeriodId: period.id,
          phaseId: phase.id,
          statementKey: period.statementKey,
          context: "Error while rating billing period before ledger posting",
        })
        throw ratingResult.err
      }

      const ratedCharges = ratingResult.val
      const firstCharge = ratedCharges[0]

      const totalAmount = ratedCharges.reduce<Dinero<number> | null>((sum, charge) => {
        if (sum === null) return charge.price.totalPrice.dinero
        // biome-ignore lint/suspicious/noExplicitAny: dinero add typing
        return (require("dinero.js") as any).add(sum, charge.price.totalPrice.dinero)
      }, null)

      const unitAmount = firstCharge ? firstCharge.price.unitPrice.dinero : null
      const ratedQuantity = ratedCharges.reduce((sum, charge) => sum + Math.max(0, charge.usage), 0)
      const quantity = ratedCharges.length > 0 ? Math.trunc(ratedQuantity) : nonUsageQuantity
      const rawProrationFactor = firstCharge?.prorate
      const prorationFactor =
        period.type === "trial"
          ? 0
          : typeof rawProrationFactor === "number" && Number.isFinite(rawProrationFactor)
            ? rawProrationFactor
            : 1
      const sourceType = "subscription_billing_period_charge_v1"
      const sourceId = `${period.id}:${period.subscriptionItemId}`
      const entryMetadata = {
        subscription_id: period.subscriptionId,
        subscription_phase_id: period.subscriptionPhaseId,
        subscription_item_id: period.subscriptionItemId,
        billing_period_id: period.id,
        feature_plan_version_id: period.subscriptionItem.featurePlanVersion.id,
        invoice_item_kind: (period.type === "trial" ? "trial" : "period") as "trial" | "period",
        cycle_start_at: period.cycleStartAt,
        cycle_end_at: period.cycleEndAt,
        quantity,
        unit_amount_snapshot: unitAmount ? toSnapshot(unitAmount) : null,
        proration_factor: prorationFactor,
        description: feature.title,
      }

      // Trial / zero-amount periods don't post to the ledger — pgledger
      // rejects non-positive transfers and there's no receivable to record.
      if (!totalAmount || isZero(totalAmount)) {
        continue
      }

      if (isNegative(totalAmount)) {
        // Negative period totals would require issuing credits from a grant
        // account, which isn't wired up at the ledger layer. Skip here and
        // let the wallet layer post credits against the customer account.
        logger.warn("Skipping negative billing period — credits land in wallet flow", {
          billingPeriodId: period.id,
          phaseId: phase.id,
        })
        continue
      }

      // Phase 7: flat subscription fees are a direct consumption —
      // `customer.*.available.purchased → customer.*.consumed`. The
      // `kind: "subscription"` + `statement_key` metadata pair makes the
      // transfer a valid invoice line per the projection contract
      // (slice 7.8). If the customer has no purchased balance, the
      // transfer fails atomically (pgledger non-negativity) and the
      // scheduler surfaces the error.
      const postResult = await ledgerService.createTransfer({
        projectId: period.projectId,
        fromAccount: customerAccountKeys(period.customerId).purchased,
        toAccount: customerAccountKeys(period.customerId).consumed,
        amount: totalAmount,
        source: { type: sourceType, id: sourceId },
        statementKey: period.statementKey,
        metadata: {
          ...entryMetadata,
          flow: "subscription",
          kind: "subscription",
          statement_key: period.statementKey,
        },
        eventAt: new Date(now),
      })

      if (postResult.err) {
        logger.error(postResult.err, {
          billingPeriodId: period.id,
          phaseId: phase.id,
          statementKey: period.statementKey,
          context: "Error while posting rated period to ledger",
        })
        throw postResult.err
      }
    }

    // 2) Build invoice lines from entries that share this statement_key.
    //    The new ledger has no settlement table — invoice → ledger linkage
    //    lives in the entry's metadata (`statement_key`, `billing_period_id`).
    const statementEntriesResult = await ledgerService.getEntriesByStatementKey({
      projectId: periodItemGroup.projectId,
      statementKey: periodItemGroup.statementKey,
    })

    if (statementEntriesResult.err) {
      logger.error(statementEntriesResult.err, {
        phaseId: phase.id,
        statementKey: periodItemGroup.statementKey,
        context: "Error while loading statement-key ledger entries",
      })
      throw statementEntriesResult.err
    }

    const ledgerEntriesToInvoice = statementEntriesResult.val.filter(
      (entry: LedgerEntry) =>
        (entry.metadata as Record<string, unknown> | null)?.billing_period_id != null
    )

    if (ledgerEntriesToInvoice.length === 0) {
      await billingRepo.voidPendingPeriods({
        projectId: periodItemGroup.projectId,
        subscriptionId: periodItemGroup.subscriptionId,
        subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
        statementKey: periodItemGroup.statementKey,
      })

      continue
    }

    const statementStartAt = Math.min(
      ...ledgerEntriesToInvoice.map((entry: LedgerEntry) => {
        const meta = entry.metadata as Record<string, unknown> | null
        return (meta?.cycle_start_at as number | undefined) ?? periodItemGroup.invoiceAt
      })
    )
    const statementEndAt = Math.max(
      ...ledgerEntriesToInvoice.map((entry: LedgerEntry) => {
        const meta = entry.metadata as Record<string, unknown> | null
        return (meta?.cycle_end_at as number | undefined) ?? periodItemGroup.invoiceAt
      })
    )

    await db.transaction(async (tx) => {
      try {
        const txBillingRepo = new DrizzleBillingRepository(tx)
        const invoiceAt = periodItemGroup.invoiceAt
        const waitPeriodAdvance = ["minute"].includes(
          phase.planVersion.billingConfig.billingInterval
        )
          ? 1000 * 60 * 1
          : 1000 * 60 * 15

        const waitPeriodArrear = ["minute"].includes(
          phase.planVersion.billingConfig.billingInterval
        )
          ? 1000 * 60 * 1
          : 1000 * 60 * 60

        const timezone = phase.subscription.timezone
        const date = toZonedTime(new Date(invoiceAt), timezone)
        const statementDateString = ["minute"].includes(
          phase.planVersion.billingConfig.billingInterval
        )
          ? format(date, "MMMM d, yyyy hh:mm a")
          : format(date, "MMMM d, yyyy")

        const dueAt =
          phase.planVersion.whenToBill === "pay_in_advance"
            ? invoiceAt + waitPeriodAdvance
            : invoiceAt + waitPeriodArrear

        const pastDueAt = calculateDateAt({
          startDate: dueAt,
          config: {
            interval: phase.planVersion.billingConfig.billingInterval,
            units: phase.planVersion.gracePeriod,
          },
        })

        let invoice = await txBillingRepo.createInvoice({
          id: newId("invoice"),
          projectId: phase.projectId,
          subscriptionId: phase.subscriptionId,
          customerId: phase.subscription.customerId,
          requiredPaymentMethod: phase.planVersion.paymentMethodRequired,
          paymentMethodId: phase.paymentMethodId ?? null,
          status: "draft",
          statementDateString: statementDateString,
          statementKey: periodItemGroup.statementKey,
          statementStartAt: statementStartAt,
          statementEndAt: statementEndAt,
          whenToBill: phase.planVersion.whenToBill,
          collectionMethod: phase.planVersion.collectionMethod,
          invoicePaymentProviderId: "",
          invoicePaymentProviderUrl: "",
          paymentProvider: phase.paymentProvider,
          currency: phase.planVersion.currency,
          pastDueAt: pastDueAt,
          dueAt: dueAt,
          paidAt: null,
          totalAmount: 0,
          issueDate: null,
          metadata: { note: "Invoiced by scheduler" },
        })

        if (!invoice) {
          invoice = await txBillingRepo.findInvoiceByStatementKey({
            statementKey: periodItemGroup.statementKey,
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            customerId: phase.subscription.customerId,
          })
        }

        if (!invoice) {
          logger.error("Invoice not created", {
            phaseId: phase.id,
            statementStartAt: statementStartAt,
            statementEndAt: statementEndAt,
          })

          return
        }

        // Phase 7: no `invoice_items` table. The invoice total is the sum
        // of ledger entries credited to `customer.*.consumed` under this
        // statement_key — same entries the API projects on read
        // (slice 7.8). We sum here to stamp `invoices.totalAmount` for
        // fast header reads; lines are re-derived from the ledger.
        const totalAmount = ledgerEntriesToInvoice.reduce(
          (sum: number, entry: LedgerEntry) => sum + formatAmountForProvider(entry.amount).amount,
          0
        )

        await txBillingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId: phase.projectId,
          data: {
            totalAmount,
            updatedAtM: now,
          },
        })

        const periodIdsToMark = billingPeriodsToInvoice.map((p) => p.id)
        if (periodIdsToMark.length > 0) {
          await txBillingRepo.markPeriodsInvoiced({
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            periodIds: periodIdsToMark,
            invoiceId: invoice.id,
          })
        }
      } catch (error) {
        logger.error(error, {
          phaseId: phase.id,
          statementStartAt: statementStartAt,
          statementEndAt: statementEndAt,
          context: "Error while invoicing phase",
        })

        // Drizzle auto-rolls back on throw — no explicit tx.rollback() needed.
        throw error
      }
    })
  }

  return {
    phasesProcessed: periodItemsGroups.length,
    subscription,
  }
}


