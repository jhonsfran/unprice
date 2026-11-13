import { z } from "@hono/zod-openapi"
import {
  budgetClosedDetailsSchema,
  budgetExceededDetailsSchema,
  budgetHoldAmountExceededDetailsSchema,
  budgetLimitBelowUsageDetailsSchema,
  budgetReleaseRejectedDetailsSchema,
  budgetWindowCapacityExceededDetailsSchema,
} from "@unprice/db/validators"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode, StatusCode } from "hono/utils/http-status"

export const ErrorCode = z.enum([
  "BAD_REQUEST",
  "FORBIDDEN",
  "INTERNAL_SERVER_ERROR",
  "USAGE_EXCEEDED",
  "DISABLED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "PRECONDITION_FAILED",
  "PAYLOAD_TOO_LARGE",
  "INSUFFICIENT_PERMISSIONS",
  "METHOD_NOT_ALLOWED",
  "EXPIRED",
  "DELETE_PROTECTED",
  "BUDGET_EXCEEDED",
])

/**
 * Structured, machine-readable detail on an error response. Some failures are
 * about a tree — a configuration document, say — and "which part of it is wrong"
 * cannot survive being flattened into a sentence; an agent needs a failure kind
 * and JSON paths to act on.
 *
 * This is shared across every error response because `openApiErrorResponses` is,
 * so it is named for the layer that carries it rather than for its first
 * consumer. It is optional everywhere; the `monetization.*` operations, the
 * budget 402, and the closed-budget 409 populate it, and every other route omits it. A new kind belongs in
 * this same union, discriminated by `kind`, rather than in a parallel field.
 */
const configErrorDetailsSchema = z.object({
  kind: z.enum(["invalid_config", "slug_conflict", "unresolved_reference"]).openapi({
    description: "What kind of failure this is",
    example: "invalid_config",
  }),
  issues: z
    .array(
      z.object({
        path: z.string().openapi({
          description: "JSON path into the submitted document",
          example: "config.plans[0].version.features[1].featureSlug",
        }),
        message: z.string(),
      })
    )
    .optional()
    .openapi({ description: "Per-location detail, when the failure has locations" }),
})

export const apiErrorDetailsSchema = z.discriminatedUnion("kind", [
  configErrorDetailsSchema,
  budgetExceededDetailsSchema,
  budgetClosedDetailsSchema,
  budgetHoldAmountExceededDetailsSchema,
  budgetLimitBelowUsageDetailsSchema,
  budgetWindowCapacityExceededDetailsSchema,
  budgetReleaseRejectedDetailsSchema,
])

export type ApiErrorDetails = z.infer<typeof apiErrorDetailsSchema>

function codeToStatus(code: z.infer<typeof ErrorCode>): StatusCode {
  switch (code) {
    case "BAD_REQUEST":
      return 400
    case "UNAUTHORIZED":
      return 401
    case "BUDGET_EXCEEDED":
      return 402
    case "FORBIDDEN":
    case "DISABLED":
    case "INSUFFICIENT_PERMISSIONS":
    case "USAGE_EXCEEDED":
    case "EXPIRED":
      return 403
    case "NOT_FOUND":
      return 404
    case "METHOD_NOT_ALLOWED":
      return 405
    case "CONFLICT":
      return 409
    case "DELETE_PROTECTED":
    case "PRECONDITION_FAILED":
      return 412
    case "PAYLOAD_TOO_LARGE":
      return 413
    case "RATE_LIMITED":
      return 429
    case "INTERNAL_SERVER_ERROR":
      return 500
  }
}

export class UnpriceApiError extends HTTPException {
  public readonly code: z.infer<typeof ErrorCode>
  /** Optional machine-readable detail. Absent unless the thrower can be precise. */
  public readonly details?: ApiErrorDetails

  constructor({
    code,
    message,
    details,
    cause,
  }: {
    code: z.infer<typeof ErrorCode>
    message: string
    details?: ApiErrorDetails
    /** The domain error this answer maps, for an adapter that needs more than the code. */
    cause?: unknown
  }) {
    super(codeToStatus(code) as ContentfulStatusCode, { message, cause })
    this.code = code
    this.details = details
  }
}
