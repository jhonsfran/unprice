import { MODEL_CATALOG_PROVIDERS, type ModelRate, modelRateSchema } from "@unprice/db/validators"
import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from "./model-catalog.data"

export { MODEL_CATALOG, MODEL_CATALOG_PROVIDERS, MODEL_CATALOG_VERSION }
export type { ModelRate }

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/** models.dev prices a cache read or write like plain input when it lists no rate for it. */
function toRates(cost: JsonObject) {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read ?? cost.input,
    cacheWrite: cost.cache_write ?? cost.input,
  }
}

function toTiers(tiers: unknown) {
  if (!Array.isArray(tiers)) return []
  return tiers.flatMap((entry: unknown) => {
    if (!isObject(entry) || !isObject(entry.tier) || entry.tier.type !== "context") return []
    return [{ inputTokensAbove: entry.tier.size, ...toRates(entry) }]
  })
}

/**
 * The catalog rows in a models.dev document (https://models.dev/api.json): the token-priced
 * language models of the supported providers, sorted by id. A model without a price or without
 * positive context and output limits is left out.
 */
export function fromModelsDev(document: unknown): ModelRate[] {
  if (!isObject(document)) throw new Error("Invalid models.dev document")
  const rows: ModelRate[] = []
  for (const provider of MODEL_CATALOG_PROVIDERS) {
    const entry = document[provider]
    const models = isObject(entry) ? entry.models : undefined
    if (!isObject(models)) continue
    for (const [modelId, model] of Object.entries(models)) {
      if (!isObject(model) || !isObject(model.cost) || !isObject(model.limit)) continue
      if (model.type !== undefined && model.type !== "language") continue
      if (!isFiniteNumber(model.cost.input) || !isFiniteNumber(model.cost.output)) continue
      if (!isPositiveInt(model.limit.context) || !isPositiveInt(model.limit.output)) continue
      rows.push(
        modelRateSchema.parse({
          id: `${provider}/${modelId}`,
          provider,
          model: modelId,
          unit: "money:USD",
          per: 1_000_000,
          rates: toRates(model.cost),
          tiers: toTiers(model.cost.tiers),
          limits: { context: model.limit.context, output: model.limit.output },
        })
      )
    }
  }
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const rowsById = new Map(MODEL_CATALOG.map((row) => [row.id, row] as const))

/** The rows of the known ids, in request order and each once; unknown ids are omitted. */
export function modelRatesFor(ids: readonly string[]): ModelRate[] {
  return [...new Set(ids)].flatMap((id) => rowsById.get(id) ?? [])
}
