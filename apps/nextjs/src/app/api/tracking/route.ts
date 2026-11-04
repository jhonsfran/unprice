import { type WebEventRow, createWebEventRow, createWebEventsWriter } from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { geolocation } from "@vercel/functions"
import { type NextRequest, userAgent } from "next/server"
import { z } from "zod"
import { env } from "~/env"
import { detectBot, getDomainWithoutWWW } from "~/lib/domains"
import { LOCALHOST_GEO_DATA } from "~/lib/localhost"
import { getRequestLoggers, withEvlog } from "~/lib/observability"
import { checkTrackingRateLimit } from "~/lib/tracking-rate-limit"
import { setCorsHeaders } from "../_enableCors"

export const runtime = "edge"
export const maxDuration = 10

const webEvents = createWebEventsWriter({
  url: env.LAKEHOUSE_WEB_EVENTS_URL,
  token: env.LAKEHOUSE_WEB_EVENTS_TOKEN,
})

async function sendWebEvents(logger: Logger, rows: WebEventRow[]) {
  const result = await webEvents.send(rows)
  if (result.err) {
    logger.warn(`web analytics events were not recorded: ${result.err.message}`, {
      code: result.err.code,
    })
    return { error: result.err.code }
  }
  return result.val
}

const schemaPageHit = z.object({
  page_id: z.string(),
  plan_ids: z.string().optional(),
  locale: z.string(),
  referrer: z.string(),
  pathname: z.string(),
  url: z.string(),
})

const schemaPlanClick = z.object({
  plan_version_id: z.string().min(1),
  page_id: z.string().min(1),
})

/** A page hit plus one plan_view row per plan shown on the page, sent as one batch. */
const trackPageHit = async (
  req: NextRequest,
  logger: Logger,
  payload: {
    session_id: string
    page_id: string
    project_id: string
    plan_ids: string | null
    locale: string
    referrer: string
    pathname: string
    url: string
  }
): Promise<{ sent: number } | { error: string } | string> => {
  try {
    // validate payload
    const parsedPayload = schemaPageHit.safeParse(payload)

    if (!parsedPayload.success) {
      logger.error(parsedPayload.error)
      return `Invalid payload: ${JSON.stringify(parsedPayload.error)}`
    }

    // get user agent
    const ua = userAgent(req)
    const isBot = detectBot(req)

    // don't track bots
    if (isBot) {
      return "Bot detected"
    }

    // get continent, region & geolocation data
    // interesting, geolocation().region is Vercel's edge region – NOT the actual region
    // so we use the x-vercel-ip-country-region to get the actual region
    const { continent, region } =
      env.VERCEL === "1"
        ? {
            continent: req.headers.get("x-vercel-ip-continent"),
            region: req.headers.get("x-vercel-ip-country-region"),
          }
        : LOCALHOST_GEO_DATA

    const geo = env.VERCEL === "1" ? geolocation(req) : LOCALHOST_GEO_DATA

    const pageHit = createWebEventRow({
      kind: "page_hit",
      session_id: payload.session_id,
      project_id: payload.project_id,
      page_id: payload.page_id,
      continent: continent || "",
      country: geo.country || "Unknown",
      region: region || "Unknown",
      city: geo.city || "Unknown",
      device: ua.device.type || "desktop",
      device_vendor: ua.device.vendor || "Unknown",
      device_model: ua.device.model || "Unknown",
      browser: ua.browser.name || "Unknown",
      browser_version: ua.browser.version || "Unknown",
      engine: ua.engine.name || "Unknown",
      engine_version: ua.engine.version || "Unknown",
      os: ua.os.name || "Unknown",
      os_version: ua.os.version || "Unknown",
      cpu_architecture: ua.cpu?.architecture || "Unknown",
      bot: ua.isBot,
      referrer: payload.referrer ? getDomainWithoutWWW(payload.referrer) || "(direct)" : "(direct)",
      referrer_url: payload.referrer || "(direct)",
      locale: payload.locale,
      pathname: payload.pathname,
      url: payload.url,
    })

    const planViews = (payload.plan_ids?.split(",") ?? [])
      .filter((planVersionId) => planVersionId.length > 0)
      .map((planVersionId) =>
        createWebEventRow({
          kind: "plan_view",
          session_id: payload.session_id,
          project_id: payload.project_id,
          page_id: payload.page_id,
          plan_version_id: planVersionId,
        })
      )

    return await sendWebEvents(logger, [pageHit, ...planViews])
  } catch (error) {
    logger.error(error instanceof Error ? error : String(error))
    return `Error: ${JSON.stringify(error)}`
  }
}

const bodySchema = z.object({
  action: z.enum(["page_hit", "plan_click"]),
  session_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(64),
  payload: z.string().max(8_192),
})

const MAX_TRACKING_BODY_BYTES = 16_384

export const POST = withEvlog(async (req: NextRequest) => {
  const requestId =
    req.headers.get("unprice-request-id") ||
    req.headers.get("x-request-id") ||
    req.headers.get("x-vercel-id") ||
    "unknown"
  const { logger } = getRequestLoggers(requestId)

  // don't track HEAD requests to avoid non-user traffic from inflating click count
  if (req.method === "HEAD") {
    return new Response(JSON.stringify({ error: "Invalid method" }), { status: 400 })
  }

  const contentLength = Number(req.headers.get("content-length") ?? 0)
  if (contentLength > MAX_TRACKING_BODY_BYTES) {
    const response = new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 })
    setCorsHeaders(response, req.headers.get("origin"))
    return response
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 })
  }

  const parsedBody = bodySchema.safeParse(body)

  if (!parsedBody.success) {
    return new Response(JSON.stringify({ error: parsedBody.error.message }), { status: 400 })
  }

  const rateLimit = await checkTrackingRateLimit({ req, action: parsedBody.data.action })
  if (rateLimit.limited) {
    const response = new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    })
    setCorsHeaders(response, req.headers.get("origin"))
    return response
  }

  // biome-ignore lint/suspicious/noExplicitAny: shape is validated downstream by schemaPageHit/schemaPlanClick
  let payload: any
  try {
    payload = JSON.parse(parsedBody.data.payload)
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload JSON" }), { status: 400 })
  }

  switch (parsedBody.data.action) {
    case "page_hit": {
      const result = await trackPageHit(req, logger, {
        session_id: parsedBody.data.session_id,
        project_id: parsedBody.data.project_id,
        ...payload,
      })

      const response = new Response(JSON.stringify(result))
      setCorsHeaders(response, req.headers.get("origin"))
      return response
    }

    case "plan_click": {
      // validate payload
      const parsedPayload = schemaPlanClick.safeParse(payload)

      if (!parsedPayload.success) {
        logger.error(parsedPayload.error)
        return new Response(JSON.stringify({ error: parsedPayload.error.message }), { status: 400 })
      }

      const result = await sendWebEvents(logger, [
        createWebEventRow({
          kind: "plan_click",
          session_id: parsedBody.data.session_id,
          project_id: parsedBody.data.project_id,
          page_id: parsedPayload.data.page_id,
          plan_version_id: parsedPayload.data.plan_version_id,
        }),
      ])

      const response = new Response(JSON.stringify(result))
      setCorsHeaders(response, req.headers.get("origin"))
      return response
    }

    default: {
      const response = new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 })
      setCorsHeaders(response, req.headers.get("origin"))
      return response
    }
  }
})
