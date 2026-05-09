import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { projectExtendedSelectSchema } from "./project"

export const insertApiKeySchema = createInsertSchema(schema.apikeys, {
  name: z.string().min(1),
})
export const selectApiKeySchema = createSelectSchema(schema.apikeys)

export const createApiKeySchema = insertApiKeySchema
  .pick({
    name: true,
    expiresAt: true,
    defaultCustomerId: true,
  })
  .extend({
    projectSlug: z.string().optional(),
    key: z.string().optional(),
  })

export const selectApiKeyHeaderSchema = selectApiKeySchema.pick({
  id: true,
  projectId: true,
})

export const apiKeyExtendedSelectSchema = selectApiKeySchema
  .pick({
    id: true,
    projectId: true,
    expiresAt: true,
    revokedAt: true,
    hash: true,
    defaultCustomerId: true,
  })
  .extend({
    project: projectExtendedSelectSchema,
  })

export type CreateApiKey = z.infer<typeof createApiKeySchema>
export type ApiKey = z.infer<typeof selectApiKeySchema>
export type ApiKeyExtended = z.infer<typeof apiKeyExtendedSelectSchema>
