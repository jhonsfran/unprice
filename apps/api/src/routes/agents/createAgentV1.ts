import { createRoute, z } from "@hono/zod-openapi"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["agents"]

const createAgentBodySchema = z.object({
  name: z.string().min(1).openapi({
    description: "The agent name",
    example: "my-agent",
  }),
  description: z.string().nullable().optional().openapi({
    description: "Optional description for the agent",
  }),
  metadata: z.record(z.string(), z.any()).optional().openapi({
    description: "Arbitrary metadata to attach to the agent",
  }),
})

const agentResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  metadata: z.any().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
})

export const route = createRoute({
  path: "/v1/agents",
  operationId: "agents.create",
  summary: "create agent",
  description: "Create a new agent for the project",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(createAgentBodySchema, "The agent to create"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(agentResponseSchema, "The created agent"),
    ...openApiErrorResponses,
  },
})

export const registerCreateAgentV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const { agents } = c.get("services")

    const key = await keyAuth(c)

    const agent = await agents.createAgent({
      projectId: key.projectId,
      name: body.name,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
    })

    // biome-ignore lint/suspicious/noExplicitAny: openapi handler type depth limit
    return c.json(agent as any, HttpStatusCodes.OK)
  })
