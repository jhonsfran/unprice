import { createRoute } from "@hono/zod-openapi"
import type { AppLogger } from "@unprice/observability"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { ulid } from "ulid"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import type { Env } from "~/env"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { type IngestionQueueMessage, ingestionQueueMessageSchema } from "~/ingestion/message"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["ingestion"]
const SAFE_QUEUE_SEND_RETRIES = 3
const SAFE_QUEUE_SEND_BASE_DELAY_MS = 100

export const rawEventSchema = z.object({
  id: z
    .string()
    .openapi({
      description:
        "Optional event id. If omitted, the API will generate an internal event id for processing.",
      example: "evt_123",
    })
    .optional(),
  idempotencyKey: z.string().openapi({
    description: "Logical idempotency key for deduplicating raw events",
    example: "idem_123",
  }),
  eventSlug: z.string().openapi({
    description: "The event slug",
    example: "tokens_used",
  }),
  customerId: z.string().openapi({
    description: "The unprice customer id",
    example: "cus_123",
  }),
  timestamp: z
    .number()
    .openapi({
      description:
        "Event timestamp in epoch milliseconds, if not provided will use the time of the request",
      example: 1_741_454_800_000,
    })
    .optional(),
  properties: z.record(z.string(), z.unknown()).openapi({
    description: "Arbitrary event properties",
    example: {
      amount: 1,
    },
  }),
})

const acceptedSchema = z.object({
  accepted: z.literal(true).openapi({
    description: "The raw event was accepted for asynchronous processing",
    example: true,
  }),
})

export const route = createRoute({
  path: "/v1/events/ingest",
  operationId: "events.ingest",
  summary: "ingest raw event",
  description:
    "Ingest a raw events. All ingested events are reported and a notification will be triggered when the limit is hit.",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(rawEventSchema, "The raw event ingestion payload"),
  },
  responses: {
    [HttpStatusCodes.ACCEPTED]: jsonContent(
      acceptedSchema,
      "The raw event was accepted for asynchronous processing"
    ),
    ...openApiErrorResponses,
  },
})

export const registerIngestEventsV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const requestId = c.get("requestId")
    // we use this as the time of the request to avoid clock skews
    const receivedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? receivedAt
    const logger = c.get("logger")

    // we shard the load in 2 queues for now, more than enough as we scale we add more
    const availableQueues = [c.env.QUEUE_SHARD_0, c.env.QUEUE_SHARD_1]

    // 1. auth for the request
    const key = await keyAuth(c)
    // 2. resolve the proper project Id if this is called from main project
    const projectId = await resolveContextProjectId(c, key.projectId, body.customerId)

    try {
      // 3. events that are too old doesn't get pass, also events that are too far from the future.
      validateEventTimestamp(timestamp, receivedAt)
    } catch (error) {
      if (
        error instanceof EventTimestampTooFarInFutureError ||
        error instanceof EventTimestampTooOldError
      ) {
        throw new UnpriceApiError({
          code: "BAD_REQUEST",
          message: error.message,
        })
      }

      throw error
    }

    const isDevelopment = c.env.APP_ENV === "development" && c.env.NODE_ENV === "development"
    // this improve dev ex
    const idempotencyKey = isDevelopment ? body.idempotencyKey + Date.now() : body.idempotencyKey

    // 4. the event should be parsed to be sure we don't receive garbage, before sending it
    // to the queue
    // TODO: we could deduplicate this here in memory
    const message = buildIngestionQueueMessage({
      body: {
        ...body,
        idempotencyKey,
      },
      projectId,
      receivedAt,
      requestId,
      timestamp,
    })

    // shard by customerid to make sure the messages of specific customer go to the same queue
    // this way we can group them together in background
    const selectedQueue =
      availableQueues[selectQueueShardIndex(body.customerId, availableQueues.length)]!

    // This sends the message in background to avoid blocking the requests
    // There is a retry mechanism and last option we send to analytics events
    c.executionCtx.waitUntil(
      safeSendToQueue({
        env: c.env,
        queue: selectedQueue,
        message,
        logger,
      })
    )

    // after proccessed return 202
    return c.json({ accepted: true as const }, HttpStatusCodes.ACCEPTED)
  })

/**
 * simple hash algo to shared queues
 * @param customerId
 * @param shardCount
 * @returns
 */
export function selectQueueShardIndex(customerId: string, shardCount = 2): number {
  let hash = 0

  for (let index = 0; index < customerId.length; index++) {
    hash = (hash * 31 + customerId.charCodeAt(index)) >>> 0
  }

  return hash % shardCount
}

export async function safeSendToQueue(params: {
  env: Env
  logger: AppLogger
  queue: Queue<IngestionQueueMessage>
  message: IngestionQueueMessage
}): Promise<void> {
  const { env, logger, queue, message } = params

  try {
    for (let attempt = 0; attempt < SAFE_QUEUE_SEND_RETRIES; attempt++) {
      try {
        await queue.send(message)
        return
      } catch (error) {
        logger.warn("raw ingestion queue send failed", {
          attempt: attempt + 1,
          maxAttempts: SAFE_QUEUE_SEND_RETRIES,
          projectId: message.projectId,
          customerId: message.customerId,
          eventId: message.id,
          idempotencyKey: message.idempotencyKey,
          error,
        })

        if (attempt < SAFE_QUEUE_SEND_RETRIES - 1) {
          await sleep(SAFE_QUEUE_SEND_BASE_DELAY_MS * 2 ** attempt)
        }
      }
    }

    // write the message to analytics as fallback
    env.FALLBACK_ANALYTICS.writeDataPoint({
      indexes: [message.projectId, message.customerId, message.slug],
      doubles: [message.timestamp, message.receivedAt],
      blobs: [message.id, message.requestId, JSON.stringify(message)],
    })
  } catch (error) {
    logger.error("raw ingestion background send failed permanently", {
      projectId: message.projectId,
      customerId: message.customerId,
      eventId: message.id,
      idempotencyKey: message.idempotencyKey,
      error,
    })
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function generateEventId(now = Date.now()): string {
  return `evt_${ulid(now)}`
}

export function buildIngestionQueueMessage(params: {
  body: IngestEventsRequest
  projectId: string
  receivedAt: number
  requestId: string
  timestamp: number
}): IngestionQueueMessage {
  const { body, projectId, receivedAt, requestId, timestamp } = params
  const eventId = body.id ?? generateEventId(receivedAt)

  return ingestionQueueMessageSchema.parse({
    version: 1,
    projectId,
    customerId: body.customerId,
    requestId,
    receivedAt,
    idempotencyKey: body.idempotencyKey,
    id: eventId,
    slug: body.eventSlug,
    timestamp,
    properties: body.properties,
  })
}

export type IngestEventsRequest = z.infer<typeof rawEventSchema>
export type IngestEventsResponse = z.infer<typeof acceptedSchema>
