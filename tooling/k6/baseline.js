import { check, fail } from "k6"
import http from "k6/http"
import { Counter } from "k6/metrics"
import {
  buildProperties,
  discoverCustomerUsageProfile,
  nonNegativeInteger,
  normalizeBaseUrl,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

const asyncUsageEventsSent = new Counter("async_usage_events_sent")
const verifyRequestsSent = new Counter("verify_requests_sent")
const apiErrors = new Counter("api_errors")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const EVENTS = positiveInteger(__ENV.EVENTS, 1000)
const VUS = positiveInteger(__ENV.VUS, Math.min(10, EVENTS))
const VERIFY_EVERY = nonNegativeInteger(__ENV.VERIFY_EVERY, 100)

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
      "/v1/usage/record",
      {
        customerId: CUSTOMER_ID,
        eventSlug: event.eventSlug,
        idempotencyKey: nextIdempotencyKey(event.eventSlug),
        properties: buildProperties(event.propertyFields),
      },
      "POST /v1/usage/record"
    )
  )
  const verifyRequests = shouldVerifyThisIteration()
    ? buildVerifyRequests(profile.featureSlugs)
    : []

  asyncUsageEventsSent.add(usageRequests.length)
  verifyRequestsSent.add(verifyRequests.length)

  for (const response of http.batch([...usageRequests, ...verifyRequests])) {
    recordApiResponse(response)
  }
}

export function teardown(profile) {
  const verifyRequests = buildVerifyRequests(profile.featureSlugs)

  verifyRequestsSent.add(verifyRequests.length)

  for (const response of http.batch(verifyRequests)) {
    recordApiResponse(response)
  }
}

function discoverCustomerProfile() {
  const profile = discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    postJson,
  })

  check(profile, {
    "access.entitlements.list returns usage profile": (result) => result.usageEvents.length > 0,
  })

  return profile
}

function postJson(path, body, name) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), requestParams(name))
}

function postJsonRequest(path, body, name) {
  return ["POST", `${BASE_URL}${path}`, JSON.stringify(body), requestParams(name)]
}

function buildVerifyRequests(featureSlugs) {
  return featureSlugs.map((featureSlug) =>
    postJsonRequest(
      "/v1/access/check",
      {
        customerId: CUSTOMER_ID,
        featureSlug,
      },
      "POST /v1/access/check"
    )
  )
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

function shouldVerifyThisIteration() {
  return VERIFY_EVERY > 0 && __ITER % VERIFY_EVERY === 0
}

function nextIdempotencyKey(eventSlug) {
  return `k6-async-${eventSlug}-${Date.now()}-${__VU}-${__ITER}-${randomInteger(100000, 999999)}`
}
