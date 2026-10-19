import type { operations } from "./openapi"

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

// `path`/`query` are optional in the generated parameter types (openapi-typescript
// emits `query?` when every query param is optional), so match them optionally and
// strip the `undefined` the optional match introduces — otherwise optional query
// params (e.g. runs.get's `project_id`) silently vanish from the operation input.
type OperationPathParams<TId extends OperationId> = OperationParameters<TId> extends {
  path?: infer TPath
}
  ? NonNever<NonNullable<TPath>>
  : EmptyObject

type OperationQueryParams<TId extends OperationId> = OperationParameters<TId> extends {
  query?: infer TQuery
}
  ? NonNever<NonNullable<TQuery>>
  : EmptyObject

type MergeInput<TValue> = {
  [TKey in keyof TValue]: TValue[TKey]
}

export type OperationId = keyof operations & string

export type OperationInput<TId extends OperationId> = MergeInput<
  OperationPathParams<TId> & OperationQueryParams<TId> & JsonRequestBody<operations[TId]>
>

export type OperationResponse<TId extends OperationId> = NonNever<SuccessResponse<operations[TId]>>

type AssertAssignable<TValue extends TExpected, TExpected> = TValue

type _BudgetsAuthorizeInputCheck = AssertAssignable<
  OperationInput<"budgets.authorize">,
  {
    key: string
    amount: string
    ttlMs?: number
    idempotencyKey: string
  }
>

type _BudgetsGetInputCheck = AssertAssignable<OperationInput<"budgets.get">, { key: string }>
