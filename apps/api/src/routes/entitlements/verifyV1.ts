import { createRoute } from "@hono/zod-openapi"
import { LEDGER_SCALE } from "@unprice/money"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import { INGESTION_REJECTION_REASONS } from "@unprice/services/ingestion"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["access"]

const verifyFeatureStatusSchema = z.object({
  allowed: z.boolean().openapi({
    description: "Whether the feature is currently usable for the requested customer and timestamp",
    example: true,
  }),
  featureSlug: z.string().openapi({
    description: "The feature slug that was verified",
    example: "tokens",
  }),
  rejectionReason: z.enum(INGESTION_REJECTION_REASONS).optional().openapi({
    description: "Why the feature is not usable. Omitted when allowed is true.",
    example: "LIMIT_EXCEEDED",
  }),
  usage: z.number().optional().openapi({
    description: "Current usage in the active meter window. Present for usage features.",
    example: 42,
  }),
  limit: z.number().nullable().optional().openapi({
    description:
      "Configured limit. For usage features this is the active meter-window limit; for tier/package features this is the subscribed quantity limit.",
    example: 100,
  }),
  spending: z
    .object({
      ledgerAmount: z.number().int().openapi({
        description: "Current priced usage spend in ledger scale units",
        example: 4_200_000_000,
      }),
      currency: z.string().length(3).openapi({
        description: "ISO currency code for the spending amount",
        example: "USD",
      }),
      displayAmount: z.string().openapi({
        description: "Ready-to-render localized spending amount",
        example: "$42",
      }),
      scale: z.literal(LEDGER_SCALE).openapi({
        description: "Decimal scale for ledgerAmount",
        example: LEDGER_SCALE,
      }),
    })
    .optional()
    .openapi({
      description: "Current priced usage spend for usage-based features",
    }),
  message: z.string().optional().openapi({
    description: "Optional detail about the verification result",
    example: "Unable to resolve the current meter window for this feature",
  }),
})

export const route = createRoute(
  defineEndpointContract(
    {
      path: "/v1/access/check",
      operationId: "access.check",
      summary: "get current feature status",
      description:
        "Resolve whether a feature is usable for a customer. Usage features return current usage, limit, and priced spend; tier/package features return the subscribed quantity limit.",
      method: "post",
      tags,
      request: {
        body: jsonContentRequired(
          z.object({
            customerId: z.string().openapi({
              description: "The unprice customer ID",
              example: "cus_1H7KQFLr7RepUyQBKdnvY",
            }),
            // externalId: z
            //   .string()
            //   .openapi({
            //     description: "The external customer ID provided at sign up",
            //     example: "user_123",
            //   })
            //   .optional(),
            featureSlug: z.string().openapi({
              description: "The feature slug",
              example: "tokens",
            }),
            timestamp: z
              .number()
              .openapi({
                description:
                  "Optional timestamp to inspect a recent point-in-time state. Defaults to the request start time.",
                example: Date.UTC(2026, 2, 21, 12, 0, 0),
              })
              .optional(),
          }),
          // .superRefine((data, ctx) => {
          //   if (!data.customerId && !data.externalId) {
          //     ctx.addIssue({
          //       code: z.ZodIssueCode.custom,
          //       message: "Either customerId or externalId is required",
          //       path: ["customerId", "externalId"],
          //     })
          //   }
          // }),
          "Body of the request"
        ),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(
          verifyFeatureStatusSchema,
          "The current feature verification status"
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
        path: ["access", "check"],
      },
    }
  )
)

export type VerifyRequest = z.infer<
  (typeof route.request.body)["content"]["application/json"]["schema"]
>
export type VerifyResponse = z.infer<
  (typeof route.responses)[200]["content"]["application/json"]["schema"]
>

export const registerVerifyV1 = (app: App) =>
  app.openapi(route, async (c) => {
    const body = c.req.valid("json")
    const { customerId, featureSlug } = body
    const { ingestion } = c.get("services")
    const requestStartedAt = c.get("requestStartedAt")
    const timestamp = body.timestamp ?? requestStartedAt

    const key = await keyAuth(c)
    const projectId = await resolveContextProjectId(c, key.projectId, customerId)

    try {
      validateEventTimestamp(timestamp, requestStartedAt)
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

    startTime(c, "verify")

    const result = await ingestion.verifyFeatureStatus({
      customerId,
      featureSlug,
      projectId,
      timestamp,
    })

    endTime(c, "verify")

    return c.json(result, HttpStatusCodes.OK)
  })
