import { type LakehouseEventForSource, getLakehouseSourceCurrentVersion } from "@unprice/lakehouse"
import type { LEDGER_SCALE } from "@unprice/money"
import type { IngestionQueueMessage } from "./message"

export const EVENTS_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("events")

export type IngestionPipelineEvent = LakehouseEventForSource<"events">

export const INGESTION_REJECTION_REASONS = [
  "CUSTOMER_NOT_FOUND",
  "EVENT_TOO_OLD",
  "INVALID_ENTITLEMENT_CONFIGURATION",
  "INVALID_AGGREGATION_PROPERTIES",
  "LIMIT_EXCEEDED",
  "LATE_EVENT_CLOSED_PERIOD",
  "NO_MATCHING_ENTITLEMENT",
  "UNROUTABLE_EVENT",
  "WALLET_EMPTY",
] as const

export type IngestionRejectionReason = (typeof INGESTION_REJECTION_REASONS)[number]

export const INGESTION_FAILURE_STAGES = [
  "raw_ingestion",
  "rating_fact",
  "reporting_delivery",
] as const

export type IngestionFailureStage = (typeof INGESTION_FAILURE_STAGES)[number]

export type IngestionOutcome =
  | {
      state: "processed"
    }
  | {
      rejectionReason: IngestionRejectionReason
      state: "rejected"
    }
  | {
      failureMessage?: string
      failureReason: string
      failureStage: IngestionFailureStage
      replayable: true
      state: "failed"
    }

export type IngestionSyncResult = {
  allowed: boolean
  message?: string
  rejectionReason?: IngestionRejectionReason
  state: "processed" | "rejected"
}

export type IngestionMessageDisposition =
  | {
      action: "ack"
    }
  | {
      action: "retry"
      retryAfterSeconds?: number
    }

export type IngestionMessageProcessingResult = {
  disposition: IngestionMessageDisposition
  message: IngestionQueueMessage
}

export type FeatureVerificationResult = {
  allowed: boolean
  featureSlug: string
  limit?: number | null
  message?: string
  rejectionReason?: IngestionRejectionReason
  spending?: {
    currency: string
    displayAmount: string
    ledgerAmount: number
    scale: typeof LEDGER_SCALE
  }
  usage?: number
}

export type EntitlementWindowState = {
  isLimitReached: boolean
  limit: number | null
  spending: {
    currency: string
    ledgerAmount: number
    scale: typeof LEDGER_SCALE
  }
  usage: number
}
