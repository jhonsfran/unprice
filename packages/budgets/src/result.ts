import type { ApiError } from "./errors"

export type ApiResult<TResult> =
  | {
      result: TResult
      error?: never
    }
  | {
      result?: never
      error: ApiError
    }

export type Result<TResult> = ApiResult<TResult>
