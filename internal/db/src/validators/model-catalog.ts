import { z } from "zod"
import { extendZodWithOpenApi } from "zod-openapi"

extendZodWithOpenApi(z)

// The model catalog: the token prices and limits Unprice prices model steps with, served by
// /v1/budgets/models and priced in the SDK. `@unprice/services/budgets` generates its rows from
// models.dev and parses each with modelRateSchema, so a generated row is always wire-valid.

export const MODEL_CATALOG_PROVIDERS = ["openai", "anthropic", "google"] as const

export const MODEL_CATALOG_MAX_IDS = 50

const modelTokenRateSchema = z.number().finite().nonnegative()

export const modelTokenRatesSchema = z
  .object({
    input: modelTokenRateSchema.openapi({
      description: "USD per million input tokens",
      example: 1.25,
    }),
    output: modelTokenRateSchema.openapi({
      description: "USD per million output tokens",
      example: 10,
    }),
    cacheRead: modelTokenRateSchema.openapi({
      description: "USD per million input tokens read from the prompt cache",
      example: 0.125,
    }),
    cacheWrite: modelTokenRateSchema.openapi({
      description: "USD per million input tokens written to the prompt cache",
      example: 1.25,
    }),
  })
  .strict()

export const modelRateSchema = z
  .object({
    id: z.string().openapi({ description: "provider/model", example: "openai/gpt-5" }),
    provider: z.enum(MODEL_CATALOG_PROVIDERS).openapi({ example: "openai" }),
    model: z.string().openapi({ description: "The model's id at its provider", example: "gpt-5" }),
    unit: z.literal("money:USD").openapi({ description: "Rates are in US dollars" }),
    per: z.literal(1_000_000).openapi({ description: "Rates are per this many tokens" }),
    rates: modelTokenRatesSchema.openapi({
      description: "The rates below the first tier, or for every call when there is no tier",
    }),
    tiers: z
      .array(
        modelTokenRatesSchema
          .extend({
            inputTokensAbove: z.number().int().nonnegative().openapi({
              description: "The tier's rates apply to a call whose input exceeds this many tokens",
              example: 200_000,
            }),
          })
          .strict()
      )
      .openapi({
        description:
          "Rates that replace `rates` for a call with more input tokens than `inputTokensAbove`, ascending; empty for a flat price",
      }),
    limits: z
      .object({
        context: z.number().int().positive().openapi({
          description: "The context window, in tokens",
          example: 400_000,
        }),
        output: z.number().int().positive().openapi({
          description: "The most output tokens one call returns",
          example: 128_000,
        }),
      })
      .strict(),
  })
  .strict()

export const modelCatalogQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .openapi({
      description: "Comma-separated provider/model ids, for example openai/gpt-5",
      example: "openai/gpt-5,anthropic/claude-sonnet-4-5",
    })
    .transform((text, ctx) => {
      const ids = [...new Set(text.split(",").map((id) => id.trim()))]
      if (ids.includes("")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an id is empty" })
        return z.NEVER
      }
      if (ids.length > MODEL_CATALOG_MAX_IDS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `at most ${MODEL_CATALOG_MAX_IDS} ids per request`,
        })
        return z.NEVER
      }
      return ids
    }),
})

export const modelCatalogResponseSchema = z.object({
  version: z.string().openapi({
    description: "The UTC date the catalog was synced from models.dev, as YYYY-MM-DD",
    example: "2026-10-20",
  }),
  models: z.array(modelRateSchema).openapi({
    description: "The rows of the known ids, in request order, each once; unknown ids are omitted",
  }),
})

export type ModelRate = z.infer<typeof modelRateSchema>
