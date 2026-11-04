import type { Dinero } from "@unprice/db/utils"
import {
  type CreditLinePolicy,
  type Currency,
  type RateRow,
  billingConfigSchema,
  calculateProration,
} from "@unprice/db/validators"
import { AMOUNT_ONE, fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import type { BillingPeriodWithItem } from "../../billing/repository"
import type { InvoiceLine } from "../../ledger"
import { isEffective, priceQuantity } from "../../pricing"
import type { PayerStatementLine } from "../budgets/invoice-payer-statements"

export type PeriodCharge = {
  kind: "usage" | "subscription"
  grossChargeAmount: Dinero<number>
  /** What one unit costs; null for usage, whose statement priced each event where it landed. */
  unitAmount: Dinero<number> | null
  quantity: number
  prorationFactor: number
  /** USD at the ledger scale; null when no priced usage line carried a cost. */
  cost: number | null
  collectableAmount: number
}

type ChargeInput = {
  period: BillingPeriodWithItem
  currency: Currency
  /**
   * The phase's service window (its end is inclusive) and the anchor it resolved: a recurring
   * charge prorates over the part of its period the phase covers. A capped phase is prepaid: the
   * wallet captures its usage.
   */
  phase: {
    startAt: number
    endAt: number | null
    billingAnchor: number
    creditLinePolicy?: CreditLinePolicy
  }
  /**
   * The sealed statement of a metered period, or null when the payer budget never registered it:
   * a budget that requires statements accepts no usage without one, so nothing was used.
   */
  statement: PayerStatementLine | null
  /** The plan version card's rows effective in the period; empty when the plan has no card. */
  rows: readonly RateRow[]
  /** The statement key's ledger lines: wallet captures and settlements already cover part of it. */
  statementLines: InvoiceLine[]
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${what} ${value} exceeds the safe integer range`)
  }
  return Number(value)
}

/**
 * Usage: the amount, quantity, and cost the payer budget priced at ingestion (ADR-0008 D4). It is
 * never priced again here. Trial usage is free.
 */
function usageCharge(input: ChargeInput): Omit<PeriodCharge, "collectableAmount"> {
  const { period, statement, currency } = input
  const amount = statement ? safeNumber(BigInt(statement.amount), "usage amount") : 0
  if (amount < 0) throw new Error("Negative billing usage requires an explicit credit operation")
  const trial = period.type === "trial"
  return {
    kind: "usage",
    grossChargeAmount: fromLedgerMinor(trial ? 0 : amount, currency),
    unitAmount: null,
    quantity: statement ? Number(BigInt(statement.quantity)) / Number(AMOUNT_ONE) : 0,
    prorationFactor: trial ? 0 : 1,
    cost: statement?.cost ? safeNumber(BigInt(statement.cost), "usage cost") : null,
  }
}

/**
 * A recurring item (a flat fee, seats, a package bought up front): the plan card's row for the
 * feature, effective at the period start, priced on the item's units and prorated over the part of
 * a full cycle the period and its phase cover. A feature the card does not price is free. Trials
 * are free.
 */
function recurringCharge(input: ChargeInput): Omit<PeriodCharge, "collectableAmount"> {
  const { period, currency, phase } = input
  const featurePlanVersion = period.subscriptionItem.featurePlanVersion
  const quantity = period.subscriptionItem.units ?? 0
  const row = input.rows.find(
    (candidate) =>
      candidate.featureSlug === featurePlanVersion.feature.slug &&
      Object.keys(candidate.match).length === 0 &&
      isEffective(candidate, period.cycleStartAt)
  )
  const free = { kind: "subscription" as const, unitAmount: null, quantity, cost: null }
  if (!row || period.type === "trial") {
    return { ...free, grossChargeAmount: fromLedgerMinor(0, currency), prorationFactor: 0 }
  }
  const billingConfig = billingConfigSchema.parse(featurePlanVersion.billingConfig)
  // A phase that ended before its periods were capped still bills only the time it served. Proration
  // reads a half-open window, and the phase's last period ends on its inclusive last millisecond
  // (capped or not), so that period's service ends 1 ms past the phase.
  const serviceEnd =
    phase.endAt !== null && period.cycleEndAt >= phase.endAt ? phase.endAt + 1 : period.cycleEndAt
  const { prorationFactor } = calculateProration({
    serviceStart: Math.max(period.cycleStartAt, phase.startAt),
    serviceEnd,
    effectiveStartDate: phase.startAt,
    billingConfig: { ...billingConfig, billingAnchor: phase.billingAnchor },
  })
  if (!Number.isFinite(prorationFactor)) {
    throw new Error(`Billing period ${period.id} has no finite proration`)
  }
  const full = safeNumber(priceQuantity(row, BigInt(quantity) * AMOUNT_ONE), "recurring amount")
  const unit = safeNumber(priceQuantity(row, AMOUNT_ONE), "recurring unit amount")
  return {
    ...free,
    grossChargeAmount: fromLedgerMinor(Math.round(full * prorationFactor), currency),
    unitAmount: fromLedgerMinor(unit, currency),
    prorationFactor,
  }
}

/**
 * One invoice line per feature per billing period: a metered feature bills its sealed statement,
 * a recurring one its card price. What wallet captures or settled lines of the same billing period
 * already cover is not collected again.
 */
export function resolvePeriodCharge(input: ChargeInput): PeriodCharge {
  const { period } = input
  const periodLines = input.statementLines.filter(
    (line) => line.metadata?.billing_period_id === period.id
  )
  const metered = period.subscriptionItem.featurePlanVersion.featureType === "usage"
  const charge = metered ? usageCharge(input) : recurringCharge(input)
  const gross = toLedgerMinor(charge.grossChargeAmount)
  const captured = periodLines
    .filter((line) => line.metadata?.flow === "capture")
    .reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
  if (!Number.isSafeInteger(captured) || captured > gross) {
    throw new Error(`Billing period ${period.id} wallet captures exceed its charge`)
  }
  // A capped phase's wallet covers what it admitted; usage recorded past its allocation (a late
  // record, a settle, an expiry) stays on the statement and is billed here (ADR-0008 D10).
  const covered = periodLines
    .filter(
      (line) =>
        line.metadata?.flow === "capture" ||
        line.metadata?.settlement_status === "paid" ||
        line.metadata?.settlement_status === "included"
    )
    .reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
  return { ...charge, collectableAmount: Math.max(0, gross - covered) }
}
