import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import * as z from "zod"

import * as schema from "../schema"

const eventSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/, {
    message: "Slug must contain only lowercase letters, numbers, dots, dashes, and underscores",
  })

const eventPropertySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/, {
    message:
      "Property names must contain only lowercase letters, numbers, dots, dashes, and underscores",
  })

export const eventSelectBaseSchema = createSelectSchema(schema.events, {
  slug: () =>
    eventSlugSchema.describe(
      "Project-scoped SDK event slug. Example: 'llm_completion' or 'storage_snapshot'"
    ),
  name: () =>
    z.string().min(1).max(64).describe("Human-readable event name. Example: 'AI Completion'"),
  availableProperties: () =>
    z
      .array(eventPropertySchema)
      .nullable()
      .optional()
      .describe(
        "Optional list of numeric payload properties available for aggregation. Example: ['input_tokens', 'output_tokens']"
      ),
})

export const eventInsertBaseSchema = createInsertSchema(schema.events, {
  slug: () =>
    eventSlugSchema.describe(
      "Project-scoped SDK event slug. Example: 'llm_completion' or 'storage_snapshot'"
    ),
  name: () =>
    z.string().min(1).max(64).describe("Human-readable event name. Example: 'AI Completion'"),
  availableProperties: () =>
    z
      .array(eventPropertySchema)
      .nullable()
      .optional()
      .describe(
        "Optional list of numeric payload properties available for aggregation. Example: ['input_tokens', 'output_tokens']"
      ),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
    availableProperties: true,
  })

export const eventUpdateBaseSchema = eventSelectBaseSchema
  .pick({
    id: true,
    name: true,
    availableProperties: true,
  })
  .partial({
    availableProperties: true,
  })
  .strict()

export type Event = z.infer<typeof eventSelectBaseSchema>
export type InsertEvent = z.infer<typeof eventInsertBaseSchema>
export type UpdateEvent = z.infer<typeof eventUpdateBaseSchema>
