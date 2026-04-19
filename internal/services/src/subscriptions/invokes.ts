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
import type { LedgerEntry, LedgerGateway } from "../ledger"
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
    logger.error(
      `Error while renewing subscription ${error instanceof Error ? error.message : "unknown error"}`,
      {
        error: toErrorContext(error),
        subscriptionId: subscription.id,
      }
    )
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
        logger.error("Error while rating billing period before ledger posting", {
          billingPeriodId: period.id,
          phaseId: phase.id,
          statementKey: period.statementKey,
          error: toErrorContext(ratingResult.err),
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

      const postResult = await ledgerService.postCharge({
        projectId: period.projectId,
        customerId: period.customerId,
        currency: phase.planVersion.currency,
        amount: totalAmount,
        source: { type: sourceType, id: sourceId },
        statementKey: period.statementKey,
        metadata: entryMetadata,
        eventAt: new Date(now),
      })

      if (postResult.err) {
        logger.error("Error while posting rated period to ledger", {
          billingPeriodId: period.id,
          phaseId: phase.id,
          statementKey: period.statementKey,
          error: toErrorContext(postResult.err),
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
      logger.error("Error while loading statement-key ledger entries", {
        phaseId: phase.id,
        statementKey: periodItemGroup.statementKey,
        error: toErrorContext(statementEntriesResult.err),
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
          subtotalCents: 0,
          paymentAttempts: [],
          totalCents: 0,
          amountCreditUsed: 0,
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

        const projectedInvoiceItems = ledgerEntriesToInvoice.map((entry: LedgerEntry) => {
          const meta = entry.metadata as Record<string, unknown> | null
          const prorationRaw = meta?.proration_factor
          const prorationFactor =
            typeof prorationRaw === "number" && Number.isFinite(prorationRaw) ? prorationRaw : 1

          const unitSnap = meta?.unit_amount_snapshot as
            | { amount: number; scale: number; currency: { code: string; exponent: number } }
            | undefined
          const unitAmountCents = unitSnap ? convertSnapshotToProviderCents(unitSnap) : 0
          const lineCents = formatAmountForProvider(entry.amount).amount
          const description = (meta?.description as string | undefined) ?? null

          return {
            id: newId("invoice_item"),
            invoiceId: invoice.id,
            featurePlanVersionId: (meta?.feature_plan_version_id as string | undefined) ?? null,
            subscriptionItemId: (meta?.subscription_item_id as string | undefined) ?? null,
            billingPeriodId: (meta?.billing_period_id as string | undefined) ?? null,
            projectId: periodItemGroup.projectId,
            quantity: Math.max(0, Math.trunc((meta?.quantity as number | undefined) ?? 0)),
            cycleStartAt: (meta?.cycle_start_at as number | undefined) ?? statementStartAt,
            cycleEndAt: (meta?.cycle_end_at as number | undefined) ?? statementEndAt,
            kind: ((meta?.invoice_item_kind as string | undefined) ?? "period") as
              | "period"
              | "tax"
              | "discount"
              | "refund"
              | "adjustment"
              | "trial",
            unitAmountCents,
            amountSubtotal: lineCents,
            amountTotal: lineCents,
            prorationFactor,
            description,
            itemProviderId: null,
            ledgerTransferId: entry.transferId,
          }
        })

        await txBillingRepo.createInvoiceItemsBatch({ items: projectedInvoiceItems })

        // Compute and persist invoice totals from the projected items.
        const itemAmounts = await txBillingRepo.listInvoiceItemAmounts({
          invoiceId: invoice.id,
          projectId: phase.projectId,
        })

        const subtotalCents = itemAmounts.reduce((sum, item) => sum + (item.amountSubtotal ?? 0), 0)
        const totalCents = itemAmounts.reduce((sum, item) => sum + (item.amountTotal ?? 0), 0)

        await txBillingRepo.updateInvoice({
          invoiceId: invoice.id,
          projectId: phase.projectId,
          data: {
            subtotalCents,
            totalCents,
            updatedAtM: now,
          },
        })

        const invoiceItemsInserted = await txBillingRepo.listInvoiceItemBillingPeriodIds({
          invoiceId: invoice.id,
          projectId: phase.projectId,
        })

        const periodIdsToMark = invoiceItemsInserted
          .map((item) => item.billingPeriodId)
          .filter((id): id is string => id !== null)

        if (periodIdsToMark.length > 0) {
          await txBillingRepo.markPeriodsInvoiced({
            projectId: phase.projectId,
            subscriptionId: phase.subscriptionId,
            periodIds: periodIdsToMark,
            invoiceId: invoice.id,
          })
        }

        // No "settle" step in the new ledger — entries point at this invoice
        // via the shared statement_key in metadata.
      } catch (error) {
        logger.error("Error while invoicing phase", {
          phaseId: phase.id,
          statementStartAt: statementStartAt,
          statementEndAt: statementEndAt,
          error: toErrorContext(error),
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

// Convert a Dinero scale-N snapshot back into the provider scale-2 cent value
// invoice_items expect. The snapshot's `currency.exponent` carries the target
// scale (e.g. 2 for USD); rounding mirrors `formatAmountForProvider`'s behavior.
function convertSnapshotToProviderCents(snapshot: {
  amount: number
  scale: number
  currency: { exponent: number }
}): number {
  const targetScale = snapshot.currency.exponent
  const diff = snapshot.scale - targetScale
  if (diff <= 0) return snapshot.amount
  const divisor = 10 ** diff
  return Math.round(snapshot.amount / divisor)
}
