import { createRoute } from "@hono/zod-openapi"
import {
  RECORD_ACCEPT_WINDOW_MS,
  USAGE_RECORD_MAX_EVENTS,
  describeDuration,
  recordUsageInputSchema,
  recordUsageResponseSchema,
} from "@unprice/db/validators"
import { meterPayerUsage } from "@unprice/services/use-cases"
import { endTime, startTime } from "hono/timing"
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers"
import { keyAuth, resolveContextProjectId, resolveCustomerIdForApiKeyOrThrow } from "~/auth/key"
import { openApiErrorResponses } from "~/errors/openapi-responses"
import type { App } from "~/hono/app"
import { defineEndpointContract } from "~/openapi/endpoint-contract"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { payerUsageDeps, usageBodyLimit, usageResultToWire } from "./payer-usage"

export const USAGE_RECORD_PATH = "/v1/usage/record"
/** 100 events of at most 4 KB of properties each, with room for the envelope. */
export const USAGE_RECORD_MAX_BODY_BYTES = 512 * 1024

export const route = createRoute(
  defineEndpointContract(
    {
      path: USAGE_RECORD_PATH,
      operationId: "usage.record",
      summary: "record usage that already happened",
      description: `Record up to ${USAGE_RECORD_MAX_EVENTS} usage events. Each goes to its customer's subscription budget, which prices it at ingestion into the billing period that contains its occurredAt. Recorded usage always counts, even past a limit, because the work already ran; the limits it crossed come back in crossed. Events at most ${describeDuration(RECORD_ACCEPT_WINDOW_MS)} old are accepted. The answer has one result per event, in request order: a refused event carries the error a single call would return, and the others still count. A retry with the same idempotency key replays the first answer.`,
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

    // Each event names its customer; a project is resolved once per customer.
    const projects = new Map<string, string>()
    const addressed = []
    for (const event of events) {
      const customerId = resolveCustomerIdForApiKeyOrThrow({
        explicitCustomerId: event.customerId,
        defaultCustomerId: key.defaultCustomerId,
      })
      let projectId = projects.get(customerId)
      if (projectId === undefined) {
        projectId = await resolveContextProjectId(c, key.projectId, customerId)
        projects.set(customerId, projectId)
      }
      addressed.push({ ...event, customerId, projectId })
    }

    startTime(c, "recordUsage")
    const results = await meterPayerUsage(payerUsageDeps(c), {
      verb: "record",
      events: addressed,
      receivedAt: c.get("requestStartedAt"),
    })
    endTime(c, "recordUsage")

    const wire = results.map(usageResultToWire)
    const rejected = wire.filter((result) => result.status === "rejected").length
    c.get("logger").set({
      usage: { verb: "record", events: wire.length, rejected, customers: projects.size },
    })
    return c.json({ accepted: wire.length - rejected, rejected, results: wire }, HttpStatusCodes.OK)
  })
}
