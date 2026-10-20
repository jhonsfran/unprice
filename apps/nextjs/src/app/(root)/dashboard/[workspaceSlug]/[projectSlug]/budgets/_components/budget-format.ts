import { formatAmount, parseAmount } from "@unprice/money"

/** Money `2000.5` reads `2,000.50`, units `2000` read `2,000`; every stored decimal is kept. */
export function formatBudgetAmount(amount: string, unit: string): string {
  const [whole = "0", fraction = ""] = amount.split(".")
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const decimals = unit.startsWith("money:") ? fraction.padEnd(2, "0") : fraction
  return decimals ? `${grouped}.${decimals}` : grouped
}

export function formatUnit(unit: string): string {
  return unit.startsWith("money:") ? unit.slice("money:".length) : unit
}

/** A wire decimal in base units; `remaining` can be negative, which `parseAmount` refuses. */
export function toBaseUnits(amount: string): bigint {
  const negative = amount.startsWith("-")
  const parsed = parseAmount(negative ? amount.slice(1) : amount)
  if (!parsed.ok) throw new Error(`not a budget amount: ${amount}`)
  return negative ? -parsed.amount : parsed.amount
}

export function sumAmounts(amounts: readonly string[]): string {
  return formatAmount(amounts.reduce((sum, amount) => sum + toBaseUnits(amount), BigInt(0)))
}

export function subtractAmount(from: string, amount: string): string {
  return formatAmount(toBaseUnits(from) - toBaseUnits(amount))
}

/** `2h 05m`, `3m 10s`, `42s`; zero or less reads `now`. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now"
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}
