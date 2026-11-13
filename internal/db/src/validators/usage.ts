import { z } from "zod"
import {
  RECORD_ACCEPT_WINDOW_MS,
  RECORD_FUTURE_SKEW_MS,
  budgetCrossedSchema,
  budgetDecimalSchema,
  budgetIdempotencyKeySchema,
  budgetReplayedSchema,
  describeDuration,
} from "./budget-shared"
import { budgetBalanceSchema } from "./budgets"
import { eventSlugSchema } from "./events"

// The usage wire contract (ADR-0008 D6): every event goes to its customer's payer budget at
// `unprice:customer:<customerId>`, which meters and prices it at ingestion.

/** The most events one `/v1/usage/record` call carries. */
export const USAGE_RECORD_MAX_EVENTS = 100

const MAX_PROPERTY_KEYS = 128

/** Flat JSON scalars: an operation row keeps them and they cross Workers RPC. */
export const usageEventPropertiesSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()])
  )
  .refine((properties) => Object.keys(properties).length <= MAX_PROPERTY_KEYS, {
    message: `at most ${MAX_PROPERTY_KEYS} properties`,
  })
  .openapi({
    description: `The event's properties: flat strings, numbers, booleans, or null, at most ${MAX_PROPERTY_KEYS} keys and 4 KB serialized. The meter reads the quantity and the dimensions (a model, a region) from them.`,
    example: { model: "gpt-4o", input_tokens: 1200, output_tokens: 300 },
  })

export type UsageEventProperties = z.infer<typeof usageEventPropertiesSchema>

const usageEventFields = {
  customerId: z.string().min(1).max(36).optional().openapi({
    description:
      "The customer whose payer budget takes the event. Defaults to the API key's customer; required otherwise.",
    example: "cus_1H7KQFLr7RepUyQBKdnvY",
  }),
  idempotencyKey: budgetIdempotencyKeySchema.openapi({
    description:
      "Up to 256 characters, usually the event id. A retry with the same key and the same event replays the first answer; the same key with another event is rejected with IDEMPOTENCY_CONFLICT.",
    example: "evt_01J9Z3",
  }),
  eventSlug: eventSlugSchema.openapi({
    description: "The event slug a metered feature of the customer's plan listens to",
    example: "llm_completion",
  }),
  properties: usageEventPropertiesSchema.default({}),
}

export const recordUsageEventSchema = z
  .object({
    ...usageEventFields,
    occurredAt: z
      .number()
      .int()
      .nonnegative()
      .openapi({
        description: `When the usage happened, in epoch milliseconds: the event's own time, not the time of the call, so a retry replays. At most ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} old and ${describeDuration(RECORD_FUTURE_SKEW_MS)} ahead. The usage counts in the billing period that contains it, or in the next open one when that period is already sealed.`,
        example: 1_792_000_000_000,
      }),
  })
  .strict()

export const recordUsageInputSchema = z
  .object({
    events: z
      .array(recordUsageEventSchema)
      .min(1)
      .max(USAGE_RECORD_MAX_EVENTS)
      .openapi({ description: `1 to ${USAGE_RECORD_MAX_EVENTS} events` }),
  })
  .strict()

export const consumeUsageInputSchema = z.object(usageEventFields).strict()

export type RecordUsageEvent = z.infer<typeof recordUsageEventSchema>
export type RecordUsageInput = z.infer<typeof recordUsageInputSchema>
export type ConsumeUsageInput = z.infer<typeof consumeUsageInputSchema>

/** Why one event of a batch was refused, as a single call would have answered it. */
export const usageRejectionSchema = z.object({
  code: z.string().openapi({
    description:
      "The API error code a single call returns: BAD_REQUEST, FORBIDDEN, NOT_FOUND, or CONFLICT; UNAVAILABLE when the budget could not be reached",
    example: "BAD_REQUEST",
  }),
  status: z.number().int().openapi({
    description: "The HTTP status a single call returns",
    example: 400,
  }),
  reason: z.string().openapi({
    description:
      "Why the budget refused the event: NOT_PRICED (no rate row matches it), UNKNOWN_EVENT (no metered feature takes the slug), PERIOD_CLOSED (its billing period is sealed and none is open), NO_STATEMENT (no billing period covers it), TOO_LATE or INVALID_OCCURRED_AT (outside the accepted window), IDEMPOTENCY_CONFLICT, BUDGET_CLOSED, BUDGET_NOT_FOUND (the customer has no subscription budget yet), CUSTOMER_FORBIDDEN (the API key cannot use the customer), or BUDGET_UNAVAILABLE (the budget could not be reached; retry the event with the same idempotency key)",
    example: "NOT_PRICED",
  }),
  message: z.string(),
})

export const usageEventResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    customerId: z.string(),
    idempotencyKey: z.string(),
    amount: budgetDecimalSchema.openapi({
      description: "What the event costs, in the budget's unit, as priced at ingestion",
    }),
    crossed: budgetCrossedSchema,
    replayed: budgetReplayedSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    customerId: z.string(),
    idempotencyKey: z.string(),
    error: usageRejectionSchema,
  }),
])

export const recordUsageResponseSchema = z.object({
  accepted: z.number().int().nonnegative().openapi({ description: "Events accepted or replayed" }),
  rejected: z.number().int().nonnegative().openapi({ description: "Events refused" }),
  results: z.array(usageEventResultSchema).openapi({
    description: "One result per event, in request order",
  }),
})

export const consumeUsageResponseSchema = z.object({
  allowed: z.literal(true),
  customerId: z.string(),
  amount: budgetDecimalSchema.openapi({
    description: "What the event costs, in the budget's unit, as priced at ingestion",
  }),
  crossed: budgetCrossedSchema,
  replayed: budgetReplayedSchema,
  balance: budgetBalanceSchema,
})

export type UsageEventResult = z.infer<typeof usageEventResultSchema>
export type RecordUsageResponse = z.infer<typeof recordUsageResponseSchema>
export type ConsumeUsageResponse = z.infer<typeof consumeUsageResponseSchema>
