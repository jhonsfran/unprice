import { createRoute, z } from "@hono/zod-openapi"
import {
  replayIngestionEvents,
  replayIngestionEventsOutputSchema,
} from "@unprice/services/use-cases"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const replayRequestSchema = z.object({
  canonical_audit_ids: z.array(z.string()).min(1).max(50),
  project_id: z.string().optional(),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/ingestion-events/replay",
      operationId: "ingestionEvents.replay",
      summary: "replay failed ingestion events",
      method: "post",
      tags: ["ingestionEvents"],
      request: {
        body: jsonContentRequired(replayRequestSchema, "Replay failed ingestion events"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(replayIngestionEventsOutputSchema, "Replay result"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "operations",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["ingestionEvents", "replay"],
      },
    }
  )
)

export const registerReplayIngestionEventsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const key = await keyAuth(c)
    const body = c.req.valid("json")
    const projectId = validateIsAllowedToAccessProject({
      isMain: (key.project.isMain ?? false) || key.project.workspace.isMain,
      key,
      requestedProjectId: body.project_id ?? key.projectId,
    })
    const result = await replayIngestionEvents(
      {
        analytics: c.get("analytics"),
        rawIngestionQueue: c.get("rawIngestionQueue"),
      },
      {
        canonicalAuditIds: body.canonical_audit_ids,
        projectId,
        requestId: c.get("requestId"),
      }
    )

    if (result.err) {
      throw toUnpriceApiError(result.err)
    }

    return c.json(result.val, HttpStatusCodes.OK)
  })
