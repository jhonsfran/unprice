import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import { UnpriceApiError } from "~/errors"

/**
 * Validate an event timestamp against the request-received time and translate
 * the two range violations into a 400. Shared by ingestEventsV1,
 * ingestEventsSyncV1, and verifyV1.
 *
 * `onTooOld` lets ingest routes emit their rejection wide-event before the
 * error is turned into a BAD_REQUEST; verify has nothing extra to log.
 */
export function validateEventTimestampOrThrow(
  timestamp: number,
  receivedAt: number,
  opts?: { onTooOld?: (error: EventTimestampTooOldError) => void }
): void {
  try {
    validateEventTimestamp(timestamp, receivedAt)
  } catch (error) {
    if (error instanceof EventTimestampTooOldError) {
      opts?.onTooOld?.(error)
    }

    if (
      error instanceof EventTimestampTooFarInFutureError ||
      error instanceof EventTimestampTooOldError
    ) {
      throw new UnpriceApiError({ code: "BAD_REQUEST", message: error.message })
    }

    throw error
  }
}
