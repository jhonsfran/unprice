import type { operations } from "./openapi"
import type { ApiResult } from "./result"

type EmptyObject = Record<never, never>
type SuccessStatus = 200 | 201 | 202 | 204

type JsonContent<TResponse> = TResponse extends {
  content: {
    "application/json": infer TContent
  }
}
  ? TContent
  : never

type JsonRequestBody<TOperation> = TOperation extends {
  requestBody: {
    content: {
      "application/json": infer TBody
    }
  }
}
  ? TBody
  : EmptyObject

type SuccessResponse<TOperation> = TOperation extends {
  responses: infer TResponses
}
  ? {
      [TStatus in keyof TResponses]: TStatus extends SuccessStatus
        ? JsonContent<TResponses[TStatus]>
        : never
    }[keyof TResponses]
  : never

type OperationParameters<TId extends OperationId> = operations[TId] extends {
  parameters: infer TParameters
}
  ? TParameters
  : EmptyObject

type NonNever<TValue> = [TValue] extends [never] ? EmptyObject : TValue

type OperationPathParams<TId extends OperationId> = OperationParameters<TId> extends {
  path: infer TPath
}
  ? NonNever<TPath>
  : EmptyObject

type OperationQueryParams<TId extends OperationId> = OperationParameters<TId> extends {
  query: infer TQuery
}
  ? NonNever<TQuery>
  : EmptyObject

type MergeInput<TValue> = {
  [TKey in keyof TValue]: TValue[TKey]
}

export type OperationId = keyof operations & string

export type OperationInput<TId extends OperationId> = MergeInput<
  OperationPathParams<TId> & OperationQueryParams<TId> & JsonRequestBody<operations[TId]>
>

export type OperationResponse<TId extends OperationId> = NonNever<SuccessResponse<operations[TId]>>

export type OperationRequester = <TId extends OperationId>(
  operationId: TId,
  input: OperationInput<TId> | undefined
) => Promise<ApiResult<OperationResponse<TId>>>

type AssertAssignable<TValue extends TExpected, TExpected> = TValue

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

type _ForecastUsageOptionalDefaultsInputCheck = AssertAssignable<
  {
    customer_id: string
    feature_slug: string
  },
  OperationInput<"analytics.usage.forecast">
>

type _IngestionStatusOptionalDefaultsInputCheck = AssertAssignable<
  {
    from_ts: number
    to_ts: number
  },
  OperationInput<"ingestionEvents.status">
>
