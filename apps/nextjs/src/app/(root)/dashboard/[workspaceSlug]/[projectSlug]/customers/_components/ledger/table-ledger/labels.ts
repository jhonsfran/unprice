import type { LedgerParty } from "@unprice/services/use-cases"

/**
 * Wire vocabulary → reader vocabulary. The ledger stores account keys and
 * `metadata.flow` slugs; nobody reading a statement should have to learn
 * either. Anything unmapped falls back to the raw value rather than hiding,
 * so a new wallet flow degrades to readable-ish instead of blank.
 */

const ACTIVITY_LABELS: Record<string, string> = {
  topup: "Top-up",
  reserve: "Budget held",
  release_reservation: "Hold released",
  capture: "Usage charged",
  extend: "Hold extended",
  expire: "Credit expired",
  settle_receivable: "Invoice settled",
  subscription: "Subscription charge",
}

const CUSTOMER_ACCOUNT_LABELS: Record<string, string> = {
  purchased: "Purchased",
  granted: "Granted",
  reserved: "Held",
  consumed: "Used",
  receivable: "Owed",
}

const PLATFORM_FUNDING_LABELS: Record<string, string> = {
  topup: "Top-up",
  promo: "Promo",
  plan_credit: "Plan credit",
  manual: "Manual",
  credit_line: "Credit line",
}

export function activityLabel(flow: string | null, direction: "in" | "out" | "internal"): string {
  if (!flow) {
    return "Movement"
  }

  // the only flow whose meaning flips with direction
  if (flow === "adjust") {
    return direction === "out" ? "Credit removed" : "Credit added"
  }

  return ACTIVITY_LABELS[flow] ?? humanize(flow)
}

export function partyLabel(party: LedgerParty): string {
  if (party.side === "customer") {
    return CUSTOMER_ACCOUNT_LABELS[party.account] ?? humanize(party.account)
  }

  if (party.side === "platform") {
    return PLATFORM_FUNDING_LABELS[party.funding] ?? humanize(party.funding)
  }

  return party.name
}

export function accountLabel(account: string): string {
  return CUSTOMER_ACCOUNT_LABELS[account] ?? humanize(account)
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ")

  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
