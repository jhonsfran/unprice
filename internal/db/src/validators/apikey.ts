import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { projectExtendedSelectSchema } from "./project"

export const apiKeyTypeSchema = z.enum(schema.API_KEY_TYPES)
// re-exported so every layer above the db reaches the default through one import path
export const DEFAULT_API_KEY_TYPE = schema.DEFAULT_API_KEY_TYPE

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
    type: apiKeyTypeSchema.default(DEFAULT_API_KEY_TYPE),
    projectSlug: z.string().optional(),
    workspaceSlug: z.string().optional(),
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
    type: true,
  })
  .extend({
    project: projectExtendedSelectSchema,
  })

export type CreateApiKey = z.infer<typeof createApiKeySchema>
export type ApiKey = z.infer<typeof selectApiKeySchema>
export type ApiKeyExtended = z.infer<typeof apiKeyExtendedSelectSchema>
export type ApiKeyType = z.infer<typeof apiKeyTypeSchema>
