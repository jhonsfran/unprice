import type { components } from "./openapi"

type OpenApiErrorResponse =
  | components["schemas"]["ErrBadRequest"]
  | components["schemas"]["ErrUnauthorized"]
  | components["schemas"]["ErrForbidden"]
  | components["schemas"]["ErrNotFound"]
  | components["schemas"]["ErrConflict"]
  | components["schemas"]["ErrPreconditionFailed"]
  | components["schemas"]["ErrTooManyRequests"]
  | components["schemas"]["ErrInternalServerError"]

export type ErrorResponse = OpenApiErrorResponse

export type ApiError =
  | OpenApiErrorResponse["error"]
  | {
      code: "FETCH_ERROR"
      message: string
      docs: string
      requestId: string
    }
