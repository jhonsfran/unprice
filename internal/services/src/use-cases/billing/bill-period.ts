import { type Database, sql } from "@unprice/db"
import { type Dinero, isZero, newId, toSnapshot } from "@unprice/db/utils"
import { calculateDateAt } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { add, formatAmountForProvider } from "@unprice/money"
import { format } from "date-fns"
import { toZonedTime } from "date-fns-tz"
import { isNegative } from "dinero.js"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import { billingStrategyForInterval } from "../../billing/strategy"
import { type InvoiceLine, type LedgerGateway, customerAccountKeys } from "../../ledger"
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

    // Serialize concurrent re-runs for the same statement and wrap the entire
    // BILL flow (rate → ledger transfers → invoice upsert → mark periods
    // invoiced) in a single transaction. The advisory lock is keyed on
    // statement_key so two parallel `billPeriod` calls for the same statement
    // queue rather than racing. Ledger transfer idempotency is the source of
    // truth for "did we already post this charge?" — the lock + transaction
    // guarantee atomicity across the rate/post/invoice/mark steps so we never
    // commit a partial state (e.g. ledger posted but periods still pending).
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`bill:${periodItemGroup.projectId}:${periodItemGroup.statementKey}`}))`
      )

      const txBillingRepo = new DrizzleBillingRepository(tx)

      const billingPeriodsToInvoice = await txBillingRepo.listPendingPeriodsForStatement({
        projectId: periodItemGroup.projectId,
        subscriptionId: periodItemGroup.subscriptionId,
        subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
        statementKey: periodItemGroup.statementKey,
      })

      if (billingPeriodsToInvoice.length === 0) {
        return
      }

      // 1) Rate each pending period and post deterministic ledger entries
      //    first. Entries are tagged with statement_key so the invoicing
      //    query below can enumerate them via the gateway's
      //    metadata-filtered view. Ledger transfers dedupe on
      //    (sourceType, sourceId), so re-runs after a partial failure never
      //    double-post (HARD-004).
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
          return add(sum, charge.price.totalPrice.dinero)
        }, null)

        const unitAmount = firstCharge ? firstCharge.price.unitPrice.dinero : null
        const ratedQuantity = ratedCharges.reduce(
          (sum, charge) => sum + Math.max(0, charge.usage),
          0
        )
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
        const postResult = await ledgerService.createTransfer(
          {
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
          },
          tx
        )

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

      // 2) Project invoice lines from the ledger. `getInvoiceLines` returns
      //    one row per credit-leg transfer landing on `customer.*.consumed`
      //    under this `(projectId, statement_key)` — i.e. exactly what an
      //    invoice should show. Same primitive used by the read-side API
      //    (`getInvoiceV1`, `getInvoiceById`) and by `_upsertPaymentProviderInvoice`
      //    when it `addInvoiceItem`s to Stripe, so the customer-facing invoice
      //    matches our local invoice byte-for-byte. The `billing_period_id`
      //    filter scopes us to bill-period-emitted lines (vs wallet usage
      //    lines that may share the statement key).
      const linesResult = await ledgerService.getInvoiceLines(
        {
          projectId: periodItemGroup.projectId,
          statementKey: periodItemGroup.statementKey,
        },
        tx
      )

      if (linesResult.err) {
        logger.error(linesResult.err, {
          phaseId: phase.id,
          statementKey: periodItemGroup.statementKey,
          context: "Error while loading statement-key invoice lines",
        })
        throw linesResult.err
      }

      const linesToInvoice = linesResult.val.filter(
        (line: InvoiceLine) =>
          (line.metadata as Record<string, unknown> | null)?.billing_period_id != null
      )

      if (linesToInvoice.length === 0) {
        await txBillingRepo.voidPendingPeriods({
          projectId: periodItemGroup.projectId,
          subscriptionId: periodItemGroup.subscriptionId,
          subscriptionPhaseId: periodItemGroup.subscriptionPhaseId,
          statementKey: periodItemGroup.statementKey,
        })

        return
      }

      const statementStartAt = Math.min(
        ...linesToInvoice.map((line: InvoiceLine) => {
          const meta = line.metadata as Record<string, unknown> | null
          return (meta?.cycle_start_at as number | undefined) ?? periodItemGroup.invoiceAt
        })
      )
      const statementEndAt = Math.max(
        ...linesToInvoice.map((line: InvoiceLine) => {
          const meta = line.metadata as Record<string, unknown> | null
          return (meta?.cycle_end_at as number | undefined) ?? periodItemGroup.invoiceAt
        })
      )

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

      // Atomic upsert with RETURNING — the unique key
      // (projectId, subscriptionId, customerId, statementKey) makes this the
      // single canonical row per statement; no fallback SELECT is needed.
      const invoice = await txBillingRepo.createInvoice({
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
        // With ON CONFLICT DO UPDATE ... RETURNING, this branch is
        // unreachable barring DB driver pathology. Treat as fatal so the tx
        // rolls back and the caller retries — silent return previously
        // stranded periods in `pending`.
        throw new Error(
          `Invoice upsert returned no row for statement ${periodItemGroup.statementKey}`
        )
      }

      // Phase 7: no `invoice_items` table. The invoice total is the sum
      // of credit-leg ledger transfers landing on `customer.*.consumed`
      // under this statement_key — same projection the API uses on read
      // (slice 7.8). We sum the line Dineros (which are at `LEDGER_SCALE = 8`)
      // and quantize once at the boundary via `formatAmountForProvider` so
      // `invoices.totalAmount` is in currency minor units (cents) — matching
      // what the payment provider receives in `addInvoiceItem` /
      // `createInvoice`. Summing `.toJSON().amount` per-line would yield
      // scale-8 minor units, not cents.
      const totalDinero = linesToInvoice.reduce<Dinero<number> | null>(
        (sum, line) => (sum === null ? line.amount : add(sum, line.amount)),
        null
      )
      const totalAmountForInvoice = totalDinero ? formatAmountForProvider(totalDinero).amount : 0

      await txBillingRepo.updateInvoice({
        invoiceId: invoice.id,
        projectId: phase.projectId,
        data: {
          totalAmount: totalAmountForInvoice,
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
    })
  }

  return {
    phasesProcessed: periodItemsGroups.length,
    subscription,
  }
}
