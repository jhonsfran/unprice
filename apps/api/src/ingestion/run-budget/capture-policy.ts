import { z } from "zod"

/**
 * Single source of truth for the RunBudget capture-retry policy.
 *
 * Every place that decides "should this capture be retried / rescheduled /
 * abandoned" MUST consume these constants and helpers so the rule lives in
 * exactly one place. Divergent copies of this logic previously orphaned runs:
 * a capture intent stuck at the attempt cap kept a run open forever because
 * the retry query filtered it out while the close-blocking query did not.
 */

/** Maximum capture attempts before an intent transitions to terminal `abandoned`. */
export const MAX_CAPTURE_ATTEMPTS = 5

/**
 * Retryable (non-terminal) capture-intent statuses. `captured` and `abandoned`
 * are terminal and are therefore excluded from retry, reschedule, and
 * close-blocking logic.
 */
export const CAPTURE_RETRY_STATUSES = ["pending", "failed"] as const
export type CaptureRetryStatus = (typeof CAPTURE_RETRY_STATUSES)[number]

/**
 * Terminal status for a capture that exhausted every attempt and will never be
 * billed automatically. Runs holding an abandoned capture close with a
 * persisted reconciliation flag rather than staying open forever.
 */
export const CAPTURE_ABANDONED_STATUS = "abandoned"
export const CAPTURE_SUCCESS_STATUS = "captured"
export const runCaptureStatusSchema = z.enum([
  ...CAPTURE_RETRY_STATUSES,
  CAPTURE_SUCCESS_STATUS,
  CAPTURE_ABANDONED_STATUS,
])
export type RunCaptureStatus = z.infer<typeof runCaptureStatusSchema>
export type CaptureFailureStatus = Extract<RunCaptureStatus, "abandoned" | "failed">

const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 3_600_000

/**
 * Exponential backoff for capture retries: 30s, 60s, 120s, ... capped at 1h.
 *
 * `attemptCount` is the number of attempts already recorded against the intent
 * (0 before the first attempt). The alarm reschedules using the highest
 * attemptCount among outstanding intents so backoff grows per retry cycle.
 */
export function captureBackoffMs(attemptCount: number): number {
  const normalized =
    Number.isFinite(attemptCount) && attemptCount > 0 ? Math.floor(attemptCount) : 0
  return Math.min(BASE_BACKOFF_MS * 2 ** normalized, MAX_BACKOFF_MS)
}
