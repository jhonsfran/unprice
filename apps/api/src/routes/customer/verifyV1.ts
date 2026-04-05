import { createRoute } from "@hono/zod-openapi"
import { meterConfigSchema, overageStrategySchema } from "@unprice/db/validators"
import {
  EventTimestampTooFarInFutureError,
  EventTimestampTooOldError,
  validateEventTimestamp,
} from "@unprice/services/entitlements"
import { FEATURE_VERIFICATION_STATUSES } from "@unprice/services/ingestion"
import { endTime } from "hono/timing"
import { startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { z } from "zod"
import { keyAuth, resolveContextProjectId } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import * as HttpStatusCodes from "~/util/http-status-codes"

const tags = ["customer"]

const verifyFeatureStatusSchema = z.object({
  allowed: z.boolean().openapi({
    description: "Whether the feature is currently usable for the requested customer and timestamp",
    example: true,
  }),
  status: z.enum(FEATURE_VERIFICATION_STATUSES).openapi({
    description: "The current verification status for the requested feature",
    example: "usage",
  }),
  featureSlug: z.string().openapi({
    description: "The feature slug that was verified",
    example: "tokens",
  }),
  meterConfig: meterConfigSchema.optional().openapi({
    description: "The resolved meter configuration for usage-based features",
  }),
  usage: z.number().optional().openapi({
    description: "Current usage in the active meter window",
    example: 42,
  }),
  limit: z.number().nullable().optional().openapi({
    description: "Configured limit for the active meter window",
    example: 100,
  }),
  isLimitReached: z.boolean().optional().openapi({
    description: "Whether the current usage has reached the current limit",
    example: false,
  }),
  overageStrategy: overageStrategySchema.optional().openapi({
    description: "How the feature behaves once the limit is reached",
    example: "none",
  }),
  message: z.string().optional().openapi({
    description: "Optional detail about the verification result",
    example: "Unable to resolve the current meter window for this feature",
  }),
})

export const route = createRoute({
  path: "/v1/customer/verify",
  operationId: "customers.verify",
  summary: "get current feature status",
  description:
    "Resolve the current state of a feature for a customer and, for usage features, return the live meter method, limit, and usage.",
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
})

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
