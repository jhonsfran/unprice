import { getHttpStatus } from "./utils/get-status"

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error, please contact support."

export function isInternalTrpcError(code: string): boolean {
  return getHttpStatus(code) >= 500
}

export function getPublicTrpcErrorMessage({
  code,
  message,
}: {
  code: string
  message: string
}): string {
  return isInternalTrpcError(code) ? INTERNAL_SERVER_ERROR_MESSAGE : message
}
