import type { components } from "./openapi"

type ErrorSchemas = components["schemas"]

/**
 * Every error response component, selected by shape rather than by name.
 *
 * This union used to be written out by hand, and it drifted: the API added
 * `PAYLOAD_TOO_LARGE` to the shared `openApiErrorResponses`, so every route can
 * answer 413, but the ninth component was never added here and a 413 body
 * matched no member of the union. Deriving it means a status added upstream
 * joins the union the next time the SDK is regenerated, with no edit to make
 * and nothing to remember.
 *
 * Matching on the `error` payload rather than on an `Err` name prefix keeps this
 * correct even if the API names a future component differently.
 */
type ErrorSchemaName = {
  [TName in keyof ErrorSchemas]: ErrorSchemas[TName] extends { error: { code: string } }
    ? TName
    : never
}[keyof ErrorSchemas]

type OpenApiErrorResponse = ErrorSchemas[ErrorSchemaName]

export type ErrorResponse = OpenApiErrorResponse

export type ApiError =
  | OpenApiErrorResponse["error"]
  | {
      code: "FETCH_ERROR"
      message: string
      docs: string
      requestId: string
    }
