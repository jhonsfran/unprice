import type { Database } from "@unprice/db"
import { type Dinero, isZero, newId, toSnapshot } from "@unprice/db/utils"
import { calculateDateAt } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { formatAmountForProvider } from "@unprice/money"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { isNegative } from "dinero.js"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import { billingStrategyForInterval } from "../../billing/strategy"
import { type LedgerEntry, type LedgerGateway, customerAccountKeys } from "../../ledger"
import type { RatingService } from "../../rating/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import type { SubscriptionContext } from "../../subscriptions/types"

/**
 * BILL phase. Materializes pending billing periods into ledger entries +
 * invoice rows for one subscription. Called from the XState `invoicing`
 * state actor; safe to run repeatedly (idempotent on the period →
 * statement_key → invoice projection).
 *
 * Sequence per pending period group:
 *   1. Rate each pending period (RatingService).
 *   2. Post `customer.receivable → customer.consumed` ledger transfers
 *      tagged with the statement_key.
 *   3. Aggregate posted entries into a single invoice row stamped with
 *      `totalAmount` and the statement window.
 *   4. Mark the periods as `invoiced`.
 *
 * Skipped for wallet-only subscriptions — the machine guard routes RENEW
 * straight to `activating` without going through `invoicing`.
 */
export async function billPeriod({
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

      // Flat fees and rated period charges debit `customer.*.receivable`
      // (debit-normal, allow-negative) and credit `consumed`. Receivable
      // goes negative = customer owes us. The post-payment settlement
      // posts `topup → receivable` to zero it out. This decouples invoice
      // creation from cash-on-hand: invoices can be drafted before any
      // payment, and `purchased` stays a strict cash-only account.
      // The `kind: "subscription"` + `statement_key` metadata pair keeps
      // the transfer projectable as an invoice line (slice 7.8).
      const postResult = await ledgerService.createTransfer({
        projectId: period.projectId,
        fromAccount: customerAccountKeys(period.customerId).receivable,
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
        const strategy = billingStrategyForInterval(
          phase.planVersion.whenToBill,
          phase.planVersion.billingConfig.billingInterval
        )

        const timezone = phase.subscription.timezone
        const date = toZonedTime(new Date(invoiceAt), timezone)
        const statementDateString = ["minute"].includes(
          phase.planVersion.billingConfig.billingInterval
        )
          ? format(date, "MMMM d, yyyy hh:mm a")
          : format(date, "MMMM d, yyyy")

        // BILL phase: invoice-driven modes always have a non-null offset.
        // wallet-only mode never reaches this code path (BILL is skipped via
        // the machine guard).
        const dueAt = invoiceAt + (strategy.invoiceDueOffsetMs ?? 0)

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
