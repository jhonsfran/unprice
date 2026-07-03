import { createRoute } from "@hono/zod-openapi"
import type { Logger } from "@unprice/logs"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import {
  type IngestionQueueMessage,
  ingestionQueueMessageSchema,
  markRawProcessingFailureTestRequestId,
} from "@unprice/services/ingestion"
import type { MiddlewareHandler } from "hono"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { ulid } from "ulid"
import { z } from "zod"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKey } from "~/auth/key"
import type { Env } from "~/env"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import type { HonoEnv } from "~/hono/env"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["usage"]
const SAFE_QUEUE_SEND_RETRIES = 3
const SAFE_QUEUE_SEND_BASE_DELAY_MS = 100
export const RAW_EVENT_MAX_BODY_BYTES = 128 * 1024
export const RAW_EVENT_MAX_PROPERTIES_BYTES = 64 * 1024
export const RAW_EVENT_MAX_PROPERTY_KEYS = 128
export const RAW_EVENT_MAX_PROPERTY_DEPTH = 5
export const INGESTION_TEST_FAILURE_HEADER = "x-unprice-ingestion-test-failure"
export const INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE = "raw_queue_processing_failed"
export const USAGE_RECORD_PATH = "/v1/usage/record"

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
  customerId: z
    .string()
    .openapi({
      description: "The unprice customer id",
      example: "cus_123",
    })
    .optional(),
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

export const enforceRawEventBodyLimit: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const contentLength = c.req.header("content-length")

  if (contentLength) {
    const size = Number.parseInt(contentLength, 10)

    if (Number.isFinite(size) && size > RAW_EVENT_MAX_BODY_BYTES) {
      throw new UnpriceApiError({
        code: "PAYLOAD_TOO_LARGE",
        message: `Request body must be ${RAW_EVENT_MAX_BODY_BYTES} bytes or less`,
      })
    }
  }

  await assertRawRequestBodyWithinLimit(c.req.raw)
  await next()
}

async function assertRawRequestBodyWithinLimit(request: Request): Promise<void> {
  const body = request.clone().body

  if (!body) {
    return
  }

  const reader = body.getReader()
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        return
      }

      size += value.byteLength
      if (size > RAW_EVENT_MAX_BODY_BYTES) {
        throw new UnpriceApiError({
          code: "PAYLOAD_TOO_LARGE",
          message: `Request body must be ${RAW_EVENT_MAX_BODY_BYTES} bytes or less`,
        })
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function assertRawEventPayloadWithinLimits(body: IngestEventsRequest): void {
  const propertiesBytes = getJsonByteLength(body.properties)
  const stats = collectRawEventPropertyStats(body.properties)

  if (propertiesBytes > RAW_EVENT_MAX_PROPERTIES_BYTES) {
    throw new UnpriceApiError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Event properties must be ${RAW_EVENT_MAX_PROPERTIES_BYTES} bytes or less`,
    })
  }

  if (stats.keyCount > RAW_EVENT_MAX_PROPERTY_KEYS) {
    throw new UnpriceApiError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Event properties must contain ${RAW_EVENT_MAX_PROPERTY_KEYS} keys or fewer`,
    })
  }

  if (stats.maxDepth > RAW_EVENT_MAX_PROPERTY_DEPTH) {
    throw new UnpriceApiError({
      code: "PAYLOAD_TOO_LARGE",
      message: `Event properties must be nested ${RAW_EVENT_MAX_PROPERTY_DEPTH} levels or fewer`,
    })
  }
}

function getJsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function collectRawEventPropertyStats(value: unknown): { keyCount: number; maxDepth: number } {
  const seen = new WeakSet<object>()

  return collectValueStats(value, 0, seen)
}

function collectValueStats(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): { keyCount: number; maxDepth: number } {
  if (value === null || typeof value !== "object") {
    return { keyCount: 0, maxDepth: depth }
  }

  if (seen.has(value)) {
    return { keyCount: 0, maxDepth: depth }
  }

  seen.add(value)

  const childValues = Array.isArray(value) ? value : Object.values(value)
  const ownKeyCount = Array.isArray(value) ? 0 : Object.keys(value).length
  let keyCount = ownKeyCount
  let maxDepth = depth

  for (const childValue of childValues) {
    const childStats = collectValueStats(childValue, depth + 1, seen)
    keyCount += childStats.keyCount
    maxDepth = Math.max(maxDepth, childStats.maxDepth)
  }

  return { keyCount, maxDepth }
}

const acceptedSchema = z.object({
  accepted: z.literal(true).openapi({
    description: "The raw event was accepted for asynchronous processing",
    example: true,
  }),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: USAGE_RECORD_PATH,
      operationId: "usage.record",
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
    },
    {
      audience: "public",
      category: "runtime",
      docs: {
        expose: true,
      },
      sdk: {
        path: ["usage", "record"],
      },
      idempotency: {
        required: true,
        location: "body",
        field: "idempotencyKey",
      },
    }
  )
)

