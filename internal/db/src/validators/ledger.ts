import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { ledgerEntries, ledgers } from "../schema/ledger"
import { currencySchema, ledgerEntryTypeSchema, ledgerSettlementTypeSchema } from "./shared"

export const ledgerSelectSchema = createSelectSchema(ledgers, {
  currency: currencySchema,
})

export const ledgerEntrySelectSchema = createSelectSchema(ledgerEntries, {
  currency: currencySchema,
  entryType: ledgerEntryTypeSchema,
  settlementType: ledgerSettlementTypeSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
})

export type Ledger = z.infer<typeof ledgerSelectSchema>
export type LedgerEntry = z.infer<typeof ledgerEntrySelectSchema>
