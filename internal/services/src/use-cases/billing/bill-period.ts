import { type Database, and, asc, eq, sql } from "@unprice/db"
import { billingPeriods } from "@unprice/db/schema"
import { isZero, newId, toSnapshot } from "@unprice/db/utils"
import { type Currency, type RateRow, calculateDateAt } from "@unprice/db/validators"
import type { Logger } from "@unprice/logs"
import { fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import { toZonedTime } from "date-fns-tz"
import { format } from "date-fns/format"
import { isNegative } from "dinero.js"
import { summarizeInvoiceSettlementAmounts } from "../../billing/invoice-settlement"
import { DrizzleBillingRepository } from "../../billing/repository.drizzle"
import { billingStrategyForInterval } from "../../billing/strategy"
import { LATE_EVENT_GRACE_MS } from "../../entitlements"
import { type InvoiceLine, type LedgerGateway, customerAccountKeys } from "../../ledger"
import type { RateCardService } from "../../rate-cards/service"
import type { SubscriptionRepository } from "../../subscriptions/repository"
import type { SubscriptionContext } from "../../subscriptions/types"
import { billingPeriodIdOf } from "../budgets/compile-payer-budget"
import type { PayerStatementLine } from "../budgets/invoice-payer-statements"
import type { PayerBudgetGateway } from "../budgets/payer-budget-gateway"
import { resolvePeriodCharge } from "./period-charge"

/**
 * What invoicing reads besides the database (ADR-0008 D4): the payer budget, whose sealed
 * statements carry the usage it priced at ingestion, and the plan version's rate card, which
 * prices recurring items.
 */
export type InvoicingPorts = {
  /** Null where billing reaches no payer budget; a statement with metered periods then fails. */
  payerBudgets: PayerBudgetGateway | null
  rateCards: Pick<RateCardService, "cardForPlanVersion" | "getEffectiveRows">
}

export async function billPeriod({
  context,
  logger,
  db,
  repo,
  ledgerService,
  invoicing,
  lateEventGraceMs = LATE_EVENT_GRACE_MS,
}: {
  context: SubscriptionContext
  logger: Logger
  db: Database
  repo: SubscriptionRepository
  ledgerService: LedgerGateway
  invoicing: InvoicingPorts
  /** How long usage of an ended period may still arrive; a cancel invoices at once with 0. */
  lateEventGraceMs?: number
}): Promise<
  Partial<SubscriptionContext> & {
    phasesProcessed: number
  }
> {
  const { subscription, now } = context
  const billingRepo = new DrizzleBillingRepository(db)
  const { payerBudgets } = invoicing
  // The budget may drop the statements of committed invoices, including any whose completion
  // failed after an earlier commit.
  const completeStatements = async () => {
    if (!payerBudgets) return
    const completed = await payerBudgets.completeInvoiced({
      projectId: subscription.projectId,
      customerId: context.customer.id,
    })
    if (completed.err) throw completed.err
  }
  await completeStatements()

  const periodItemsGroups = await billingRepo.listPendingPeriodGroups({
    lateEventGraceMs,
    projectId: subscription.projectId,
    subscriptionId: subscription.id,
    now,
  })

  // If no periods are ready to invoice, check whether there are future pending
  // periods and report the next invoice date — similar to how renewal rejects
  // early attempts with "subscription will be renewed at <date>".
  if (periodItemsGroups.length === 0) {
    const [nextPending] = await db
      .select({ invoiceAt: billingPeriods.invoiceAt })
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.status, "pending"),
          eq(billingPeriods.projectId, subscription.projectId),
          eq(billingPeriods.subscriptionId, subscription.id)
        )
      )
      .orderBy(asc(billingPeriods.invoiceAt))
      .limit(1)

    if (nextPending) {
      if (nextPending.invoiceAt <= now) {
        return {
          phasesProcessed: 0,
          subscription,
        }
      }

      const nextInvoiceDate = new Date(nextPending.invoiceAt).toLocaleString()
      throw new Error(`Cannot invoice subscription, next invoice date is at ${nextInvoiceDate}`)
    }

    const [lastInvoiced] = await db
      .select({ id: billingPeriods.id })
      .from(billingPeriods)
      .where(
        and(
          eq(billingPeriods.status, "invoiced"),
          eq(billingPeriods.projectId, subscription.projectId),
          eq(billingPeriods.subscriptionId, subscription.id)
        )
      )
      .limit(1)

    if (lastInvoiced) {
      return {
        phasesProcessed: 0,
        subscription,
      }
    }

    throw new Error("Cannot invoice subscription, there are no pending billing periods to invoice")
  }

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

    const statements = await sealStatements({
      payerBudgets,
      projectId: phase.projectId,
      customerId: phase.subscription.customerId,
      group: periodItemGroup,
      now,
      db,
    })
    const rows = await recurringRows(invoicing.rateCards, phase)

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
      //    double-post.
      for (const period of billingPeriodsToInvoice) {
        const feature = period.subscriptionItem.featurePlanVersion.feature
        const featurePlanVersionItemId = period.subscriptionItem.id
        const walletSettlementForItem = await ledgerService.getInvoiceLines(
          {
            projectId: phase.projectId,
            statementKey: periodItemGroup.statementKey,
          },
          tx
        )

        if (walletSettlementForItem.err) {
          logger.error(walletSettlementForItem.err, {
            billingPeriodId: period.id,
            phaseId: phase.id,
            statementKey: periodItemGroup.statementKey,
            context: "Error while loading wallet settlement lines before ledger posting",
          })
          throw walletSettlementForItem.err
        }

        const charge = resolvePeriodCharge({
          period,
          currency: phase.planVersion.currency,
          phase,
          statement: statements.get(period.id) ?? null,
          rows,
          statementLines: walletSettlementForItem.val,
        })
        const {
          grossChargeAmount,
          unitAmount,
          quantity,
          prorationFactor,
          collectableAmount,
          cost,
        } = charge
        const sourceType = "subscription_billing_period_charge_v1"
        const sourceId = `${period.id}:${period.subscriptionItemId}`
        const kind = period.type === "trial" ? "trial" : charge.kind
        const entryMetadata = {
          subscription_id: period.subscriptionId,
          subscription_phase_id: period.subscriptionPhaseId,
          subscription_item_id: period.subscriptionItemId,
          billing_period_id: period.id,
          feature_plan_version_id: period.subscriptionItem.featurePlanVersion.id,
          feature_plan_version_item_id: featurePlanVersionItemId,
          line_kind: (period.type === "trial" ? "trial" : "period") as "trial" | "period",
          cycle_start_at: period.cycleStartAt,
          cycle_end_at: period.cycleEndAt,
          quantity,
          unit_amount_snapshot: unitAmount ? toSnapshot(unitAmount) : null,
          proration_factor: prorationFactor,
          description: feature.title,
          feature_slug: feature.slug,
          ...(cost !== null && { cost_usd: cost }),
        }

        // Trial / zero-amount periods don't post to the ledger — pgledger
        // rejects non-positive transfers and there's no receivable to record.
        if (isZero(grossChargeAmount)) {
          continue
        }

        if (isNegative(grossChargeAmount)) {
          // Negative period totals would require issuing credits from a grant
          // account, which isn't wired up at the ledger layer. Skip here and
          // let the wallet layer post credits against the customer account.
          logger.warn("Skipping negative billing period — credits land in wallet flow", {
            billingPeriodId: period.id,
            phaseId: phase.id,
          })
          continue
        }

        if (collectableAmount <= 0) {
          continue
        }

        // Flat fees and rated period charges debit `customer.*.receivable`
        // (debit-normal, allow-negative) and credit `consumed`. Receivable
        // goes negative = customer owes us. The post-payment settlement
        // posts `topup → receivable` to zero it out. This decouples invoice
        // creation from cash-on-hand: invoices can be drafted before any
        // payment, and `purchased` stays a strict cash-only account.
        // The `kind: "subscription"` + `statement_key` metadata pair keeps
        // the transfer projectable as an invoice line.
        const postResult = await ledgerService.createTransfer(
          {
            projectId: period.projectId,
            fromAccount: customerAccountKeys(period.customerId).receivable,
            toAccount: customerAccountKeys(period.customerId).consumed,
            amount: fromLedgerMinor(collectableAmount, phase.planVersion.currency),
            source: { type: sourceType, id: sourceId },
            statementKey: period.statementKey,
            metadata: {
              ...entryMetadata,
              flow: "subscription",
              kind,
              collectable: true,
              settlement_source: phase.creditLinePolicy === "capped" ? "credit_line" : "provider",
              settlement_status: "due",
              source_id: `${period.id}:${featurePlanVersionItemId}`,
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

      const statementStartAt =
        linesToInvoice.length > 0
          ? Math.min(
              ...linesToInvoice.map((line: InvoiceLine) => {
                const meta = line.metadata as Record<string, unknown> | null
                return (meta?.cycle_start_at as number | undefined) ?? periodItemGroup.invoiceAt
              })
            )
          : Math.min(...billingPeriodsToInvoice.map((period) => period.cycleStartAt))
      const statementEndAt =
        linesToInvoice.length > 0
          ? Math.max(
              ...linesToInvoice.map((line: InvoiceLine) => {
                const meta = line.metadata as Record<string, unknown> | null
                return (meta?.cycle_end_at as number | undefined) ?? periodItemGroup.invoiceAt
              })
            )
          : Math.max(...billingPeriodsToInvoice.map((period) => period.cycleEndAt))

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
        grossAmount: 0,
        amountDue: 0,
        amountPaid: 0,
        amountIncluded: 0,
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

      const totals = summarizeInvoiceSettlementAmounts(
        linesToInvoice.map((line) => ({
          amount: toLedgerMinor(line.amount),
          metadata: line.metadata,
        }))
      )

      await txBillingRepo.updateInvoice({
        invoiceId: invoice.id,
        projectId: phase.projectId,
        data: {
          amountDue: totals.amountDue,
          amountIncluded: totals.amountIncluded,
          amountPaid: totals.amountPaid,
          grossAmount: totals.grossAmount,
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
    await completeStatements()
  }

  return {
    phasesProcessed: periodItemsGroups.length,
    subscription,
  }
}

/**
 * Seals the payer budget's statements of the group's key (ADR-0008 D4) and answers the sealed
 * ones by billing period. The seal cuts off at the invoice time, and never before the end of a
 * metered period of the key, so each one's statement seals; a statement still open has not ended
 * for the budget yet, and invoicing waits for the next attempt. A group without metered periods
 * seals nothing.
 */
async function sealStatements(input: {
  payerBudgets: PayerBudgetGateway | null
  projectId: string
  customerId: string
  group: { subscriptionId: string; subscriptionPhaseId: string; statementKey: string }
  now: number
  db: Database
}): Promise<Map<string, PayerStatementLine>> {
  const { group } = input
  const pending = await input.db.query.billingPeriods.findMany({
    columns: { id: true, cycleEndAt: true },
    where: (period, ops) =>
      ops.and(
        ops.eq(period.projectId, input.projectId),
        ops.eq(period.subscriptionId, group.subscriptionId),
        ops.eq(period.subscriptionPhaseId, group.subscriptionPhaseId),
        ops.eq(period.statementKey, group.statementKey),
        ops.eq(period.status, "pending")
      ),
    with: {
      subscriptionItem: { with: { featurePlanVersion: { columns: { featureType: true } } } },
    },
  })
  const metered = pending.filter(
    (period) => period.subscriptionItem.featurePlanVersion.featureType === "usage"
  )
  if (metered.length === 0) return new Map()
  if (!input.payerBudgets) {
    throw new Error(`Statement ${group.statementKey} has metered periods but no payer budget`)
  }
  // A phase's last statement ends 1 ms past the phase's inclusive end, where its period ends.
  const at = Math.max(input.now, ...metered.map((period) => period.cycleEndAt + 1))
  const sealed = await input.payerBudgets.seal({
    projectId: input.projectId,
    customerId: input.customerId,
    statementKey: group.statementKey,
    at,
  })
  if (sealed.err) throw sealed.err
  const open = sealed.val.open.map(billingPeriodIdOf)
  const unsealed = metered.filter((period) => open.includes(period.id))
  if (unsealed.length > 0) {
    const ids = unsealed.map((period) => period.id).join(", ")
    throw new Error(`Statement ${group.statementKey} still has open usage for ${ids}; retry later`)
  }
  return new Map(sealed.val.sealed.map((line) => [line.billingPeriodId, line]))
}

/** The rows of the phase's plan card in its currency; empty when the plan prices nothing. */
async function recurringRows(
  rateCards: InvoicingPorts["rateCards"],
  phase: { projectId: string; planVersionId: string; planVersion: { currency: Currency } }
): Promise<RateRow[]> {
  const { currency } = phase.planVersion
  const card = await rateCards.cardForPlanVersion(phase.projectId, phase.planVersionId, currency)
  if (!card) return []
  if (card.unit !== `money:${currency}`) {
    throw new Error(
      `Card ${card.cardId} prices in ${card.unit}; an invoice in ${currency} needs money`
    )
  }
  return rateCards.getEffectiveRows({
    projectId: phase.projectId,
    cardIds: [card.cardId],
    from: 0,
    to: Number.MAX_SAFE_INTEGER,
  })
}
