import { sha256HexSync } from "@unprice/db/utils"
import { formatAmount } from "@unprice/money"

/**
 * Stable JSON for parsed rate card values: object keys sorted, amounts as canonical decimal
 * strings. Equal values give equal strings whatever order Postgres `jsonb` returned the keys in.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return formatAmount(item)
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]])
    )
  })
}

/**
 * The wire form of a parsed value: what the `@unprice/db/validators` schema parses back into the
 * same value. Parsing only turns decimal strings into amounts, so formatting them back is the
 * whole inverse.
 */
export function toWire<TWire>(value: unknown): TWire {
  return JSON.parse(canonicalJson(value)) as TWire
}

export function stableHash(value: unknown): string {
  return sha256HexSync(canonicalJson(value))
}
