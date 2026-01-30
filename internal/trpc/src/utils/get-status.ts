// Helper to map tRPC codes to HTTP status for analytics consistency
export function getHttpStatus(code: string): number {
  switch (code) {
    case "BAD_REQUEST":
      return 400
    case "UNAUTHORIZED":
      return 401
    case "FORBIDDEN":
      return 403
    case "NOT_FOUND":
      return 404
    case "TIMEOUT":
      return 408
    case "CONFLICT":
      return 409
    case "PRECONDITION_FAILED":
      return 412
    case "PAYLOAD_TOO_LARGE":
      return 413
    case "METHOD_NOT_SUPPORTED":
      return 405
    case "TOO_MANY_REQUESTS":
      return 429
    case "CLIENT_CLOSED_REQUEST":
      return 499
    default:
      return 500
  }
}
