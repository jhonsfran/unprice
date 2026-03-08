import {
  dedupeKeys,
  deliverySequences,
  metadataRecords,
  reportUsageAggregates,
  stateObjects,
  usageAggregates,
  usageRecords,
  verificationAggregates,
  verifications,
} from "./schema"

export type UsageRecord = typeof usageRecords.$inferSelect
export type NewUsageRecord = typeof usageRecords.$inferInsert
export type Verification = typeof verifications.$inferSelect
export type NewVerification = typeof verifications.$inferInsert
export type UsageAggregate = typeof usageAggregates.$inferSelect
export type VerificationAggregate = typeof verificationAggregates.$inferSelect
export type ReportUsageAggregate = typeof reportUsageAggregates.$inferSelect
export type MetadataRecord = typeof metadataRecords.$inferSelect
export type StateObject = typeof stateObjects.$inferSelect
export type DedupeKey = typeof dedupeKeys.$inferSelect
export type DeliverySequence = typeof deliverySequences.$inferSelect

export const schema = {
  usageRecords,
  verifications,
  metadataRecords,
  deliverySequences,
  usageAggregates,
  verificationAggregates,
  reportUsageAggregates,
  stateObjects,
  dedupeKeys,
}

export type Schema = typeof schema
