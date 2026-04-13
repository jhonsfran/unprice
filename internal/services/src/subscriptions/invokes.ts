import type { Database } from "@unprice/db"
import { formatAmountForLedger, ledgerAmountToCents, newId, randomId } from "@unprice/db/utils"
import { calculateCycleWindow, calculateDateAt } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { DrizzleBillingRepository } from "../billing/repository.drizzle"
import type { CustomerService } from "../customers/service"
import { DrizzleLedgerRepository } from "../ledger/repository.drizzle"
import type { LedgerService } from "../ledger/service"
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
  ledgerService: LedgerService
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

    // Generate a journalId for this statement group so all entries can be
    // settled atomically via settleJournal instead of query-filter-by-IDs.
    const journalId = `jrnl_${randomId()}`

    // 1) Rate each pending period and post deterministic ledger entries first.
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

      const totalAmountMinor = ratedCharges.reduce(
        (sum, charge) => sum + BigInt(formatAmountForLedger(charge.price.totalPrice.dinero).amount),
        BigInt(0)
      )
      const unitAmountMinor = firstCharge
        ? BigInt(formatAmountForLedger(firstCharge.price.unitPrice.dinero).amount)
        : BigInt(0)
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
        subscriptionId: period.subscriptionId,
        subscriptionPhaseId: period.subscriptionPhaseId,
        subscriptionItemId: period.subscriptionItemId,
        billingPeriodId: period.id,
        featurePlanVersionId: period.subscriptionItem.featurePlanVersion.id,
        invoiceItemKind: (period.type === "trial" ? "trial" : "period") as "trial" | "period",
        cycleStartAt: period.cycleStartAt,
        cycleEndAt: period.cycleEndAt,
        quantity,
        unitAmountMinor: unitAmountMinor.toString(),
        prorationFactor,
      }
      const ledgerRepo = new DrizzleLedgerRepository(db)

      // Post $0 trial entries for audit trail completeness (they won't appear
      // on invoices but maintain a continuous ledger history).
      if (totalAmountMinor === BigInt(0)) {
        // Skip ledger post for $0 — the ledger rejects zero amounts.
        // Record a zero-amount audit entry only for trials so they leave a trace.
        if (period.type === "trial") {
          await ledgerService.postDebit({
            projectId: period.projectId,
            customerId: period.customerId,
            currency: phase.planVersion.currency,
            amountMinor: BigInt(1), // minimum representable unit (sub-cent)
            sourceType,
            sourceId,
            statementKey: period.statementKey,
            journalId,
            description: `${feature.title} (trial - $0)`,
            metadata: { ...entryMetadata, invoiceItemKind: "trial" },
            repo: ledgerRepo,
            now,
          })
        }
        continue
      }

      const postResult =
        totalAmountMinor < BigInt(0)
          ? await ledgerService.postCredit({
              projectId: period.projectId,
              customerId: period.customerId,
              currency: phase.planVersion.currency,
              amountMinor: -totalAmountMinor,
              sourceType,
              sourceId,
              statementKey: period.statementKey,
              journalId,
              description: feature.title,
              metadata: entryMetadata,
              repo: ledgerRepo,
              now,
            })
          : await ledgerService.postDebit({
              projectId: period.projectId,
              customerId: period.customerId,
              currency: phase.planVersion.currency,
              amountMinor: totalAmountMinor,
              sourceType,
              sourceId,
              statementKey: period.statementKey,
              journalId,
              description: feature.title,
              metadata: entryMetadata,
              repo: ledgerRepo,
              now,
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

    // 2) Build invoice lines from journal entries (all entries posted above share the same journalId).
    const journalEntriesResult = await ledgerService.getEntriesByJournal({
      projectId: periodItemGroup.projectId,
      journalId,
      repo: new DrizzleLedgerRepository(db),
    })

    if (journalEntriesResult.err) {
      logger.error("Error while loading journal ledger entries", {
        phaseId: phase.id,
        journalId,
        statementKey: periodItemGroup.statementKey,
        error: toErrorContext(journalEntriesResult.err),
      })
      throw journalEntriesResult.err
    }

    const ledgerEntriesToInvoice = journalEntriesResult.val.filter(
      (entry) => entry.metadata?.billingPeriodId != null
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
      ...ledgerEntriesToInvoice.map(
        (entry) => entry.metadata?.cycleStartAt ?? periodItemGroup.invoiceAt
      )
    )
    const statementEndAt = Math.max(
      ...ledgerEntriesToInvoice.map(
        (entry) => entry.metadata?.cycleEndAt ?? periodItemGroup.invoiceAt
      )
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

        const projectedInvoiceItems = ledgerEntriesToInvoice.map((entry) => {
          const meta = entry.metadata
          const prorationRaw = meta?.prorationFactor
          const prorationFactor =
            typeof prorationRaw === "number" && Number.isFinite(prorationRaw) ? prorationRaw : 1

          const unitAmountMinorBigint = meta?.unitAmountMinor ? BigInt(meta.unitAmountMinor) : null

          return {
            id: newId("invoice_item"),
            invoiceId: invoice.id,
            featurePlanVersionId: meta?.featurePlanVersionId ?? null,
            subscriptionItemId: meta?.subscriptionItemId ?? null,
            billingPeriodId: meta?.billingPeriodId ?? null,
            projectId: entry.projectId,
            quantity: Math.max(0, Math.trunc(meta?.quantity ?? 0)),
            cycleStartAt: meta?.cycleStartAt ?? statementStartAt,
            cycleEndAt: meta?.cycleEndAt ?? statementEndAt,
            kind: meta?.invoiceItemKind ?? "period",
            unitAmountCents: unitAmountMinorBigint ? ledgerAmountToCents(unitAmountMinorBigint) : 0,
            amountSubtotal: ledgerAmountToCents(entry.amountMinor),
            amountTotal: ledgerAmountToCents(entry.amountMinor),
            prorationFactor,
            description: entry.description ?? null,
            itemProviderId: null,
            ledgerEntryId: entry.id,
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

        // Settle via journalId — all entries for this statement share the same journal.
        const txLedgerRepo = new DrizzleLedgerRepository(tx)
        const settleResult = await ledgerService.settleJournal({
          projectId: phase.projectId,
          journalId,
          type: "invoice",
          artifactId: invoice.id,
          now,
          repo: txLedgerRepo,
        })

        if (settleResult.err) {
          throw settleResult.err
        }
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
