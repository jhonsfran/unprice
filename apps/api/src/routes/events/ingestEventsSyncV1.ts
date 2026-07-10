import { createRoute } from "@hono/zod-openapi"
import {
  INGESTION_IDEMPOTENCY_STATUSES,
  INGESTION_REJECTION_REASONS,
} from "@unprice/services/ingestion"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { toUnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import type { ServiceContext } from "~/hono/env"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import {
  assertRawEventPayloadWithinLimits,
  buildIngestionQueueMessage,
  enforceRawEventBodyLimit,
  logEventTooOldRejection,
  rawEventSchema,
} from "./ingestEventsV1"
import { validateEventTimestampOrThrow } from "./validate-event-timestamp"

const tags = ["usage"]
export const USAGE_CONSUME_PATH = "/v1/usage/consume"

const syncEventSchema = rawEventSchema.extend({
  featureSlug: z.string().openapi({
    description: "The feature slug to verify and ingest synchronously",
    example: "tokens",
  }),
})

const syncIngestionResultSchema = z.object({
  allowed: z.boolean().openapi({
    description: "Whether the event was accepted and synchronously ingested for the feature",
    example: true,
  }),
  state: z.enum(["processed", "rejected"]).openapi({
    description: "Synchronous ingestion lifecycle state for the targeted feature",
    example: "processed",
  }),
  idempotencyStatus: z.enum(INGESTION_IDEMPOTENCY_STATUSES).openapi({
    description:
      "Whether this request applied a new idempotency key or replayed a previously reported event",
    example: "already_reported",
  }),
  rejectionReason: z.enum(INGESTION_REJECTION_REASONS).optional().openapi({
    description: "Business rejection reason when the event could not be ingested",
    example: "LIMIT_EXCEEDED",
  }),
  message: z.string().optional().openapi({
    description: "Optional details about the synchronous ingestion result",
    example: "Limit exceeded for meter meter_123",
  }),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: USAGE_CONSUME_PATH,
      operationId: "usage.consume",
      summary: "ingest raw event synchronously for a feature",
      description:
        "Validate and synchronously ingest a raw event for one feature slug. This is useful when you want to enforce exact limits from a ingestion.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(syncEventSchema, "The synchronous raw event ingestion payload"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          syncIngestionResultSchema,
          "The synchronous ingestion result for the targeted feature"
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
        path: ["usage", "consume"],
      },
    }
  )
)

export const registerIngestEventsSyncV1 = (app: App) => {
  app.use(USAGE_CONSUME_PATH, enforceRawEventBodyLimit)

  return app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    assertRawEventPayloadWithinLimits(body)

    const { ingestion } = c.get("services")
    const requestId = c.get("requestId")
    const receivedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? receivedAt
    const logger = c.get("logger")

    const key = await keyAuth(c)
    const customerId = resolveCustomerIdForApiKeyOrThrow({
      explicitCustomerId: body.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    validateEventTimestampOrThrow(timestamp, receivedAt, {
      onTooOld: (error) => {
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
      },
    })

    const message = buildIngestionQueueMessage({
      body,
      customerId,
      ingestionMode: "sync",
      projectId,
      receivedAt,
      requestId,
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

    startTime(c, "ingestFeatureSync")
    const result = await ingestFeatureSync({
      featureSlug: body.featureSlug,
      ingestion,
      message,
    })
    endTime(c, "ingestFeatureSync")

    return c.json(result, HttpStatusCodes.OK)
  })
}

export type IngestEventsSyncRequest = z.infer<typeof syncEventSchema>
export type IngestEventsSyncResponse = z.infer<typeof syncIngestionResultSchema>

async function ingestFeatureSync(params: {
  featureSlug: string
  ingestion: ServiceContext["ingestion"]
  message: ReturnType<typeof buildIngestionQueueMessage>
}): Promise<IngestEventsSyncResponse> {
  const { featureSlug, ingestion, message } = params

  try {
    return await ingestion.ingestFeatureSync({
      featureSlug,
      message,
    })
  } catch (error) {
    throw toUnpriceApiError(error)
  }
}
