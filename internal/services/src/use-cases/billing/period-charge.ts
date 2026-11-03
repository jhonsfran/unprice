import type { Dinero } from "@unprice/db/utils"
import type { Currency, SubscriptionPhase } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import { add, fromLedgerMinor, toLedgerMinor } from "@unprice/money"
import type { BillingPeriodWithItem } from "../../billing/repository"
import type { BillingUsageSnapshot } from "../../billing/usage-snapshot"
import type { InvoiceLine } from "../../ledger"
import type { UnPriceRatingError } from "../../rating/errors"
import type { RatingService } from "../../rating/service"

type PeriodCharge = {
  kind: "usage" | "subscription"
  grossChargeAmount: Dinero<number> | null
  unitAmount: Dinero<number> | null
  quantity: number
  prorationFactor: number
  collectableAmount: number
}

type ChargeInput = {
  period: BillingPeriodWithItem
  currency: Currency
  creditLinePolicy: SubscriptionPhase["creditLinePolicy"]
  customerEntitlementIds: string[]
  snapshots: BillingUsageSnapshot[]
  statementLines: InvoiceLine[]
  ratingService: RatingService
}

function acceptedUsageCharge(input: ChargeInput): Omit<
  PeriodCharge,
  "collectableAmount" | "grossChargeAmount"
> & {
  grossChargeAmount: Dinero<number>
} {
  const { period, customerEntitlementIds, currency } = input
  const snapshots = input.snapshots.filter((snapshot) => snapshot.billingPeriodId === period.id)
  if (
    snapshots.length !== customerEntitlementIds.length ||
    customerEntitlementIds.some(
      (id) => !snapshots.some((snapshot) => snapshot.customerEntitlementId === id)
    )
  )
    throw new Error(`Billing period ${period.id} has no complete sealed usage snapshot`)
  for (const snapshot of snapshots) {
    if (
      snapshot.state === "open" ||
      snapshot.statementKey !== period.statementKey ||
      snapshot.currency !== currency ||
      snapshot.subscriptionItemId !== period.subscriptionItemId ||
      snapshot.cycleStartAt !== period.cycleStartAt ||
      snapshot.cycleEndAt !== period.cycleEndAt
    )
      throw new Error(`Billing period ${period.id} usage snapshot does not match the invoice`)
  }
  const amount = snapshots.reduce((sum, snapshot) => sum + snapshot.amount, 0)
  if (!Number.isSafeInteger(amount))
    throw new Error("Billing usage amount exceeds safe integer range")
  if (amount < 0) throw new Error("Negative billing usage requires an explicit credit operation")
  return {
    kind: "usage",
    grossChargeAmount: fromLedgerMinor(period.type === "trial" ? 0 : amount, currency),
    unitAmount: null,
    quantity: snapshots.reduce((sum, snapshot) => sum + snapshot.quantity, 0),
    prorationFactor: period.type === "trial" ? 0 : 1,
  }
}

export async function resolvePeriodCharge(
  input: ChargeInput
): Promise<Result<PeriodCharge | null, UnPriceRatingError>> {
  const { period, currency } = input
  const itemLines = input.statementLines.filter(
    (line) =>
      line.metadata?.billing_period_id === period.id &&
      line.metadata.feature_plan_version_item_id === period.subscriptionItem.id
  )
  const captures = itemLines.filter((line) => line.metadata?.flow === "capture")
  let charge: Omit<PeriodCharge, "collectableAmount">
  if (period.subscriptionItem.featurePlanVersion.featureType === "usage") {
    const accepted = acceptedUsageCharge(input)
    charge = accepted
    const capturedAmount = captures.reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
    const expectedAmount = toLedgerMinor(accepted.grossChargeAmount)
    if (
      !Number.isSafeInteger(capturedAmount) ||
      capturedAmount > expectedAmount ||
      (input.creditLinePolicy === "capped" && capturedAmount !== expectedAmount)
    )
      throw new Error(
        `Billing period ${period.id} wallet captures do not match its sealed usage amount`
      )
  } else {
    if (captures.length > 0) return Ok(null)
    const rated = await input.ratingService.rateBillingPeriod({
      projectId: period.projectId,
      customerId: period.customerId,
      customerEntitlementIds: input.customerEntitlementIds,
      featureSlug: period.subscriptionItem.featurePlanVersion.feature.slug,
      startAt: period.cycleStartAt,
      endAt: period.cycleEndAt,
      usageData: [
        {
          featureSlug: period.subscriptionItem.featurePlanVersion.feature.slug,
          usage: period.subscriptionItem.units ?? 0,
        },
      ],
    })
    if (rated.err) return Err(rated.err)
    const first = rated.val[0]
    const proration = first?.prorate
    charge = {
      kind: "subscription",
      grossChargeAmount:
        period.type === "trial"
          ? fromLedgerMinor(0, currency)
          : rated.val.reduce<Dinero<number> | null>(
              (sum, item) =>
                sum === null
                  ? item.price.totalPrice.dinero
                  : add(sum, item.price.totalPrice.dinero),
              null
            ),
      unitAmount: first?.price.unitPrice.dinero ?? null,
      quantity:
        rated.val.length > 0
          ? Math.trunc(rated.val.reduce((sum, item) => sum + Math.max(0, item.usage), 0))
          : (period.subscriptionItem.units ?? 0),
      prorationFactor:
        period.type === "trial"
          ? 0
          : typeof proration === "number" && Number.isFinite(proration)
            ? proration
            : 1,
    }
  }
  const coveredAmount = itemLines
    .filter(
      (line) =>
        line.metadata?.flow === "capture" ||
        line.metadata?.settlement_status === "paid" ||
        line.metadata?.settlement_status === "included"
    )
    .reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
  return Ok({
    ...charge,
    collectableAmount: Math.max(
      0,
      (charge.grossChargeAmount ? toLedgerMinor(charge.grossChargeAmount) : 0) - coveredAmount
    ),
  })
}
