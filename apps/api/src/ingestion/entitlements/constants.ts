export const APPLY_BATCH_SIZE_LIMIT = 100
export const FLUSH_BATCH_SIZE = 1000
export const FLUSH_INTERVAL_MS = 30_000
export const OUTBOX_DEPTH_ALERT_THRESHOLD = 1000
export const IDEMPOTENCY_CLEANUP_BATCH_SIZE = 1000
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
export const WALLET_RESERVATION_ROW_ID = "singleton"

// Inactivity closes out a live reservation even if the period has not ended.
export const DEVELOPMENT_INACTIVITY_THRESHOLD_MS = 60 * 1000
export const DEFAULT_INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000
