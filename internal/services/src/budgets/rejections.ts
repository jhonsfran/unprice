import { BaseError, Err, type Result } from "@unprice/error"
import { formatAmount } from "@unprice/money"
import { pricingRejectionMessage } from "../pricing"
import type { ConfigChange } from "./config"
import type { BudgetErrorCode, BudgetRejection } from "./model"
import { measureName } from "./usage"

export class UnPriceBudgetError extends BaseError<{ code: BudgetErrorCode }> {
  public readonly retry = false
  public readonly name = "UnPriceBudgetError"
  public readonly code: BudgetErrorCode

  constructor(public readonly rejection: BudgetRejection) {
    super({ message: rejectionMessage(rejection), context: { code: rejection.code } })
    this.code = rejection.code
  }
}

function rejectionMessage(rejection: BudgetRejection): string {
  switch (rejection.code) {
    case "BUDGET_NOT_FOUND":
      return "Budget does not exist"
    case "WINDOW_CAPACITY_EXCEEDED":
      return `Budget retains ${rejection.retained} anchored schedules; at most ${rejection.maximum} can remain active or in their current period`
    case "INVALID_TTL":
      return `Hold TTL must be between ${rejection.minTtlMs} and ${rejection.maxTtlMs} ms, got ${rejection.ttlMs}`
    case "LIMIT_EXCEEDED":
      return `Limit ${rejection.blocked.limitId} has ${formatAmount(rejection.blocked.remaining)} remaining`
    case "HOLD_NOT_FOUND":
      return `Hold ${rejection.holdId} does not exist`
    case "HOLD_CLOSED":
      return rejection.status === "expired"
        ? `Hold ${rejection.holdId} expired and was settled by the budget`
        : `Hold ${rejection.holdId} is already ${rejection.status}`
    case "HOLD_AMOUNT_EXCEEDED": {
      const { measure } = rejection
      const of = measure.type === "amount" ? "" : ` of ${measureName(measure)}`
      return `Hold ${rejection.holdId} permits ${formatAmount(rejection.maximum)}${of}, not ${formatAmount(rejection.actual)}`
    }
    case "LIMIT_BELOW_USAGE":
      return `Limit ${rejection.limitId} must cover ${formatAmount(rejection.minimum)} consumed or held`
    case "HOLD_RETIRED":
      return `Hold ${rejection.holdId} closed past its retention and can no longer be settled or released`
    case "IDEMPOTENCY_CONFLICT":
      return `Idempotency key ${rejection.idempotencyKey} was used with a different request`
    case "UNIT_IMMUTABLE":
      return `Budget unit is ${rejection.current} and cannot change to ${rejection.requested}`
    case "LIMIT_WINDOW_IMMUTABLE":
      return `Limit ${rejection.limitId} counts over ${rejection.current} and cannot change to ${rejection.requested}; add a limit with a new id instead`
    case "LIMIT_MEASURE_IMMUTABLE":
      return `Limit ${rejection.limitId} caps ${measureName(rejection.current)} and cannot change to ${measureName(rejection.requested)}; add a limit with a new id instead`
    case "BUDGET_CLOSED":
      return `Budget closed at ${new Date(rejection.closedAt).toISOString()}`
    case "LOOSENING_FORBIDDEN":
      return `This caller cannot loosen the budget: the upsert ${describeLoosening(rejection.change)}`
    case "TOO_LATE":
      return `Usage at ${rejection.occurredAt} is older than the oldest accepted ${rejection.oldestAccepted}`
    case "INVALID_OCCURRED_AT":
      return `occurredAt ${rejection.occurredAt} is ahead of the latest accepted ${rejection.latestAccepted}`
    case "LEASE_NOT_FOUND":
      return `Lease ${rejection.leaseKey} does not exist`
    case "LEASE_CLOSED":
      return rejection.status === "expired"
        ? `Lease ${rejection.leaseKey} expired; a final report is accepted only until the alarm counts its remainder`
        : `Lease ${rejection.leaseKey} is already closed`
    case "LEASE_SEQ_CONFLICT":
      return `Lease ${rejection.leaseKey} applied report ${rejection.seq}; expected ${rejection.seq + 1} or an exact retry of ${rejection.seq}, got ${rejection.requested}`
    case "LEASE_CAPTURE_OUT_OF_RANGE":
      return `Lease ${rejection.leaseKey} accepts a cumulative capture from ${formatAmount(rejection.minimum)} to ${formatAmount(rejection.maximum)}, not ${formatAmount(rejection.captured)}`
    case "INVALID_USAGE":
    case "NOT_PRICED":
    case "INCLUDED_NOT_APPLICABLE":
      return pricingRejectionMessage(rejection)
    case "UNKNOWN_EVENT":
      return `No metered feature takes event ${rejection.slug}`
    case "NO_STATEMENT":
      return `No billing statement of ${rejection.featureSlug} covers ${rejection.at}`
    case "PERIOD_CLOSED":
      return `Statement ${rejection.periodId} of ${rejection.featureSlug} is sealed and no later one is open`
    case "STATEMENT_CONFLICT":
      return `Statement ${rejection.periodId} is registered with different fields`
    case "STATEMENT_OVERLAP":
      return `Statement ${rejection.periodId} overlaps ${rejection.overlaps} of the same feature`
    case "STATEMENT_NOT_FOUND":
      return `Statement ${rejection.periodId} is not registered`
    case "STATEMENT_NOT_SEALED":
      return `Statement ${rejection.periodId} is open; seal it before completing it`
    case "CARD_NOT_FOUND":
      return `Rate card ${rejection.cardId} is not cached on this budget`
    case "CARDS_STALE":
      return `Rate cards ${rejection.cardIds.join(", ")} need a refresh before this budget prices`
    case "UNIT_MISMATCH":
      return `Rate card ${rejection.cardId} prices in ${rejection.cardUnit}, not the budget's ${rejection.unit}`
    case "CARD_INCOMPATIBLE":
      return `Rate card ${rejection.cardId} breaks ${rejection.violations.map((v) => v.code).join(", ")} for this budget's features`
    case "EVENT_REQUIRED":
      return "This budget prices usage from events; send an event instead of an amount or a lease"
    case "RESERVATIONS_OPEN":
      return "Pricing can change only while no hold or lease is open; settle or release them first"
    case "FUNDING_REQUIRED":
      return `Statements ${rejection.needs.map((need) => need.statementKey).join(", ")} need wallet funds before this budget admits more usage`
    case "WALLET_EMPTY":
      return `The wallet cannot fund ${formatAmount(rejection.required)} more usage on this budget`
    case "FUNDING_SEQ_CONFLICT":
      return `Statement ${rejection.statementKey} applied wallet intent ${rejection.seq}; ${rejection.requested} is not pending`
    case "FUNDING_FAILED":
      return `The wallet refused ${rejection.intent} ${rejection.seq} of statement ${rejection.statementKey} with ${rejection.walletCode}`
  }
}

function describeLoosening(change: ConfigChange): string {
  switch (change.change) {
    case "limit.removed":
      return `removes hard limit ${change.limitId}`
    case "limit.amount":
      return `raises hard limit ${change.limitId} from ${formatAmount(change.from)} to ${formatAmount(change.to)}`
    case "limit.enforce":
      return `makes hard limit ${change.limitId} ${change.to}`
    case "pricing":
      return "changes how usage is priced"
    default:
      return "clears or postpones closesAt"
  }
}

export function reject(rejection: BudgetRejection): Result<never, UnPriceBudgetError> {
  return Err(new UnPriceBudgetError(rejection))
}
