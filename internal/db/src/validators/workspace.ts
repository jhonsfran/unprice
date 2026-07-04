import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import * as schema from "../schema"
import { userSelectBase } from "./auth"
import { subscriptionItemsConfigSchema } from "./subscriptions/items"

export const invitesSelectBase = createSelectSchema(schema.invites)
export const inviteInsertBase = createInsertSchema(schema.invites, {
  email: z.string().min(3, "Email must be at least 3 characters").email(),
  name: z.string().min(3, "Name must be at least 3 characters"),
})

export const membersSelectBase = createSelectSchema(schema.members)

export const workspaceSelectBase = createSelectSchema(schema.workspaces)
export const workspaceInsertBase = createInsertSchema(schema.workspaces, {
  name: z.string().min(3, "Name must be at least 3 characters"),
}).partial({
  id: true,
  createdAtM: true,
  updatedAtM: true,
  createdBy: true,
  slug: true,
})

export const workspaceSignupSchema = workspaceInsertBase
  .partial()
  .required({
    name: true,
  })
  .extend({
    planVersionId: z.string().min(1, "Plan version is required").optional(),
    config: subscriptionItemsConfigSchema.optional(),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
    sessionId: z.string().optional(),
  })

export const listMembersSchema = membersSelectBase.extend({
  workspace: workspaceSelectBase,
  user: userSelectBase,
})

export const inviteMembersSchema = inviteInsertBase.pick({
  email: true,
  role: true,
  name: true,
})

export const workspacesJWTPayload = workspaceSelectBase
  .pick({
    id: true,
    slug: true,
    isPersonal: true,
    enabled: true,
    unPriceCustomerId: true,
    isInternal: true,
    isMain: true,
  })
  .extend({
    role: membersSelectBase.shape.role,
  })

export type WorkspacesJWTPayload = z.infer<typeof workspacesJWTPayload>
export type WorkspaceRole = z.infer<typeof membersSelectBase.shape.role>
export type Workspace = z.infer<typeof workspaceSelectBase>
export type WorkspaceInsert = z.infer<typeof workspaceInsertBase>
export type Member = z.infer<typeof membersSelectBase>
export type InviteMember = z.infer<typeof inviteMembersSchema>
export type WorkspaceSignup = z.infer<typeof workspaceSignupSchema>
