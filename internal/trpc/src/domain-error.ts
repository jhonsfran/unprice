import { TRPCError } from "@trpc/server"
import { type DomainErrorKind, resolveDomainErrorKind } from "@unprice/services"

const KIND_TO_TRPC = {
  bad_request: "BAD_REQUEST",
  precondition: "PRECONDITION_FAILED",
  conflict: "CONFLICT",
  not_found: "NOT_FOUND",
  internal: "INTERNAL_SERVER_ERROR",
} as const satisfies Record<DomainErrorKind, TRPCError["code"]>

export function domainErrorToTrpcError(
  error: unknown,
  fallbackMessage = "Internal server error"
): TRPCError {
  const kind = resolveDomainErrorKind(error)
  if (kind) {
    return new TRPCError({
      code: KIND_TO_TRPC[kind],
      message: error instanceof Error ? error.message : fallbackMessage,
    })
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : fallbackMessage,
  })
}
