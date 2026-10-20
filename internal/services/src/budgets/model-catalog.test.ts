import { describe, expect, it } from "vitest"
import {
  MODEL_CATALOG,
  MODEL_CATALOG_PROVIDERS,
  MODEL_CATALOG_VERSION,
  fromModelsDev,
  modelRatesFor,
} from "./model-catalog"

/** A models.dev document as its API serves it (read 2026-10-20), cut down to what matters. */
const document = {
  openai: {
    models: {
      "gpt-5": {
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        limit: { context: 400_000, input: 272_000, output: 128_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
      "gpt-image-1": {
        type: "image",
        limit: { context: 0, input: 0, output: 0 },
        modalities: { input: ["text", "image"], output: ["image"] },
      },
      "no-price": {
        limit: { context: 1000, output: 100 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
  google: {
    models: {
      "gemini-2.5-pro": {
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
          tiers: [
            { input: 2.5, output: 15, cache_read: 0.25, tier: { type: "context", size: 200_000 } },
          ],
          context_over_200k: { input: 2.5, output: 15, cache_read: 0.25 },
        },
        limit: { context: 1_048_576, output: 65_536 },
        modalities: { input: ["text", "image", "audio"], output: ["text"] },
      },
    },
  },
  anthropic: {
    models: {
      "claude-sonnet-4-5": {
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      },
    },
  },
  mistral: {
    models: {
      "mistral-small": {
        cost: { input: 0.1, output: 0.3 },
        limit: { context: 128_000, output: 128_000 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
}

describe("model catalog conversion", () => {
  it("converts token-priced text models of the supported providers, sorted by id", () => {
    expect(fromModelsDev(document)).toEqual([
      {
        id: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        unit: "money:USD",
        per: 1_000_000,
        rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        tiers: [],
        limits: { context: 200_000, output: 64_000 },
      },
      {
        id: "google/gemini-2.5-pro",
        provider: "google",
        model: "gemini-2.5-pro",
        unit: "money:USD",
        per: 1_000_000,
        rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
        tiers: [
          { inputTokensAbove: 200_000, input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
        ],
        limits: { context: 1_048_576, output: 65_536 },
      },
      {
        id: "openai/gpt-5",
        provider: "openai",
        model: "gpt-5",
        unit: "money:USD",
        per: 1_000_000,
        rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
        tiers: [],
        limits: { context: 400_000, output: 128_000 },
      },
    ])
  })

  it("rejects a document that is not an object", () => {
    expect(() => fromModelsDev(null)).toThrow("models.dev document")
    expect(() => fromModelsDev([])).toThrow("models.dev document")
  })

  it("skips a provider whose models field is missing", () => {
    expect(fromModelsDev({ openai: {} })).toEqual([])
  })
})

describe("generated model catalog", () => {
  it("is stamped with the sync date", () => {
    expect(MODEL_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("has rows for every supported provider", () => {
    for (const provider of MODEL_CATALOG_PROVIDERS) {
      const rows = MODEL_CATALOG.filter((row) => row.provider === provider)
      expect(rows.length, provider).toBeGreaterThanOrEqual(5)
    }
  })

  it("is sorted by id with no duplicate", () => {
    const ids = MODEL_CATALOG.map((row) => row.id)
    expect(ids).toEqual([...new Set(ids)].sort())
  })

  it("answers known ids once each, in request order, and omits unknown ones", () => {
    const rows = modelRatesFor([
      "openai/gpt-5",
      "nope/x",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ])
    expect(rows.map((row) => row.id)).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4-5"])
    expect(rows[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5",
      unit: "money:USD",
      per: 1_000_000,
    })
    expect(rows[0]?.rates.input).toBeGreaterThan(0)
    expect(rows[0]?.rates.output).toBeGreaterThan(0)
    expect(rows[0]?.limits.context).toBeGreaterThan(0)
    expect(rows[0]?.limits.output).toBeGreaterThan(0)
  })
})