export const registerIngestEventsV1 = (app: App) => {
  app.use(USAGE_RECORD_PATH, enforceRawEventBodyLimit)

  return app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    assertRawEventPayloadWithinLimits(body)

    const requestId = c.get("requestId")
    // we use this as the time of the request to avoid clock skews
    const receivedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? receivedAt
    const logger = c.get("logger")

    // we shard the load in 2 queues for now, more than enough as we scale we add more
    // const availableQueues = [c.env.QUEUE_SHARD_0, c.env.QUEUE_SHARD_1]
    const availableQueues = [c.env.QUEUE_SHARD_0] // only one queue for now

    // 1. auth for the request
    const key = await keyAuth(c)
    const customer = resolveCustomerIdForApiKey({
      explicitCustomerId: body.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    if (!customer.success) {
      throw new UnpriceApiError({
        code: customer.code === "customer_forbidden" ? "FORBIDDEN" : "BAD_REQUEST",
        message: customer.message,
      })
    }

    const customerId = customer.customerId

    // 2. resolve the proper project Id if this is called from main project
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    try {
      // 3. events that are too old doesn't get pass, also events that are too far from the future.
      validateEventTimestamp(timestamp, receivedAt)
    } catch (error) {
      if (error instanceof EventTimestampTooOldError) {
        logEventTooOldRejection({
          customerId,
          eventId: body.id,
          eventSlug: body.eventSlug,
          eventTimestamp: timestamp,
          idempotencyKey: body.idempotencyKey,
          logger,
          now: receivedAt,
          projectId,
          maxEventAgeMs: error.context?.maxEventAgeMs,
        })
      }

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
      customerId,
      projectId,
      receivedAt,
      requestId: resolveIngestionMessageRequestId({
        appEnv: c.env.APP_ENV,
        failureTestHeader: c.req.header(INGESTION_TEST_FAILURE_HEADER),
        requestId,
      }),
      source: {
        environment: c.env.APP_ENV,
        apiKeyId: key.id,
        sourceType: "api_key",
        sourceId: key.id,
        sourceName: null,
      },
      timestamp,
      workspaceId: key.project.workspaceId,
    })

    // shard by customerid to make sure the messages of specific customer go to the same queue
    // this way we can group them together in background
    const selectedQueue =
      availableQueues[selectQueueShardIndex(customerId, availableQueues.length)]!

    await safeSendToQueue({
      queue: selectedQueue,
      message,
      logger,
    })

    return c.json({ accepted: true as const }, HttpStatusCodes.ACCEPTED)
  })
}

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
  logger: Logger
  queue: Queue<IngestionQueueMessage>
  message: IngestionQueueMessage
}): Promise<{ accepted: true }> {
  const { logger, queue, message } = params

  for (let attempt = 0; attempt < SAFE_QUEUE_SEND_RETRIES; attempt++) {
    try {
      await queue.send(message)
      return { accepted: true }
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

  logger.error("raw ingestion queue send failed permanently", {
    projectId: message.projectId,
    customerId: message.customerId,
    eventId: message.id,
    idempotencyKey: message.idempotencyKey,
  })

  throw new UnpriceApiError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed to enqueue ingestion event",
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function generateEventId(now = Date.now()): string {
  return `evt_${ulid(now)}`
}

export function buildIngestionQueueMessage(params: {
  body: IngestEventsRequest
  customerId: string
  projectId: string
  receivedAt: number
  requestId: string
  source: IngestionQueueMessage["source"]
  timestamp: number
  workspaceId: string
}): IngestionQueueMessage {
  const { body, customerId, projectId, receivedAt, requestId, source, timestamp, workspaceId } =
    params
  const eventId = body.id ?? generateEventId(receivedAt)

  return ingestionQueueMessageSchema.parse({
    version: 1,
    workspaceId,
    projectId,
    customerId,
    requestId,
    receivedAt,
    idempotencyKey: body.idempotencyKey,
    id: eventId,
    slug: body.eventSlug,
    timestamp,
    properties: body.properties,
    source,
  })
}

export function resolveRequestCustomerId(params: {
  explicitCustomerId?: string
  defaultCustomerId?: string | null
}): string | null {
  return params.explicitCustomerId ?? params.defaultCustomerId ?? null
}

export function resolveIngestionMessageRequestId(params: {
  appEnv: Env["APP_ENV"]
  failureTestHeader?: string | undefined
  requestId: string
}): string {
  if (
    params.appEnv === "production" ||
    params.failureTestHeader !== INGESTION_TEST_FAILURE_RAW_PROCESSING_VALUE
  ) {
    return params.requestId
  }

  return markRawProcessingFailureTestRequestId(params.requestId)
}

export function logEventTooOldRejection(params: {
  customerId: string
  eventId?: string | undefined
  eventSlug: string
  eventTimestamp: number
  idempotencyKey: string
  logger: Pick<Logger, "warn">
  maxEventAgeMs?: number | undefined
  now: number
  projectId: string
}): void {
  params.logger.warn("raw ingestion event rejected as too old", {
    projectId: params.projectId,
    customerId: params.customerId,
    eventId: params.eventId,
    eventSlug: params.eventSlug,
    idempotencyKey: params.idempotencyKey,
    eventTimestamp: params.eventTimestamp,
    now: params.now,
    eventAgeMs: params.now - params.eventTimestamp,
    maxEventAgeMs: params.maxEventAgeMs,
    rejectionReason: "EVENT_TOO_OLD",
  })
}

export type IngestEventsRequest = z.infer<typeof rawEventSchema>
export type IngestEventsResponse = z.infer<typeof acceptedSchema>
