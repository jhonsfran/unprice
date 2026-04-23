import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { WALLET_GRANT_SOURCES, WALLET_TOPUP_STATUSES } from "../utils"

export const walletGrantSourceSchema = z.enum(WALLET_GRANT_SOURCES)
export type WalletGrantSource = z.infer<typeof walletGrantSourceSchema>

export const walletTopupStatusSchema = z.enum(WALLET_TOPUP_STATUSES)
export type WalletTopupStatus = z.infer<typeof walletTopupStatusSchema>

export const walletGrantMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
)
export type WalletGrantMetadata = z.infer<typeof walletGrantMetadataSchema>

export const entitlementReservationSelectSchema = createSelectSchema(schema.entitlementReservations)
export const entitlementReservationInsertSchema = createInsertSchema(schema.entitlementReservations)
export type EntitlementReservation = typeof schema.entitlementReservations.$inferSelect

export const walletTopupSelectSchema = createSelectSchema(schema.walletTopups)
export const walletTopupInsertSchema = createInsertSchema(schema.walletTopups)
export type WalletTopup = typeof schema.walletTopups.$inferSelect

export const walletGrantSelectSchema = createSelectSchema(schema.walletGrants, {
  metadata: walletGrantMetadataSchema,
})
export const walletGrantInsertSchema = createInsertSchema(schema.walletGrants, {
  metadata: walletGrantMetadataSchema.nullable(),
})
export type WalletGrant = typeof schema.walletGrants.$inferSelect
