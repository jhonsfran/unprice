import { invoiceSettlementSources, walletCreditSourceSchema } from "@unprice/db/validators"
import type { WalletCreditSource, invoiceSettlementStatuses } from "@unprice/db/validators"

export type InvoiceSettlementSource = (typeof invoiceSettlementSources)[number]
export type InvoiceSettlementStatus = (typeof invoiceSettlementStatuses)[number]
export type WalletFundingSource = "granted" | "purchased"

export interface SettlementInputLine {
  amount: number
  metadata: Record<string, unknown> | null
}

export type WalletFundingSettlementInput =
  | { source: "purchased"; grantSource: null }
  | { source: "granted"; grantSource: WalletCreditSource | null }

export interface WalletFundingSettlement {
  collectable: boolean
  invoiceVisibleCapture: boolean
  settlementSource: InvoiceSettlementSource
  settlementStatus: InvoiceSettlementStatus
}

export interface ClassifiedInvoiceLineSettlement {
  amountDue: number
  amountIncluded: number
  amountPaid: number
  collectable: boolean
  settlementSource: InvoiceSettlementSource
  settlementStatus: InvoiceSettlementStatus
  walletCreditId: string | null
  walletCreditSource: WalletCreditSource | null
  walletId: string | null
}

const settlementSourceSet = new Set<string>(invoiceSettlementSources)

function readString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readSettlementSource(metadata: Record<string, unknown> | null): InvoiceSettlementSource {
  const value = readString(metadata, "settlement_source")
  return value && settlementSourceSet.has(value) ? (value as InvoiceSettlementSource) : "provider"
}

function readWalletCreditSource(
  metadata: Record<string, unknown> | null
): WalletCreditSource | null {
  const value = readString(metadata, "wallet_credit_source")
  const parsed = walletCreditSourceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function mapWalletFundingToSettlement(
  input: WalletFundingSettlementInput
): WalletFundingSettlement {
  if (input.source === "purchased") {
    return {
      collectable: false,
      invoiceVisibleCapture: true,
      settlementSource: "cash_wallet",
      settlementStatus: "paid",
    }
  }

  if (input.grantSource === "credit_line") {
    return {
      collectable: true,
      invoiceVisibleCapture: false,
      settlementSource: "credit_line",
      settlementStatus: "due",
    }
  }

  return {
    collectable: false,
    invoiceVisibleCapture: true,
    settlementSource: input.grantSource ?? "manual",
    settlementStatus: "included",
  }
}

export function classifyInvoiceLineSettlement(
  input: SettlementInputLine
): ClassifiedInvoiceLineSettlement {
  const settlementSource = readSettlementSource(input.metadata)
  const settlementStatus: InvoiceSettlementStatus =
    settlementSource === "provider" || settlementSource === "credit_line"
      ? "due"
      : settlementSource === "cash_wallet"
        ? "paid"
        : "included"

  return {
    amountDue: settlementStatus === "due" ? input.amount : 0,
    amountIncluded: settlementStatus === "included" ? input.amount : 0,
    amountPaid: settlementStatus === "paid" ? input.amount : 0,
    collectable: settlementStatus === "due",
    settlementSource,
    settlementStatus,
    walletCreditId: readString(input.metadata, "wallet_credit_id"),
    walletCreditSource: readWalletCreditSource(input.metadata),
    walletId: readString(input.metadata, "wallet_id"),
  }
}

export function summarizeInvoiceSettlementAmounts(lines: readonly SettlementInputLine[]) {
  return lines.reduce(
    (totals, line) => {
      const classified = classifyInvoiceLineSettlement(line)
      return {
        amountDue: totals.amountDue + classified.amountDue,
        amountIncluded: totals.amountIncluded + classified.amountIncluded,
        amountPaid: totals.amountPaid + classified.amountPaid,
        grossAmount: totals.grossAmount + line.amount,
      }
    },
    { amountDue: 0, amountIncluded: 0, amountPaid: 0, grossAmount: 0 }
  )
}
