import { createRoute } from "@hono/zod-openapi"
import {
  RECORD_ACCEPT_WINDOW_MS,
  USAGE_RECORD_MAX_EVENTS,
  type UsageEventResult,
  describeDuration,
  recordUsageInputSchema,
  recordUsageResponseSchema,
} from "@unprice/db/validators"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKey } from "~/auth/key"
import { UnpriceApiError } from "~/errors"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import {
  USAGE_CUSTOMER_FORBIDDEN,
  meterPayerUsageReported,
  usageBodyLimit,
  usageResultToWire,
} from "./payer-usage"

export const USAGE_RECORD_PATH = "/v1/usage/record"
/** 100 events of at most 4 KB of properties each, with room for the envelope. */
export const USAGE_RECORD_MAX_BODY_BYTES = 512 * 1024

export const route = createRoute(
  defineEndpointContract(
    {
      path: USAGE_RECORD_PATH,
      operationId: "usage.record",
      summary: "record usage that already happened",
      description: `Record up to ${USAGE_RECORD_MAX_EVENTS} usage events. Each goes to its customer's subscription budget, which prices it at ingestion into the billing period that contains its occurredAt. Recorded usage always counts, even past a limit, because the work already ran; the limits it crossed come back in crossed. Events at most ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} old are accepted. The answer has one result per event, in request order: a refused event carries the error a single call would return, and the others still count. An event naming a customer the API key cannot use is refused with FORBIDDEN (403), and an event whose budget could not be reached with UNAVAILABLE (503): retry it with the same idempotency key. A retry with the same idempotency key replays the first answer.`,
      method: "post",
      tags: ["usage"],
      request: {
        body: jsonContentRequired(recordUsageInputSchema, "The usage events"),
      },
      responses: {
        [HttpStatusCodes.OK]: jsonContent(recordUsageResponseSchema, "One result per event"),
        ...openApiErrorResponses,
      },
    },
    {
      audience: "public",
      category: "runtime",
      docs: { expose: true },
      sdk: { path: ["usage", "record"] },
    }
  )
)

export const registerRecordUsageV1 = (app: App) => {
  app.use(USAGE_RECORD_PATH, usageBodyLimit(USAGE_RECORD_MAX_BODY_BYTES))

  return app.openapi(route, async (c) => {
    const { events } = c.req.valid("json")
    const key = await keyAuth(c)

    // Each event names its customer; a project is resolved once per customer. An event naming a
    // customer the key cannot use is refused alone; a missing customer is a malformed request.
    const wire: UsageEventResult[] = new Array(events.length)
    const projects = new Map<string, string>()
    const addressed = []
    const positions: number[] = []
    for (const [index, event] of events.entries()) {
      const resolved = resolveCustomerIdForApiKey({
        explicitCustomerId: event.customerId,
        defaultCustomerId: key.defaultCustomerId,
      })
      if (!resolved.success) {
        if (resolved.code === "customer_required") {
          throw new UnpriceApiError({ code: "BAD_REQUEST", message: resolved.message })
        }
        wire[index] = {
          status: "rejected",
          customerId: event.customerId ?? "",
          idempotencyKey: event.idempotencyKey,
          error: { ...USAGE_CUSTOMER_FORBIDDEN, message: resolved.message },
        }
        continue
      }
      const { customerId } = resolved
      let projectId = projects.get(customerId)
      if (projectId === undefined) {
        projectId = await resolveContextProjectId(c, key.projectId, customerId)
        projects.set(customerId, projectId)
      }
      addressed.push({ ...event, customerId, projectId })
      positions.push(index)
    }

    if (addressed.length > 0) {
      const results = await meterPayerUsageReported(c, {
        verb: "record",
        events: addressed,
        receivedAt: c.get("requestStartedAt"),
      })
      results.forEach((result, n) => {
        wire[positions[n] as number] = usageResultToWire(result)
      })
    }

    const rejected = wire.filter((result) => result.status === "rejected").length
    c.get("logger").set({
      usage: { verb: "record", events: wire.length, rejected, customers: projects.size },
    })
    return c.json({ accepted: wire.length - rejected, rejected, results: wire }, HttpStatusCodes.OK)
  })
}
