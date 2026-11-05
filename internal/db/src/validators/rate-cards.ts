import { AMOUNT_PATTERN } from "@unprice/money"
import { z } from "zod"
import { toAmount } from "./budget-shared"
import { currencySchema, featureSlugSchema } from "./shared"

// The rate card contract (ADR-0008 D2 to D5). Decimals arrive as strings and parse into
// `@unprice/money` amounts (bigint base units at LEDGER_SCALE), so `@unprice/services/pricing`
// does exact integer math on trusted values. Structural rules that span rows (overlaps, match
// keys, tiers, cost properties) live in `validateCard`, which reports every violation at once.

/**
 * How far ahead a price change must start once a card has any row (ADR-0008 D2). A budget
 * refreshes its card at least every 5 minutes, so a change published with this notice never meets
 * a budget pricing with a card that predates it.
 */
export const RATE_CHANGE_NOTICE_MS = 10 * 60 * 1000

/** A non-negative decimal string with at most 8 places, parsed into base units. */
export const rateDecimalSchema = z
  .string()
  .regex(AMOUNT_PATTERN, "a non-negative decimal string with at most 8 decimal places")
  .transform(toAmount)

const positiveDecimalSchema = rateDecimalSchema.refine((amount) => amount > BigInt(0), {
  message: "must be greater than zero",
})

const positiveIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/** Epoch milliseconds up to 8.64e15, the last instant a `Date` can represent. */
const epochMsSchema = z.number().int().nonnegative().max(8.64e15)

/**
 * An event property name. "#" starts reserved names. `__proto__` is refused because Zod records
 * and superjson drop it as an own key, so it could never be read back.
 */
const propertyNameSchema = z
  .string()
  .regex(/^[^#]/, "a property name that does not start with #")
  .refine((name) => name !== "__proto__", "__proto__ is not a property name")

/**
 * Exact-match dimension values; {} is the feature's default row. An own `__proto__` key is refused
 * before `z.record` drops it, so it never turns a dimension row into the default row.
 */
const matchSchema = z
  .custom<Record<string, string>>(
    (value) => !(typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")),
    "__proto__ is not a property name"
  )
  .pipe(z.record(propertyNameSchema, z.string()))

/** An event property a component reads, or null for one unit per event. */
const quantityPropertySchema = propertyNameSchema.nullable()

export const rateCardUnitSchema = z
  .string()
  .regex(/^(money:[A-Z]{3}|credits:[a-z0-9_-]{1,64})$/, "money:<ISO> or credits:<id>")

export const rateComponentSchema = z.object({
  property: quantityPropertySchema,
  rate: rateDecimalSchema,
  per: positiveIntSchema,
})

export const rateTierSchema = z.object({
  /** The tier ends after this many whole units; null for the last tier. */
  upTo: positiveIntSchema.nullable(),
  rate: rateDecimalSchema,
  /** Charged once usage enters the tier. */
  flat: rateDecimalSchema,
})

export const ratePriceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("unit"),
    components: z.array(rateComponentSchema).min(1).max(8),
  }),
  z.object({
    type: z.literal("graduated"),
    property: quantityPropertySchema,
    per: positiveIntSchema,
    /** A hold bounds a graduated row in O(tiers log tiers) on every authorize, so cap the tiers. */
    tiers: z.array(rateTierSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal("package"),
    property: quantityPropertySchema,
    size: positiveIntSchema,
    rate: rateDecimalSchema,
  }),
  /** Recurring only: billing prices it at period close, usage never matches it. */
  z.object({
    type: z.literal("flat"),
    amount: rateDecimalSchema,
  }),
])

/** Provider cost in USD, on the same positions as the price. */
export const rateCostSchema = z.object({
  components: z.array(rateComponentSchema).min(1).max(8),
})

const rateRowFieldsSchema = z.object({
  id: z.string().min(1),
  rateCardId: z.string().min(1),
  featureSlug: featureSlugSchema,
  match: matchSchema,
  price: ratePriceSchema,
  cost: rateCostSchema.nullable(),
  effectiveFrom: epochMsSchema,
  effectiveTo: epochMsSchema.nullable(),
  source: z.enum(["manual", "catalog"]),
  sourceRef: z.string().nullable(),
})

export const rateRowSchema = rateRowFieldsSchema.refine(
  (row) => row.effectiveTo === null || row.effectiveTo > row.effectiveFrom,
  {
    message: "effectiveTo must be after effectiveFrom",
    path: ["effectiveTo"],
  }
)

export const marginPolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("costPlus"),
    /** The feature whose rows the catalog prices. */
    featureSlug: featureSlugSchema,
    /** 0.3 is +30% over cost. */
    markup: rateDecimalSchema,
    /** Prices round up to a multiple of this. */
    roundTo: positiveDecimalSchema,
    /** The dimension that carries the model id. */
    dimension: propertyNameSchema,
    /** Cost component name (input, output, cache_read, ...) to the event property it prices. */
    componentMap: z
      .record(z.string().min(1), propertyNameSchema)
      .refine((map) => Object.keys(map).length > 0, { message: "map at least one component" }),
  }),
])

const rateCardFieldsSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  unit: rateCardUnitSchema,
  /** What one credit is worth in USD; credits cards only. */
  creditValueUsd: positiveDecimalSchema.optional(),
  marginPolicy: marginPolicySchema,
})

function refineCard(
  card: Pick<z.infer<typeof rateCardFieldsSchema>, "unit" | "creditValueUsd" | "marginPolicy">,
  ctx: z.RefinementCtx
) {
  const credits = card.unit.startsWith("credits:")
  if (!credits && card.creditValueUsd !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "only a credits card has a credit value",
      path: ["creditValueUsd"],
    })
  }
  if (card.marginPolicy.type !== "costPlus") return
  if (credits && card.creditValueUsd === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "a cost-plus credits card needs creditValueUsd",
      path: ["creditValueUsd"],
    })
  }
  if (!credits && card.unit !== "money:USD") {
    ctx.addIssue({
      code: "custom",
      message: "costs are in USD, so a cost-plus money card must be money:USD",
      path: ["marginPolicy"],
    })
  }
}

export const rateCardSchema = rateCardFieldsSchema.superRefine(refineCard)

/** One provider's cost for one model, in USD per million of each component. */
export const modelCostSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  components: z.record(z.string().min(1), rateDecimalSchema),
  effectiveFrom: epochMsSchema,
  source: z.enum(["modelsdev", "manual"]),
  sourceRef: z.string().nullable(),
})

/** What the pricing core needs to know about a metered feature. */
export const featurePricingSchema = z.object({
  slug: featureSlugSchema,
  /** Event properties a row may match on. */
  dimensions: z.array(propertyNameSchema),
  /** The property limits count; null counts one per event. */
  meterProperty: quantityPropertySchema,
  /** Meter units free per statement period. */
  included: rateDecimalSchema.nullable(),
})

/** A new card; its id and project come from the caller's context. */
export const createRateCardInputSchema = rateCardFieldsSchema
  .omit({ id: true, projectId: true })
  .superRefine(refineCard)

/** A row to publish: the card, interval, and provenance come from the publish itself. */
export const rateRowDraftSchema = rateRowFieldsSchema.pick({
  featureSlug: true,
  match: true,
  price: true,
  cost: true,
})

export const publishRateRowsInputSchema = z.object({
  cardId: z.string().min(1),
  rows: z.array(rateRowDraftSchema).min(1).max(500),
  effectiveFrom: epochMsSchema,
  /**
   * Open rows to end at `effectiveFrom` in the same publish, such as a regrouped feature's old
   * rows, so its new rows follow them without a gap.
   */
  closeRowIds: z.array(z.string().min(1)).max(500).optional(),
})

/** Ends open rows, for instance rows a feature change left stale; an end is a price change too. */
export const closeRateRowsInputSchema = z.object({
  cardId: z.string().min(1),
  rowIds: z.array(z.string().min(1)).min(1).max(500),
  effectiveTo: epochMsSchema,
})

export const previewCostPlusInputSchema = z.object({
  cardId: z.string().min(1),
  /** When the revision is computed; now when absent. */
  at: epochMsSchema.optional(),
})

export const publishCostPlusInputSchema = z.object({
  cardId: z.string().min(1),
  effectiveFrom: epochMsSchema,
  /** The `draftHash` of the preview the caller reviewed. */
  draftHash: z.string().min(1),
})

/** Prices a draft plan version in one currency with a card (ADR-0008 D2: one card per currency). */
export const assignPlanVersionCardInputSchema = z.object({
  planVersionId: z.string().min(1),
  currency: currencySchema,
  cardId: z.string().min(1),
})

/** The card a plan version prices with in one currency. */
export const planVersionCardSchema = z.object({
  planVersionId: z.string(),
  currency: currencySchema,
  cardId: z.string(),
  unit: rateCardUnitSchema,
})

export type RateComponent = z.infer<typeof rateComponentSchema>
export type RateTier = z.infer<typeof rateTierSchema>
export type RatePrice = z.infer<typeof ratePriceSchema>
export type RateCost = z.infer<typeof rateCostSchema>
export type RateRow = z.infer<typeof rateRowSchema>
export type RateRowInput = z.input<typeof rateRowSchema>
export type MarginPolicy = z.infer<typeof marginPolicySchema>
export type RateCard = z.infer<typeof rateCardSchema>
export type RateCardInput = z.input<typeof rateCardSchema>
export type ModelCost = z.infer<typeof modelCostSchema>
export type ModelCostInput = z.input<typeof modelCostSchema>
export type FeaturePricing = z.infer<typeof featurePricingSchema>
export type FeaturePricingInput = z.input<typeof featurePricingSchema>
export type CreateRateCardInput = z.infer<typeof createRateCardInputSchema>
export type RateRowDraft = z.infer<typeof rateRowDraftSchema>
export type CloseRateRowsInput = z.infer<typeof closeRateRowsInputSchema>
export type AssignPlanVersionCardInput = z.infer<typeof assignPlanVersionCardInputSchema>
export type PlanVersionCard = z.infer<typeof planVersionCardSchema>
