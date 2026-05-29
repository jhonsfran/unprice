import { DO_IDEMPOTENCY_TTL_MS } from "@unprice/services/entitlements"

export const BATCH_TABLE_NAME = "ingestion_audit_batches"
export const AUDIT_RETENTION_MS = DO_IDEMPOTENCY_TTL_MS
export const SQLITE_BOUND_PARAMETER_LIMIT = 100
export const AUDIT_PUBLISH_UPDATE_BATCH_SIZE = SQLITE_BOUND_PARAMETER_LIMIT - 1
export const OUTBOX_BATCH_SIZE = 500
export const RETENTION_CLEANUP_BATCH_SIZE = 5000
export const ALARM_RETRY_DELAY_MS = 30_000
export const STUCK_ROW_THRESHOLD_MS = 10 * 60 * 1000
