/**
 * Single source of truth for mode-dependent billing behavior. Every place that
 * used to ask `whenToBill === "pay_in_advance"` should ask the strategy for the
 * specific decision it cares about (when to bill, how long the payment window
 * is, whether settlement comes from an invoice or a wallet drain).
 *
 * Adding a new mode = one new switch arm here + (optionally) one new guard in
 * the XState machine. No scattered `if (whenToBill === ...)` checks.
 */

export type BillingMode = "pay_in_advance" | "pay_in_arrear" | "wallet_only"

/**
 * When the BILL phase fires for a given period:
 *   - `period_start` — at the start of the cycle (advance flat fees)
 *   - `period_end`   — at the end of the cycle (arrears flat + usage)
 *   - `never`        — no invoice; usage drains the wallet directly
 */
export type BillPhaseTrigger = "period_start" | "period_end" | "never"

/**
 * How customer payment lands in the ledger:
 *   - `invoice`      — `topup → receivable` clears the invoice IOU
 *   - `wallet_drain` — usage drains `purchased`; no receivable is opened
 */
export type SettlementMode = "invoice" | "wallet_drain"

export interface AutoTopUpPolicy {
  /** Trigger top-up when `available.purchased` falls below this amount. */
  thresholdAmount: number
  /** How much to charge the saved card per top-up event. */
  topUpAmount: number
}

export interface BillingStrategy {
  mode: BillingMode

  /**
   * PROVISION: must the customer have a non-zero `available.purchased`
   * balance before the subscription can activate? True for wallet-only.
   */
  requiresWalletBalance: boolean

  /** BILL: when does `invoiceSubscription` fire for this period? */
  billPhaseTrigger: BillPhaseTrigger

  /**
   * BILL: how long after the trigger before payment is due. `null` when no
   * invoice is generated (wallet-only).
   */
  invoiceDueOffsetMs: number | null

  /** SETTLE: invoice settlement vs. wallet drain. */
  settlementMode: SettlementMode

  /**
   * RENEW: optional auto top-up policy for wallet-only mode. `null` for
   * invoice-driven modes (the recurring invoice IS the renewal). Per-customer
   * overrides land here at strategy-build time.
   */
  autoTopUp: AutoTopUpPolicy | null
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000
const SIXTY_MINUTES_MS = 60 * 60 * 1_000

export function billingStrategyFor(
  mode: BillingMode,
  overrides?: { autoTopUp?: AutoTopUpPolicy | null }
): BillingStrategy {
  switch (mode) {
    case "pay_in_advance":
      return {
        mode,
        requiresWalletBalance: false,
        billPhaseTrigger: "period_start",
        invoiceDueOffsetMs: FIFTEEN_MINUTES_MS,
        settlementMode: "invoice",
        autoTopUp: overrides?.autoTopUp ?? null,
      }
    case "pay_in_arrear":
      return {
        mode,
        requiresWalletBalance: false,
        billPhaseTrigger: "period_end",
        invoiceDueOffsetMs: SIXTY_MINUTES_MS,
        settlementMode: "invoice",
        autoTopUp: overrides?.autoTopUp ?? null,
      }
    case "wallet_only":
      return {
        mode,
        requiresWalletBalance: true,
        billPhaseTrigger: "never",
        invoiceDueOffsetMs: null,
        settlementMode: "wallet_drain",
        autoTopUp: overrides?.autoTopUp ?? null,
      }
  }
}

/**
 * Short-window variants for plans whose `billingInterval` is `minute`. Test
 * plans use minute intervals to compress real-time cycles; real plans never
 * do. The same mode lookup applies, only the offsets shrink.
 */
const ONE_MINUTE_MS = 1 * 60 * 1_000

export function billingStrategyForInterval(
  mode: BillingMode,
  billingInterval: string,
  overrides?: { autoTopUp?: AutoTopUpPolicy | null }
): BillingStrategy {
  const base = billingStrategyFor(mode, overrides)
  if (billingInterval !== "minute") return base
  if (base.invoiceDueOffsetMs === null) return base
  return { ...base, invoiceDueOffsetMs: ONE_MINUTE_MS }
}
