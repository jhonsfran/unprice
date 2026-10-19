import type {
  AssertAssignable,
  EmptyObject,
  OperationInputOf,
  OperationResponseOf,
} from "@unprice/budgets"
import type { operations } from "./openapi"

export type OperationId = keyof operations & string

export type OperationInput<TId extends OperationId> = OperationInputOf<operations[TId]>

export type OperationResponse<TId extends OperationId> = OperationResponseOf<operations[TId]>

type _WalletCreditsBalanceInputCheck = AssertAssignable<
  OperationInput<"walletCredits.balance">,
  {
    walletId: string
    customerId: string
    projectId?: string
  }
>

type _RunsConsumeInputCheck = AssertAssignable<
  OperationInput<"runs.consume">,
  {
    runId: string
    featureSlug: string
    idempotencyKey: string
  }
>

type _UsageRecordInputCheck = AssertAssignable<
  OperationInput<"usage.record">,
  {
    idempotencyKey: string
    eventSlug: string
    properties: Record<string, unknown>
  }
>

type _FeaturesListInputCheck = AssertAssignable<OperationInput<"features.list">, EmptyObject>

type _ExplainChargeOptionalDefaultsInputCheck = AssertAssignable<
  {
    invoice_id: string
    entry_id: string
  },
  OperationInput<"analytics.charges.explain">
>

type _IngestionStatusOptionalDefaultsInputCheck = AssertAssignable<
  {
    from_ts: number
    to_ts: number
  },
  OperationInput<"ingestionEvents.status">
>
