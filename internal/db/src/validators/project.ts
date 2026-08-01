import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { currencySchema } from "./shared"
import { workspaceSelectBase } from "./workspace"

export const projectMetadataSchema = z.object({
  analyticsUpdatedAt: z.coerce.number().optional(),
})

export const projectSelectBaseSchema = createSelectSchema(schema.projects, {
  name: z.string().min(4, "Name must be at least 5 characters"),
  metadata: projectMetadataSchema.optional(),
})

export const projectInsertBaseSchema = createInsertSchema(schema.projects, {
  name: z.string().min(1, "Name is required"),
  url: z.string().url().optional(),
  defaultCurrency: currencySchema,
  timezone: z.string().min(1, "Timezone is required"),
  contactEmail: z.string().email().optional(),
  metadata: projectMetadataSchema.optional(),
})
  .partial({
    id: true,
    workspaceId: true,
    contactEmail: true,
  })
  .omit({
    createdAtM: true,
    updatedAtM: true,
    enabled: true,
    slug: true,
    isMain: true,
    isInternal: true,
  })

export const renameProjectSchema = projectSelectBaseSchema.pick({
  slug: true,
  name: true,
})

export const projectExtendedSelectSchema = projectSelectBaseSchema
  .pick({
    id: true,
    enabled: true,
    workspaceId: true,
    slug: true,
    defaultCurrency: true,
    isMain: true,
    isInternal: true,
    timezone: true,
  })
  .extend({
    workspace: workspaceSelectBase.pick({
      slug: true,
      unPriceCustomerId: true,
      enabled: true,
      isPersonal: true,
      isMain: true,
      isInternal: true,
      createdBy: true,
    }),
  })

export const transferToPersonalProjectSchema = z.object({
  slug: z.string(),
})

export const transferToWorkspaceSchema = z.object({
  projectSlug: z.string(),
  targetWorkspaceId: z.string(),
})

export type ProjectInsert = z.infer<typeof projectInsertBaseSchema>
export type Project = z.infer<typeof projectSelectBaseSchema>
export type RenameProject = z.infer<typeof renameProjectSchema>
export type ProjectTransferToWorkspace = z.infer<typeof transferToWorkspaceSchema>
export type ProjectTransferToPersonal = z.infer<typeof transferToPersonalProjectSchema>
export type ProjectExtended = z.infer<typeof projectExtendedSelectSchema>
