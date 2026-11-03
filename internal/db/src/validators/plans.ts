import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"

export const planMetadataSchema = z
  .object({
    externalId: z
      .string()
      .optional()
      .describe(
        "External identifier for integrating with third-party systems (e.g., Stripe product ID, HubSpot deal ID). Useful for syncing plans across platforms"
      ),
  })
  .describe("Additional metadata for the plan used for external integrations and custom data")

export const planSelectBaseSchema = createSelectSchema(schema.plans, {
  title: () => z.string().describe("Title of the plan"),
  metadata: () =>
    planMetadataSchema.describe(
      "Plan metadata containing external integration identifiers and custom data"
    ),
}).describe("Schema for reading/selecting plan data from the database")

export const planInsertBaseSchema = createInsertSchema(schema.plans, {
  title: () =>
    z
      .string()
      .describe(
        "Human-readable plan title (1-50 chars). Will be UPPERCASED. Examples: 'Starter', 'Pro', 'Enterprise'"
      ),
  metadata: () =>
    planMetadataSchema
      .optional()
      .describe("Optional metadata for external integrations and custom data"),
  slug: () =>
    z
      .string()
      .min(3, "Slug must be at least 3 characters")
      .describe(
        "URL-friendly plan identifier (lowercase, hyphens). Examples: 'starter', 'pro', 'enterprise'. This becomes the parent for all plan versions."
      ),
  description: () =>
    z
      .string()
      .optional()
      .describe("Description of the plan explaining its target audience and value proposition"),
  defaultPlan: () =>
    z
      .boolean()
      .optional()
      .describe(
        "Whether this is the default plan shown to new users (only one plan can be default). Use for your 'Starter' or 'Free' tier."
      ),
  enterprisePlan: () =>
    z
      .boolean()
      .optional()
      .describe(
        "Whether this is an enterprise plan with custom pricing. Enterprise plans show 'Contact Us' instead of a price."
      ),
})
  .omit({
    createdAtM: true,
    updatedAtM: true,
  })
  .partial({
    id: true,
    projectId: true,
  })
  .required({
    slug: true,
  })
  .describe(
    "Schema for creating a new pricing plan. Plans are containers for plan versions which define the actual pricing and features"
  )

export type InsertPlan = z.infer<typeof planInsertBaseSchema>
export type Plan = z.infer<typeof planSelectBaseSchema>
