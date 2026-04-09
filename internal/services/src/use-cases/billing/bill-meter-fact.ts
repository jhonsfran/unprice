import { formatAmountDinero } from "@unprice/db/utils"
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
}

type BillMeterFactDeps = {
  services: Pick<ServiceContext, "rating" | "ledger">
  logger: Logger
}

type BillMeterFactInput = {
  fact: MeterBillingFact
}

type BillMeterFactOutput = {
  amountCents: number
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
      amountCents: 0,
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

  const amountCents = formatAmountDinero(ratingResult.val.deltaPrice.totalPrice.dinero).amount

  if (amountCents <= 0) {
    return Ok({
      amountCents: 0,
      sourceId: buildLedgerSourceId(fact),
      state: "noop",
    })
  }

  const sourceId = buildLedgerSourceId(fact)
  const ledgerResult = await deps.services.ledger.postDebit({
    projectId: fact.project_id,
    customerId: fact.customer_id,
    currency,
    amountCents,
    sourceType: "meter_fact_v1",
    sourceId,
    featurePlanVersionId: fact.feature_plan_version_id ?? undefined,
    metadata: {
      billingFact: fact,
    },
  })

  if (ledgerResult.err) {
    return Err(ledgerResult.err)
  }

  return Ok({
    amountCents,
    sourceId,
    state: "debited",
  })
}

function buildLedgerSourceId(fact: MeterBillingFact): string {
  return `${fact.project_id}:${fact.customer_id}:${fact.feature_slug}:${fact.idempotency_key}`
}
