export const DEFAULT_RUN_RESERVATION_TTL_MS = 60 * 60 * 1000
export const MAX_RUN_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000

type ResolveRunReservationExpirationInput = {
  expiresAt?: number | null
  now: number
}

type RunReservationExpirationResult =
  | { valid: true; expiresAt: number }
  | { valid: false; reason: "MAX_TTL_EXCEEDED" }

export function resolveRunReservationExpiration({
  expiresAt,
  now,
}: ResolveRunReservationExpirationInput): RunReservationExpirationResult {
  const resolvedExpiresAt = expiresAt ?? now + DEFAULT_RUN_RESERVATION_TTL_MS

  if (resolvedExpiresAt > now + MAX_RUN_RESERVATION_TTL_MS) {
    return { valid: false, reason: "MAX_TTL_EXCEEDED" }
  }

  return { valid: true, expiresAt: resolvedExpiresAt }
}
