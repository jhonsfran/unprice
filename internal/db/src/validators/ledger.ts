import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { ledgerEntries, ledgerSettlementLines, ledgerSettlements, ledgers } from "../schema/ledger"
import type { LedgerEntryMetadata, LedgerSettlementMetadata } from "../schema/ledger"
import {
  currencySchema,
  ledgerEntryTypeSchema,
  ledgerSettlementStatusSchema,
  ledgerSettlementTypeSchema,
} from "./shared"

export const ledgerSelectSchema = createSelectSchema(ledgers, {
  currency: currencySchema,
})

const ledgerEntryMetadataSchema = z
  .object({
    subscriptionId: z.string().nullish(),
    subscriptionPhaseId: z.string().nullish(),
    subscriptionItemId: z.string().nullish(),
    billingPeriodId: z.string().nullish(),
    featurePlanVersionId: z.string().nullish(),
    invoiceItemKind: z
      .enum(["period", "tax", "discount", "refund", "adjustment", "trial"])
      .nullish(),
    cycleStartAt: z.number().nullish(),
    cycleEndAt: z.number().nullish(),
    quantity: z.number().nullish(),
    unitAmountMinor: z
      .string()
      .regex(/^-?\d+$/, "unitAmountMinor must be a valid integer string")
      .nullish(),
    prorationFactor: z.number().nullish(),
    billingFactId: z.string().nullish(),
    reversalOf: z.string().optional(),
    reason: z.string().optional(),
  })
  .nullable() satisfies z.ZodType<LedgerEntryMetadata | null>

export const ledgerEntrySelectSchema = createSelectSchema(ledgerEntries, {
  currency: currencySchema,
  entryType: ledgerEntryTypeSchema,
  metadata: ledgerEntryMetadataSchema,
})

const ledgerSettlementMetadataSchema = z
  .object({
    note: z.string().optional(),
  })
  .nullable() satisfies z.ZodType<LedgerSettlementMetadata | null>

export const ledgerSettlementSelectSchema = createSelectSchema(ledgerSettlements, {
  type: ledgerSettlementTypeSchema,
  status: ledgerSettlementStatusSchema,
  metadata: ledgerSettlementMetadataSchema,
})

export const ledgerSettlementLineSelectSchema = createSelectSchema(ledgerSettlementLines)

export type Ledger = z.infer<typeof ledgerSelectSchema>
export type LedgerEntry = z.infer<typeof ledgerEntrySelectSchema>
export type LedgerSettlement = z.infer<typeof ledgerSettlementSelectSchema>
export type LedgerSettlementLine = z.infer<typeof ledgerSettlementLineSelectSchema>
