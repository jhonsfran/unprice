import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { invoices } from "../schema/invoices"

export const invoiceSettlementSources = [
  "provider",
  "credit_line",
  "cash_wallet",
  "plan_included",
  "trial",
  "promo",
  "manual",
] as const

export const invoiceSettlementStatuses = ["due", "paid", "included"] as const
export const invoiceSettlementSourceSchema = z.enum(invoiceSettlementSources)
export const invoiceSettlementStatusSchema = z.enum(invoiceSettlementStatuses)

export const subscriptionInvoiceSelectSchema = createSelectSchema(invoices)

export type SubscriptionInvoice = typeof invoices.$inferSelect
