import { check, fail } from "k6"
import http from "k6/http"
import { Counter } from "k6/metrics"
import {
  buildProperties,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

const failureEventsAccepted = new Counter("ingestion_failure_events_accepted")
const apiErrors = new Counter("api_errors")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const EVENTS = positiveInteger(__ENV.EVENTS, 1000)
const VUS = positiveInteger(__ENV.VUS, Math.min(10, EVENTS))

const FAILURE_HEADER = "x-unprice-ingestion-test-failure"
const FAILURE_HEADER_VALUE = "raw_queue_processing_failed"

export const options = {
  scenarios: {
    ingestion_failures: {
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

  const profile = discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    postJson,
  })
  const target = profile.usageEvents[0]

  if (!target) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  return { target }
}

export default function ({ target }) {
  const response = postJson(
    "/v1/usage/record",
    {
      customerId: CUSTOMER_ID,
      eventSlug: target.eventSlug,
      id: nextEventId(),
      idempotencyKey: nextIdempotencyKey(target.eventSlug),
      properties: buildProperties(target.propertyFields),
    },
    "POST /v1/usage/record failure test",
    {
      [FAILURE_HEADER]: FAILURE_HEADER_VALUE,
    }
  )

  if (response.status >= 400) {
    apiErrors.add(1)
  }

  if (
    check(response, {
      "failure-test event is accepted": (res) => res.status === 202,
    })
  ) {
    failureEventsAccepted.add(1)
  }
}

function postJson(path, body, name, extraHeaders = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), requestParams(name, extraHeaders))
}

function requestParams(name, extraHeaders = {}) {
  return {
    headers: {
      authorization: `Bearer ${UNPRICE_TOKEN}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    tags: {
      name,
    },
  }
}

function nextEventId() {
  return `evt_k6_failure_${Date.now()}_${__VU}_${__ITER}_${randomInteger(100000, 999999)}`
}

function nextIdempotencyKey(eventSlug) {
  return `k6-failure-${eventSlug}-${Date.now()}-${__VU}-${__ITER}-${randomInteger(100000, 999999)}`
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
