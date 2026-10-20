import type { ApiError } from "./errors"
import type { ApiResult } from "./result"

/** USD per million tokens. */
export type ModelTokenRates = Readonly<{
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}>

/** A model's token prices and limits, as `GET /v1/budgets/models` serves them. */
export type ModelRate = Readonly<{
  /** `provider/model`, for example `openai/gpt-5`. */
  id: string
  provider: "openai" | "anthropic" | "google"
  model: string
  unit: "money:USD"
  per: 1_000_000
  rates: ModelTokenRates
  /** Whole-request rates that apply once the context exceeds `inputTokensAbove`. */
  tiers: ReadonlyArray<ModelTokenRates & Readonly<{ inputTokensAbove: number }>>
  limits: Readonly<{ context: number; output: number }>
}>

/** How long a fetched row answers from memory before the catalog is asked again. */
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000

/** The catalog route's answer, parsed at the boundary; the row types above are what it must hold. */
export type ModelCatalogTransport = (ids: readonly string[]) => Promise<ApiResult<unknown>>

export type ModelCatalog = {
  /** The row for `provider/model`, or `NOT_FOUND` when the catalog does not know it. */
  get(id: string): Promise<ApiResult<ModelRate>>
}

type Entry =
  | { kind: "cached"; expiresAt: number; result: ApiResult<ModelRate> }
  | { kind: "pending"; result: Promise<ApiResult<ModelRate>> }

export function parseModelId(id: string): { provider: string; model: string } {
  const slash = id.indexOf("/")
  if (slash <= 0 || slash === id.length - 1 || id.indexOf("/", slash + 1) !== -1) {
    throw new Error(`A model id is "provider/model", for example "openai/gpt-5"; received "${id}"`)
  }
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}

const notFound = (id: string): ApiError => ({
  code: "NOT_FOUND",
  message: `Model ${id} is not in the Unprice catalog`,
  docs: "https://docs.unprice.dev/budgets/ai-sdk",
  requestId: "N/A",
})

const malformed = (id: string): ApiError => ({
  code: "FETCH_ERROR",
  message: `The catalog answered an unexpected row for ${id}`,
  docs: "https://docs.unprice.dev/api-reference/errors",
  requestId: "N/A",
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isRates = (value: unknown): value is ModelTokenRates =>
  isRecord(value) &&
  ["input", "output", "cacheRead", "cacheWrite"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key])
  )

function isModelRate(value: unknown): value is ModelRate {
  if (!isRecord(value)) return false
  const { limits } = value
  return (
    typeof value.id === "string" &&
    (value.provider === "openai" ||
      value.provider === "anthropic" ||
      value.provider === "google") &&
    typeof value.model === "string" &&
    value.unit === "money:USD" &&
    value.per === 1_000_000 &&
    isRates(value.rates) &&
    Array.isArray(value.tiers) &&
    value.tiers.every(
      (tier) =>
        isRates(tier) &&
        Number.isSafeInteger((tier as { inputTokensAbove?: unknown }).inputTokensAbove)
    ) &&
    isRecord(limits) &&
    Number.isSafeInteger(limits.context) &&
    Number.isSafeInteger(limits.output)
  )
}

/** The rows in a catalog answer, or null when the answer is not the route's shape. */
function rowsOf(answer: unknown): ModelRate[] | null {
  if (!isRecord(answer) || !Array.isArray(answer.models)) return null
  const rows: ModelRate[] = []
  for (const row of answer.models) {
    if (!isModelRate(row)) return null
    rows.push(row)
  }
  return rows
}

/**
 * Rows fetched once per id per TTL and shared by every caller in the process. A miss is remembered
 * for the TTL too; a transport failure is not, so the next call asks again.
 */
export function createModelCatalog({
  transport,
  ttlMs = MODEL_CACHE_TTL_MS,
  now = Date.now,
}: {
  transport: ModelCatalogTransport
  ttlMs?: number
  now?: () => number
}): ModelCatalog {
  const entries = new Map<string, Entry>()

  const fetchRow = async (id: string): Promise<ApiResult<ModelRate>> => {
    const answer = await transport([id])
    if (answer.error) return { error: answer.error }
    const rows = rowsOf(answer.result)
    if (rows === null) return { error: malformed(id) }
    const row = rows.find((model) => model.id === id)
    return row ? { result: row } : { error: notFound(id) }
  }

  return {
    async get(id) {
      parseModelId(id)
      const entry = entries.get(id)
      if (entry?.kind === "pending") return entry.result
      if (entry?.kind === "cached" && entry.expiresAt > now()) return entry.result
      const pending = fetchRow(id).then(
        (result) => {
          if (result.error && result.error.code !== "NOT_FOUND") entries.delete(id)
          else entries.set(id, { kind: "cached", expiresAt: now() + ttlMs, result })
          return result
        },
        (error: unknown) => {
          entries.delete(id)
          throw error
        }
      )
      entries.set(id, { kind: "pending", result: pending })
      return pending
    },
  }
}
