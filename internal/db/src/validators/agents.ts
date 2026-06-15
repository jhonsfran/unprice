import { createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { agentRuns, agents } from "../schema/agents"

export const agentRunStatusSchema = z.enum([
  "running",
  "completed",
  "expired",
  "canceled",
  "budget_exceeded",
  "failed",
])

export const agentMetadataSchema = z.record(z.unknown()).default({})

export const agentSelectSchema = createSelectSchema(agents)
export const agentRunSelectSchema = createSelectSchema(agentRuns).extend({
  status: agentRunStatusSchema,
})

export const createAgentInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  metadata: agentMetadataSchema,
})

export const startAgentRunInputSchema = z.object({
  agentId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  parentRunId: z.string().min(1).nullable().optional(),
  currency: z.string().length(3),
  budgetAmount: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  traceId: z.string().min(1).nullable().optional(),
  metadata: agentMetadataSchema,
  expiresAt: z.date().nullable().optional(),
})

export const applyAgentRunSyncEventInputSchema = z.object({
  agentId: z.string().min(1),
  runId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  featureSlug: z.string().min(1),
  idempotencyKey: z.string().min(1),
  event: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    timestamp: z.number().finite(),
    properties: z.record(z.unknown()),
  }),
  source: z.object({
    workspaceId: z.string().min(1),
    environment: z.string().min(1),
    apiKeyId: z.string().nullable(),
    sourceType: z.enum(["api_key", "system", "unknown"]),
    sourceId: z.string().min(1),
    sourceName: z.string().nullable(),
  }),
  now: z.number().finite(),
})

export const endAgentRunInputSchema = z.object({
  agentId: z.string().min(1),
  runId: z.string().min(1),
  customerId: z.string().min(1),
  projectId: z.string().min(1),
  endedAt: z.date(),
  status: z.enum(["completed", "expired", "canceled"]).default("completed"),
})

export type Agent = z.infer<typeof agentSelectSchema>
export type AgentRun = z.infer<typeof agentRunSelectSchema>
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>
export type StartAgentRunInput = z.infer<typeof startAgentRunInputSchema>
export type ApplyAgentRunSyncEventInput = z.infer<typeof applyAgentRunSyncEventInputSchema>
export type EndAgentRunInput = z.infer<typeof endAgentRunInputSchema>
