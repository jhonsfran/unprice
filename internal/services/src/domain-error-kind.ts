import { BaseError, type ErrorContext, SchemaError } from "@unprice/error"

export type DomainErrorKind =
  | "bad_request"
  | "forbidden"
  | "precondition"
  | "conflict"
  | "not_found"
  | "internal"

export abstract class DomainError<
  TContext extends ErrorContext = ErrorContext,
> extends BaseError<TContext> {
  public abstract readonly kind: DomainErrorKind
}

// Returns the kind for a known domain error, or null when the error is unknown
// (caller maps null -> internal). SchemaError -> bad_request is handled here too.
export function resolveDomainErrorKind(error: unknown): DomainErrorKind | null {
  if (error instanceof SchemaError) return "bad_request"
  if (error instanceof DomainError) return error.kind
  return null
}
