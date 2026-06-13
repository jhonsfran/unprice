import { createRoute, z } from "@hono/zod-openapi"
import {
  type IngestionQueueMessage,
  ingestionQueueMessageSchema,
} from "@unprice/services/ingestion"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, validateIsAllowedToAccessProject } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { safeSendToQueue } from "./ingestEventsV1"

const replayRequestSchema = z.object({
  canonical_audit_ids: z.array(z.string()).min(1).max(50),
  project_id: z.string().optional(),
})

const replayResponseSchema = z.object({
  replayed: z.number().int(),
  skipped: z.number().int(),
})

export const route = createRoute({
  path: "/v1/events/ingest/replay",
  operationId: "events.ingest.replay",
  summary: "replay failed ingestion events",
  method: "post",
  tags: ["events"],
  request: {
    body: jsonContentRequired(replayRequestSchema, "Replay failed ingestion events"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(replayResponseSchema, "Replay result"),
    ...openApiErrorResponses,
  },
})

export const registerReplayIngestionEventsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const key = await keyAuth(c)
    const body = c.req.valid("json")
    const projectId = validateIsAllowedToAccessProject({
      isMain: (key.project.isMain ?? false) || key.project.workspace.isMain,
      key,
      requestedProjectId: body.project_id ?? key.projectId,
    })
    const canonicalAuditIds = Array.from(new Set(body.canonical_audit_ids))
    const response = await c.get("analytics").getIngestionReplayPayloads({
      project_id: projectId,
      canonical_audit_ids: canonicalAuditIds.join(","),
    })
    const rows = response.data ?? []
    const messages = rows.map((row) =>
      parseReplayQueueMessage({
        payloadJson: row.payload_json,
        projectId,
        requestId: c.get("requestId"),
      })
    )

    let replayed = 0
    for (const message of messages) {
      await safeSendToQueue({
        queue: c.env.QUEUE_SHARD_0,
        message,
        logger: c.get("logger"),
      })
      replayed++
    }

    return c.json(
      {
        replayed,
        skipped: canonicalAuditIds.length - replayed,
      },
      HttpStatusCodes.OK
    )
  })

function parseReplayQueueMessage(params: {
  payloadJson: string
  projectId: string
  requestId: string
}): IngestionQueueMessage {
  const { payloadJson, projectId, requestId } = params
  let parsedPayload: unknown

  try {
    parsedPayload = JSON.parse(payloadJson)
  } catch {
    throw new UnpriceApiError({
      code: "BAD_REQUEST",
      message: "Replay payload is not valid JSON",
    })
  }

  const parsedMessage = ingestionQueueMessageSchema.safeParse(parsedPayload)
  if (!parsedMessage.success) {
    throw new UnpriceApiError({
      code: "BAD_REQUEST",
      message: "Replay payload is not a valid ingestion queue message",
    })
  }

  if (parsedMessage.data.projectId !== projectId) {
    throw new UnpriceApiError({
      code: "BAD_REQUEST",
      message: "Replay payload project does not match request project",
    })
  }

  return {
    ...parsedMessage.data,
    requestId,
  }
}
