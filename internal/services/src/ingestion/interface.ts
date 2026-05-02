import type {
  AggregationMethod,
  FeatureType,
  MeterConfig,
  OverageStrategy,
} from "@unprice/db/validators"
import { type LakehouseEventForSource, getLakehouseSourceCurrentVersion } from "@unprice/lakehouse"
import type { IngestionQueueMessage } from "./message"

export const EVENTS_SCHEMA_VERSION = getLakehouseSourceCurrentVersion("events")

export type IngestionPipelineEvent = LakehouseEventForSource<"events">

export const INGESTION_REJECTION_REASONS = [
  "CUSTOMER_NOT_FOUND",
  "INVALID_ENTITLEMENT_CONFIGURATION",
  "INVALID_AGGREGATION_PROPERTIES",
  "LIMIT_EXCEEDED",
  "NO_MATCHING_ENTITLEMENT",
  "UNROUTABLE_EVENT",
  "WALLET_EMPTY",
] as const

export type IngestionRejectionReason = (typeof INGESTION_REJECTION_REASONS)[number]

export type IngestionOutcome = {
  rejectionReason?: IngestionRejectionReason
  state: "processed" | "rejected"
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

export const FEATURE_VERIFICATION_STATUSES = [
  "customer_not_found",
  "feature_inactive",
  "feature_missing",
  "invalid_entitlement_configuration",
  "non_usage",
  "usage",
] as const

export type FeatureVerificationStatus = (typeof FEATURE_VERIFICATION_STATUSES)[number]

export type FeatureVerificationResult = {
  allowed: boolean
  featureSlug: string
  featureType?: FeatureType
  isLimitReached?: boolean
  limit?: number | null
  message?: string
  meterConfig?: MeterConfig
  method?: AggregationMethod
  overageStrategy?: OverageStrategy
  periodKey?: string
  status: FeatureVerificationStatus
  effectiveAt?: number
  expiresAt?: number | null
  timestamp: number
  usage?: number
}
