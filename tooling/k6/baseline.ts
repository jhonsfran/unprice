import { check, fail } from "k6"
import { Counter } from "k6/metrics"
import type { ApiResult } from "../../packages/api/src/index"
import { type K6SdkClient, createK6SdkClient } from "./sdk-client"
import {
  type CustomerUsageProfile,
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
let sdk: K6SdkClient | null = null

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

export async function setup(): Promise<CustomerUsageProfile> {
  validateConfig()

  const profile = await discoverCustomerProfile()

  if (profile.usageEvents.length === 0) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  return profile
}

export default async function (profile: CustomerUsageProfile): Promise<void> {
  const client = getSdk()
  const usageResults = await Promise.all(
    profile.usageEvents.map((event) =>
      client.usage.record({
        customerId: CUSTOMER_ID,
        eventSlug: event.eventSlug,
        idempotencyKey: nextIdempotencyKey(event.eventSlug),
        properties: buildProperties(event.propertyFields),
      })
    )
  )
  const verifyRequests = shouldVerifyThisIteration()
    ? await runVerifyRequests(client, profile.featureSlugs)
    : []

  asyncUsageEventsSent.add(usageResults.length)
  verifyRequestsSent.add(verifyRequests.length)

  for (const result of [...usageResults, ...verifyRequests]) {
    recordApiResponse(result)
  }
}

export async function teardown(profile: CustomerUsageProfile): Promise<void> {
  const verifyResults = await runVerifyRequests(getSdk(), profile.featureSlugs)

  verifyRequestsSent.add(verifyResults.length)

  for (const result of verifyResults) {
    recordApiResponse(result)
  }
}

async function discoverCustomerProfile(): Promise<CustomerUsageProfile> {
  const profile = await discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    sdk: getSdk(),
  })

  check(profile, {
    "access.entitlements.list returns usage profile": (result) => result.usageEvents.length > 0,
  })

  return profile
}

function runVerifyRequests(
  client: K6SdkClient,
  featureSlugs: string[]
): Promise<ApiResult<unknown>[]> {
  return Promise.all(
    featureSlugs.map((featureSlug) =>
      client.access.check({
        customerId: CUSTOMER_ID,
        featureSlug,
      })
    )
  )
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

function recordApiResponse(result: ApiResult<unknown>): void {
  if (result.error) {
    apiErrors.add(1)
  }

  check(result, {
    "request status is successful": (res) => !res.error,
  })
}

function shouldVerifyThisIteration(): boolean {
  return VERIFY_EVERY > 0 && __ITER % VERIFY_EVERY === 0
}

function nextIdempotencyKey(eventSlug: string): string {
  return `k6-async-${eventSlug}-${Date.now()}-${__VU}-${__ITER}-${randomInteger(100000, 999999)}`
}

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: UNPRICE_TOKEN,
  })

  return sdk
}
