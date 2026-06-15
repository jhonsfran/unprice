import { createRoute, z } from "@hono/zod-openapi"
import { jsonContent } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const agentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  metadata: z.any().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

const listAgentsResponseSchema = z.object({
  agents: z.array(agentSchema),
})

export const route = createRoute({
  path: "/v1/agents",
  operationId: "agents.list",
  summary: "list agents",
  description: "List all agents for the project",
  method: "get",
  tags,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(listAgentsResponseSchema, "The list of agents"),
    ...openApiErrorResponses,
  },
})

export const registerListAgentsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const { agents } = c.get("services")

    const key = await keyAuth(c)

    const result = await agents.listAgents({ projectId: key.projectId })

    // biome-ignore lint/suspicious/noExplicitAny: openapi handler type depth limit
    return c.json({ agents: result } as any, HttpStatusCodes.OK)
  })
