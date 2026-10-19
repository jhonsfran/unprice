import type { operations } from "./openapi"

export type EmptyObject = Record<never, never>
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

type OperationParameters<TOperation> = TOperation extends {
  parameters: infer TParameters
}
  ? TParameters
  : EmptyObject

type NonNever<TValue> = [TValue] extends [never] ? EmptyObject : TValue

// `path`/`query` are optional in the generated parameter types (openapi-typescript
// emits `query?` when every query param is optional), so match them optionally and
// strip the `undefined` the optional match introduces — otherwise optional query
// params (e.g. runs.get's `project_id`) silently vanish from the operation input.
type OperationPathParams<TOperation> = OperationParameters<TOperation> extends {
  path?: infer TPath
}
  ? NonNever<NonNullable<TPath>>
  : EmptyObject

type OperationQueryParams<TOperation> = OperationParameters<TOperation> extends {
  query?: infer TQuery
}
  ? NonNever<NonNullable<TQuery>>
  : EmptyObject

type MergeInput<TValue> = {
  [TKey in keyof TValue]: TValue[TKey]
}

/**
 * One operation's input: its path and query parameters and its JSON body, as one object. Generic
 * over the operation so `@unprice/api` derives its inputs from its own OpenAPI types.
 */
export type OperationInputOf<TOperation> = MergeInput<
  OperationPathParams<TOperation> & OperationQueryParams<TOperation> & JsonRequestBody<TOperation>
>

/** One operation's JSON success body. */
export type OperationResponseOf<TOperation> = NonNever<SuccessResponse<TOperation>>

export type AssertAssignable<TValue extends TExpected, TExpected> = TValue

export type OperationId = keyof operations & string

export type OperationInput<TId extends OperationId> = OperationInputOf<operations[TId]>

export type OperationResponse<TId extends OperationId> = OperationResponseOf<operations[TId]>

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
