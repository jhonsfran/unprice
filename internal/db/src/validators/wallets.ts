import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { WALLET_CREDIT_SOURCES, WALLET_TOPUP_STATUSES } from "../utils"

export const walletCreditSourceSchema = z.enum(WALLET_CREDIT_SOURCES)
export type WalletCreditSource = z.infer<typeof walletCreditSourceSchema>

export const walletTopupStatusSchema = z.enum(WALLET_TOPUP_STATUSES)
export type WalletTopupStatus = z.infer<typeof walletTopupStatusSchema>

export const walletCreditMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)
export type WalletCreditMetadata = z.infer<typeof walletCreditMetadataSchema>

export const entitlementReservationSelectSchema = createSelectSchema(schema.entitlementReservations)
export const entitlementReservationInsertSchema = createInsertSchema(schema.entitlementReservations)
export type EntitlementReservation = typeof schema.entitlementReservations.$inferSelect

export const walletTopupSelectSchema = createSelectSchema(schema.walletTopups)
export const walletTopupInsertSchema = createInsertSchema(schema.walletTopups)
export type WalletTopup = typeof schema.walletTopups.$inferSelect

export const walletCreditSelectSchema = createSelectSchema(schema.walletCredits, {
  metadata: walletCreditMetadataSchema,
})
export const walletCreditInsertSchema = createInsertSchema(schema.walletCredits, {
  metadata: walletCreditMetadataSchema.nullable(),
})
export type WalletCredit = typeof schema.walletCredits.$inferSelect
