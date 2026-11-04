import {
  type WebEventRow,
  createWebEventRow,
  createWebEventsWriter,
  recordWebEvents,
} from "@unprice/lakehouse"
import type { Logger } from "@unprice/logs"
import { geolocation } from "@vercel/functions"
import { type NextRequest, userAgent } from "next/server"
import { env } from "~/env"
import { detectBot, getDomainWithoutWWW } from "~/lib/domains"
import { LOCALHOST_GEO_DATA } from "~/lib/localhost"
import { getRequestLoggers, withEvlog } from "~/lib/observability"
import { checkTrackingRateLimit } from "~/lib/tracking-rate-limit"
import { type TrackingRequest, parseTrackingRequest, planViewRows } from "~/lib/web-tracking"
import { setCorsHeaders } from "../_enableCors"

export const runtime = "edge"
export const maxDuration = 10

const webEvents = createWebEventsWriter({
  url: env.LAKEHOUSE_WEB_EVENTS_URL,
  token: env.LAKEHOUSE_WEB_EVENTS_TOKEN,
})

async function sendWebEvents(logger: Logger, rows: WebEventRow[]) {
  const result = await recordWebEvents({ webEvents, logger }, rows)
  return result.err ? { error: result.err.code } : result.val
}

/** A page hit plus one plan_view row per plan shown on the page, sent as one batch. */
async function trackPageHit(
  req: NextRequest,
  logger: Logger,
  hit: Extract<TrackingRequest, { action: "page_hit" }>
): Promise<{ sent: number } | { error: string } | string> {
  // don't track bots
  if (detectBot(req)) {
    return "Bot detected"
  }

  const ua = userAgent(req)

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
  const { referrer } = hit.payload

  const pageHit = createWebEventRow({
    kind: "page_hit",
    session_id: hit.session_id,
    project_id: hit.project_id,
    page_id: hit.payload.page_id,
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
    referrer: referrer ? getDomainWithoutWWW(referrer) || "(direct)" : "(direct)",
    referrer_url: referrer || "(direct)",
    locale: hit.payload.locale ?? "",
    pathname: hit.payload.pathname,
    url: hit.payload.url,
  })

  return sendWebEvents(logger, [pageHit, ...planViewRows(hit)])
}

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

  const parsed = parseTrackingRequest(body)

  if (!parsed.success) {
    const response = new Response(JSON.stringify({ error: parsed.error }), { status: 400 })
    setCorsHeaders(response, req.headers.get("origin"))
    return response
  }

  const request = parsed.data

  const rateLimit = await checkTrackingRateLimit({ req, action: request.action })
  if (rateLimit.limited) {
    const response = new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    })
    setCorsHeaders(response, req.headers.get("origin"))
    return response
  }

  switch (request.action) {
    case "page_hit": {
      const result = await trackPageHit(req, logger, request)

      const response = new Response(JSON.stringify(result))
      setCorsHeaders(response, req.headers.get("origin"))
      return response
    }

    case "plan_click": {
      const result = await sendWebEvents(logger, [
        createWebEventRow({
          kind: "plan_click",
          session_id: request.session_id,
          project_id: request.project_id,
          page_id: request.payload.page_id,
          plan_version_id: request.payload.plan_version_id,
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
