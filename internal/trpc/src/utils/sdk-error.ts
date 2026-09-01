import type { TRPCError } from "@trpc/server"

/** Map public API failure codes to tRPC without classifying client errors as server faults. */
export function sdkErrorToTRPCCode(code: string | undefined): TRPCError["code"] {
  switch (code) {
    case "BAD_REQUEST":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "CONFLICT":
    case "PRECONDITION_FAILED":
    case "PAYLOAD_TOO_LARGE":
    case "TOO_MANY_REQUESTS":
      return code
    case "METHOD_NOT_ALLOWED":
      return "METHOD_NOT_SUPPORTED"
    case "DISABLED":
    case "INSUFFICIENT_PERMISSIONS":
    case "USAGE_EXCEEDED":
    case "EXPIRED":
      return "FORBIDDEN"
    case "DELETE_PROTECTED":
      return "PRECONDITION_FAILED"
    case "RATE_LIMITED":
      return "TOO_MANY_REQUESTS"
    default:
      return "INTERNAL_SERVER_ERROR"
  }
}
