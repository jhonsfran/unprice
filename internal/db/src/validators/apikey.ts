import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { projectExtendedSelectSchema } from "./project"

export const apiKeyTypeSchema = z.enum(schema.API_KEY_TYPES)

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
    type: apiKeyTypeSchema.default("runtime"),
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
