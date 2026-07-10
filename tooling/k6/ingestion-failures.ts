import { check, fail } from "k6"
import { Counter } from "k6/metrics"
import { type K6SdkClient, createK6SdkClient } from "./sdk-client"
import {
  type CustomerUsageProfile,
  type UsageEventTarget,
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
let sdk: K6SdkClient | null = null
let failureSdk: K6SdkClient | null = null

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

export async function setup(): Promise<{ target: UsageEventTarget }> {
  validateConfig()

  const profile: CustomerUsageProfile = await discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    sdk: getSdk(),
  })
  const target = profile.usageEvents[0]

  if (!target) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  return { target }
}

export default async function ({ target }: { target: UsageEventTarget }): Promise<void> {
  const result = await getFailureSdk().usage.record({
    customerId: CUSTOMER_ID,
    eventSlug: target.eventSlug,
    id: nextEventId(),
    idempotencyKey: nextIdempotencyKey(target.eventSlug),
    properties: buildProperties(target.propertyFields),
  })

  if (result.error) {
    apiErrors.add(1)
  }

  if (
    check(result, {
      "failure-test event is accepted": (res) => !res.error && res.result?.accepted === true,
    })
  ) {
    failureEventsAccepted.add(1)
  }
}

function nextEventId(): string {
  return `evt_k6_failure_${Date.now()}_${__VU}_${__ITER}_${randomInteger(100000, 999999)}`
}

function nextIdempotencyKey(eventSlug: string): string {
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

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: UNPRICE_TOKEN,
  })

  return sdk
}

function getFailureSdk(): K6SdkClient {
  failureSdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    headers: {
      [FAILURE_HEADER]: FAILURE_HEADER_VALUE,
    },
    token: UNPRICE_TOKEN,
  })

  return failureSdk
}
