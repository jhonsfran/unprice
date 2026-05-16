import { check, fail } from "k6"
import http from "k6/http"
import { Counter } from "k6/metrics"

const asyncUsageEventsSent = new Counter("async_usage_events_sent")
const verifyRequestsSent = new Counter("verify_requests_sent")
const apiErrors = new Counter("api_errors")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const EVENTS = positiveInteger(__ENV.EVENTS, 1000)
const VUS = positiveInteger(__ENV.VUS, Math.min(10, EVENTS))

export const options = {
  scenarios: {
    usage_and_verify: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: EVENTS,
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<3000", "p(99)<6000"],
  },
}

export function setup() {
  validateConfig()

  const profile = discoverCustomerProfile()

  if (profile.usageEvents.length === 0) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  return profile
}

export default function (profile) {
  const usageRequests = profile.usageEvents.map((event) =>
    postJsonRequest(
      "/v1/events/ingest",
      {
        customerId: CUSTOMER_ID,
        eventSlug: event.eventSlug,
        idempotencyKey: nextIdempotencyKey(event.eventSlug),
        properties: buildProperties(event.propertyFields),
      },
      "POST /v1/events/ingest"
    )
  )
  const verifyRequests = profile.featureSlugs.map((featureSlug) =>
    postJsonRequest(
      "/v1/entitlements/verify",
      {
        customerId: CUSTOMER_ID,
        featureSlug,
      },
      "POST /v1/entitlements/verify"
    )
  )

  asyncUsageEventsSent.add(usageRequests.length)
  verifyRequestsSent.add(verifyRequests.length)

  for (const response of http.batch([...usageRequests, ...verifyRequests])) {
    recordApiResponse(response)
  }
}

function discoverCustomerProfile() {
  const response = postJson(
    "/v1/entitlements/get",
    {
      customerId: CUSTOMER_ID,
      projectId: PROJECT_ID,
    },
    "POST /v1/entitlements/get"
  )

  if (
    !check(response, {
      "entitlements.get returns 200": (res) => res.status === 200,
    })
  ) {
    fail(`entitlements.get failed: ${response.status} ${response.body}`)
  }

  const entitlements = parseJson(response)

  if (!Array.isArray(entitlements) || entitlements.length === 0) {
    fail(`No active entitlements found for customer ${CUSTOMER_ID} in project ${PROJECT_ID}`)
  }

  const featureSlugs = []
  const usageEventFieldsByEventSlug = new Map()

  for (const entitlement of entitlements) {
    const featureSlug = getFeatureSlug(entitlement)

    if (featureSlug) {
      featureSlugs.push(featureSlug)
    }

    const meterConfig = getMeterConfig(entitlement)

    if (!meterConfig) {
      continue
    }

    const propertyFields = usageEventFieldsByEventSlug.get(meterConfig.eventSlug) ?? []

    if (meterConfig.aggregationMethod !== "count") {
      if (!meterConfig.aggregationField) {
        fail(
          `Usage meter for feature ${featureSlug ?? "unknown"} uses ${meterConfig.aggregationMethod} but has no aggregationField`
        )
      }

      if (!propertyFields.includes(meterConfig.aggregationField)) {
        propertyFields.push(meterConfig.aggregationField)
      }
    }

    usageEventFieldsByEventSlug.set(meterConfig.eventSlug, propertyFields)
  }

  if (featureSlugs.length === 0) {
    fail(`Could not resolve feature slugs from entitlements for customer ${CUSTOMER_ID}`)
  }

  return {
    featureSlugs: unique(featureSlugs),
    usageEvents: [...usageEventFieldsByEventSlug.entries()].map(([eventSlug, propertyFields]) => ({
      eventSlug,
      propertyFields,
    })),
  }
}

function postJson(path, body, name) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), requestParams(name))
}

function postJsonRequest(path, body, name) {
  return ["POST", `${BASE_URL}${path}`, JSON.stringify(body), requestParams(name)]
}

function requestParams(name) {
  return {
    headers: {
      authorization: `Bearer ${UNPRICE_TOKEN}`,
      "content-type": "application/json",
    },
    tags: {
      name,
    },
  }
}

function validateConfig() {
  if (!UNPRICE_TOKEN) {
    fail("Missing UNPRICE_TOKEN")
  }

  if (!PROJECT_ID) {
    fail("Missing PROJECT_ID")
  }

  if (!CUSTOMER_ID) {
    fail("Missing CUSTOMER_ID")
  }
}

function recordApiResponse(response) {
  if (response.status >= 400) {
    apiErrors.add(1)
  }

  check(response, {
    "request status is successful": (res) => res.status >= 200 && res.status < 300,
  })
}

function buildProperties(propertyFields) {
  const properties = {}

  for (const field of propertyFields) {
    properties[field] = randomUsageValue()
  }

  return properties
}

function parseJson(response) {
  try {
    return response.json()
  } catch (_error) {
    return null
  }
}

function nextIdempotencyKey(eventSlug) {
  return `k6-async-${eventSlug}-${Date.now()}-${__VU}-${__ITER}-${randomInteger(100000, 999999)}`
}

function getFeatureSlug(entitlement) {
  const directSlug = trimString(entitlement?.featureSlug)

  if (directSlug) {
    return directSlug
  }

  return trimString(entitlement?.featurePlanVersion?.feature?.slug)
}

function getMeterConfig(entitlement) {
  const meterConfig = entitlement?.featurePlanVersion?.meterConfig

  if (!meterConfig || typeof meterConfig !== "object") {
    return null
  }

  const eventSlug = trimString(meterConfig.eventSlug)

  if (!eventSlug) {
    return null
  }

  return {
    eventSlug,
    aggregationMethod: trimString(meterConfig.aggregationMethod) || "count",
    aggregationField: trimString(meterConfig.aggregationField),
  }
}

function randomUsageValue() {
  return randomInteger(1, 5)
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function trimString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function unique(values) {
  return [...new Set(values)]
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.floor(parsed)
}
