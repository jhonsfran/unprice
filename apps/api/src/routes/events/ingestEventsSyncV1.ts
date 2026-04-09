import { createRoute } from "@hono/zod-openapi"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import { INGESTION_REJECTION_REASONS } from "@unprice/services/ingestion"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"
import {
  buildIngestionQueueMessage,
  rawEventSchema,
  resolveRequestCustomerId,
} from "./ingestEventsV1"

const tags = ["ingestion"]

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
  rejectionReason: z.enum(INGESTION_REJECTION_REASONS).optional().openapi({
    description: "Business rejection reason when the event could not be ingested",
    example: "LIMIT_EXCEEDED",
  }),
  message: z.string().optional().openapi({
    description: "Optional details about the synchronous ingestion result",
    example: "Limit exceeded for meter meter_123",
  }),
})

export const route = createRoute({
  path: "/v1/events/ingest/sync",
  operationId: "events.ingestSync",
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
})

export const registerIngestEventsSyncV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const { ingestion } = c.get("services")
    const requestId = c.get("requestId")
    const receivedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? receivedAt

    const key = await keyAuth(c)
    const customerId = resolveRequestCustomerId({
      explicitCustomerId: body.customerId,
      defaultCustomerId: key.defaultCustomerId,
    })

    if (!customerId) {
      throw new UnpriceApiError({
        code: "BAD_REQUEST",
        message: "customerId is required when the API key has no default customer binding",
      })
    }

    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    try {
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

    const message = buildIngestionQueueMessage({
      body,
      customerId,
      projectId,
      receivedAt,
      requestId,
      timestamp,
    })

    const result = await ingestion.ingestFeatureSync({
      featureSlug: body.featureSlug,
      message,
    })

    return c.json(result, HttpStatusCodes.OK)
  })

export type IngestEventsSyncRequest = z.infer<typeof syncEventSchema>
export type IngestEventsSyncResponse = z.infer<typeof syncIngestionResultSchema>
