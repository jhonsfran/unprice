import baseX from "base-x"

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const b58 = baseX(ALPHABET)

// this simulates uuid v7 and generated ids sortable by timestamp and url safe base58 encoded
export const prefixes = {
  workspace: "ws",
  request: "req",
  project: "proj",
  user: "usr",
  feature: "ft",
  event: "evt",
  feature_version: "fv",
  plan: "plan",
  apikey: "api",
  apikey_key: "unprice_live",
  page: "page",
  customer: "cus",
  customer_credit: "cc",
  customer_session: "cs",
  customer_provider: "cp",
  customer_entitlement: "ce",
  subscription: "sub",
  subscription_item: "si",
  subscription_phase: "sp",
  domain: "dom",
  plan_version: "pv",
  usage: "usage",
  log: "log",
  invoice: "inv",
  billing_period: "bp",
  payment_provider_config: "ppc",
  isolate: "iso",
  session: "sess",
  subscription_lock: "slock",
  invoice_item: "ii",
  invoice_credit_application: "ica",
  entitlement: "ent",
  grant: "grnt",
  ledger: "ldg",
  ledger_entry: "le",
  ledger_settlement: "lset",
  ledger_settlement_line: "lsl",
} as const

// Thread-local counter for monotonicity within the same millisecond
let lastTimestamp = BigInt(0)
let counter = 0

// Constants
const EPOCH_TIMESTAMP = BigInt(1_700_000_000_000)
const MAX_COUNTER = 0xfff // 12 bits for counter

// BigInt constants
const BIGINT_255 = BigInt(255)
const BIGINT_40 = BigInt(40)
const BIGINT_32 = BigInt(32)
const BIGINT_24 = BigInt(24)
const BIGINT_16 = BigInt(16)
const BIGINT_8 = BigInt(8)

/**
 * Generates a unique, time-sortable ID with prefix
 * Structure (16 bytes total):
 * - 6 bytes: timestamp (48 bits)
 * - 2 bytes: counter/variation (16 bits)
 * - 8 bytes: random data (64 bits)
 */
export function newId<TPrefix extends keyof typeof prefixes>(
  prefix: TPrefix
): `${(typeof prefixes)[TPrefix]}_${string}` {
  // Initialize buffer with zeros
  const buf = new Uint8Array(16) // 128 bits like a UUID v7

  // First, fill the entire buffer with random values
  crypto.getRandomValues(buf)

  // Get current timestamp in milliseconds
  let timestamp = BigInt(Date.now()) - EPOCH_TIMESTAMP

  // Ensure monotonicity: if timestamp is same or earlier, increment counter
  // If counter overflows, increment timestamp
  if (timestamp <= lastTimestamp) {
    timestamp = lastTimestamp
    counter++
    if (counter > MAX_COUNTER) {
      timestamp++
      counter = 0
    }
  } else {
    counter = 0
  }
  lastTimestamp = timestamp

  // Write 48-bit timestamp
  buf[0] = Number((timestamp >> BIGINT_40) & BIGINT_255)
  buf[1] = Number((timestamp >> BIGINT_32) & BIGINT_255)
  buf[2] = Number((timestamp >> BIGINT_24) & BIGINT_255)
  buf[3] = Number((timestamp >> BIGINT_16) & BIGINT_255)
  buf[4] = Number((timestamp >> BIGINT_8) & BIGINT_255)
  buf[5] = Number(timestamp & BIGINT_255)

  // Write 16-bit counter/variation with version
  buf[6] = (0x7 << 4) | ((counter >> 8) & 0x0f) // Version 7 in high nibble
  buf[7] = counter & 0xff

  // Set variant bits (RFC 4122 variant)
  buf[8] = (buf[8]! & 0x3f) | 0x80

  // Encode with Base58 and pad to 22 characters for lexicographical sortability
  const encoded = b58.encode(buf).padStart(22, ALPHABET[0])

  return `${prefixes[prefix]}_${encoded}` as const
}

export function randomId(): string {
  return b58.encode(new Uint8Array(16)).padStart(22, ALPHABET[0])
}

/**
 * Extracts the timestamp from an ID
 * @param id The ID to extract timestamp from
 * @returns timestamp in milliseconds since EPOCH_TIMESTAMP
 */
export function getTimestampFromId(id: string): number {
  const parts = id.split("_")
  const encodedPart = parts[parts.length - 1]
  if (!encodedPart) {
    throw new Error("Invalid ID format: missing encoded part")
  }
  const buf = b58.decode(encodedPart)

  // The buffer might be longer than 16 bytes due to padding, or shorter if not padded.
  // We take the last 16 bytes to ensure we're looking at the right offsets.
  const offset = Math.max(0, buf.length - 16)

  if (buf.length < offset + 6) {
    throw new Error("Invalid ID format: buffer too short")
  }

  const timestamp =
    (BigInt(buf[offset + 0]!) << BIGINT_40) |
    (BigInt(buf[offset + 1]!) << BIGINT_32) |
    (BigInt(buf[offset + 2]!) << BIGINT_24) |
    (BigInt(buf[offset + 3]!) << BIGINT_16) |
    (BigInt(buf[offset + 4]!) << BIGINT_8) |
    BigInt(buf[offset + 5]!)

  return Number(timestamp + EPOCH_TIMESTAMP)
}

/**
 * Utility function to compare two IDs chronologically
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareIds(a: string, b: string): number {
  const timestampA = getTimestampFromId(a)
  const timestampB = getTimestampFromId(b)

  if (timestampA !== timestampB) {
    return timestampA - timestampB
  }

  // If timestamps are equal, compare encoded parts to maintain consistent ordering
  const encodedA = a.split("_").pop() ?? ""
  const encodedB = b.split("_").pop() ?? ""
  return encodedA.localeCompare(encodedB)
}
