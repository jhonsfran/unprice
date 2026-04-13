import { formatAmountForLedger } from "@unprice/db/utils"
import { type Currency, currencySchema } from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import type { ServiceContext } from "../../context"
import type { UnPriceLedgerError } from "../../ledger/errors"
import { UnPriceRatingError } from "../../rating/errors"

export type MeterBillingFact = {
  id: string
  event_id: string
  idempotency_key: string
  project_id: string
  customer_id: string
  stream_id: string
  feature_slug: string
  period_key: string
  event_slug: string
  aggregation_method: string
  timestamp: number
  created_at: number
  delta: number
  value_after: number
  currency: string
  feature_plan_version_id?: string | null
  // Attribution context — populated by the billing DO at outbox write time
  subscription_id?: string | null
  subscription_item_id?: string | null
  statement_key?: string | null
}

type BillMeterFactDeps = {
  services: Pick<ServiceContext, "rating" | "ledger">
  logger: Logger
}

type BillMeterFactInput = {
  fact: MeterBillingFact
}

type BillMeterFactOutput = {
  amountMinor: bigint
  sourceId: string
  state: "debited" | "noop"
}

export async function billMeterFact(
  deps: BillMeterFactDeps,
  params: BillMeterFactInput
): Promise<Result<BillMeterFactOutput, UnPriceRatingError | UnPriceLedgerError>> {
  const { fact } = params

  if (fact.delta <= 0) {
    return Ok({
      amountMinor: BigInt(0),
      sourceId: buildLedgerSourceId(fact),
      state: "noop",
    })
  }

  const parsedCurrency = currencySchema.safeParse(fact.currency)

  if (!parsedCurrency.success) {
    return Err(
      new UnPriceRatingError({
        message: `Invalid currency "${fact.currency}" in billing fact for ${fact.project_id}:${fact.customer_id}:${fact.feature_slug}`,
      })
    )
  }

  const currency: Currency = parsedCurrency.data

  const usageBefore = Math.max(0, fact.value_after - fact.delta)
  const usageAfter = Math.max(0, fact.value_after)

  const ratingResult = await deps.services.rating.rateIncrementalUsage({
    projectId: fact.project_id,
    customerId: fact.customer_id,
    featureSlug: fact.feature_slug,
    usageBefore,
    usageAfter,
    now: fact.timestamp,
    currency,
  })

  if (ratingResult.err) {
    return Err(ratingResult.err)
  }

  // Convert rated Dinero amount to ledger scale-6 minor units.
  const { amount } = formatAmountForLedger(ratingResult.val.deltaPrice.totalPrice.dinero)
  const amountMinor = BigInt(amount)

  if (amountMinor <= BigInt(0)) {
    return Ok({
      amountMinor: BigInt(0),
      sourceId: buildLedgerSourceId(fact),
      state: "noop",
    })
  }

  const sourceId = buildLedgerSourceId(fact)
  const ledgerResult = await deps.services.ledger.postDebit({
    projectId: fact.project_id,
    customerId: fact.customer_id,
    currency,
    amountMinor,
    sourceType: "meter_fact_v1",
    sourceId,
    statementKey: fact.statement_key ?? undefined,
    metadata: {
      featurePlanVersionId: fact.feature_plan_version_id ?? undefined,
      subscriptionId: fact.subscription_id ?? undefined,
      subscriptionItemId: fact.subscription_item_id ?? undefined,
      billingFactId: fact.id,
    },
  })

  if (ledgerResult.err) {
    return Err(ledgerResult.err)
  }

  return Ok({
    amountMinor,
    sourceId,
    state: "debited",
  })
}

function buildLedgerSourceId(fact: MeterBillingFact): string {
  return `${fact.project_id}:${fact.customer_id}:${fact.feature_slug}:${fact.idempotency_key}`
}
