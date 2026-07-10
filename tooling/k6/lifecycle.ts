import { check, fail, sleep } from "k6"
import exec from "k6/execution"
import { Counter } from "k6/metrics"
import { type K6SdkClient, createK6SdkClient, describeSdkError, isRateLimited } from "./sdk-client"
import {
  type CustomerUsageProfile,
  type UsageEventTarget,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
} from "./usage-profile.js"

const customersCreated = new Counter("customers_created")
const usageEventsSent = new Counter("usage_events_sent")
const usageEventsRerouted = new Counter("usage_events_rerouted")
const usageEventsLimitExceeded = new Counter("usage_events_limit_exceeded")
const usageEventsRateLimited = new Counter("usage_events_rate_limited")
const verifyEventsSent = new Counter("verify_events_sent")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const API_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PLAN_SLUG = __ENV.PLAN_SLUG || "FREE"
const SUCCESS_URL = __ENV.SUCCESS_URL || "https://example.com/success"
const CANCEL_URL = __ENV.CANCEL_URL || "https://example.com/cancel"
const USAGE_EVENTS_PER_CUSTOMER = Number(__ENV.USAGE_EVENTS_PER_CUSTOMER || 1)
const VERIFY_EVENTS_PER_CUSTOMER = Number(__ENV.VERIFY_EVENTS_PER_CUSTOMER || 1)
const PROVISIONING_TIMEOUT_MS = Number(__ENV.PROVISIONING_TIMEOUT_MS || 60000)
const PROVISIONING_POLL_MS = Number(__ENV.PROVISIONING_POLL_MS || 500)
const SIGNUP_RETRY_MAX = Number(__ENV.SIGNUP_RETRY_MAX || 8)
const SIGNUP_RETRY_BACKOFF_MS = Number(__ENV.SIGNUP_RETRY_BACKOFF_MS || 500)

let vuCustomerId = ""
let vuEntitlementFeatureSlugs: string[] = []
let vuUsageTargets: UsageEventTarget[] = []
let sdk: K6SdkClient | null = null

export const options = {
  stages: [{ duration: "5s", target: 1 }],
  thresholds: {
    http_req_duration: ["p(50)<120", "p(90)<400", "p(99)<1000"],
    http_req_failed: ["rate<0.05"],
  },
}

export default async function (): Promise<void> {
  if (!API_TOKEN) {
    fail("Missing UNPRICE_TOKEN env var")
  }

  const client = getSdk()

  if (!vuCustomerId || vuEntitlementFeatureSlugs.length === 0 || vuUsageTargets.length === 0) {
    const provisioned = await provisionCustomerForVu(client)
    vuCustomerId = provisioned.customerId
    vuEntitlementFeatureSlugs = provisioned.entitlementFeatureSlugs
    vuUsageTargets = provisioned.usageTargets
  }

  for (let i = 0; i < USAGE_EVENTS_PER_CUSTOMER; i += 1) {
    const usageAmount = randomUsage(1, 25)
    const featureCandidates = rotateValues(vuUsageTargets)
    let eventHandled = false

    for (let candidateIndex = 0; candidateIndex < featureCandidates.length; candidateIndex += 1) {
      const usageTarget = featureCandidates[candidateIndex]!
      const ingestionProperties = buildIngestionProperties(usageTarget, usageAmount)

      if (!ingestionProperties) {
        hardFail(
          `Invalid meter configuration for sync ingestion: featureSlug=${usageTarget.featureSlug} eventSlug=${usageTarget.eventSlug}`
        )
      }

      const usageResult = await client.usage.consume({
        customerId: vuCustomerId,
        featureSlug: usageTarget.featureSlug,
        eventSlug: usageTarget.eventSlug,
        properties: ingestionProperties,
        idempotencyKey: uuidV4(),
      })

      if (isRateLimited(usageResult)) {
        usageEventsRateLimited.add(1)
        sleep(PROVISIONING_POLL_MS / 1000)
        eventHandled = true
        break
      }

      const usageOk = check(usageResult, {
        "usage.consume succeeds": (res) => !res.error && !!res.result,
      })

      if (!usageOk || usageResult.error) {
        hardFail(`usage.consume failed: ${describeSdkError(usageResult)}`)
      }

      if (usageResult.result.allowed) {
        if (candidateIndex > 0) {
          usageEventsRerouted.add(1)
        }
        eventHandled = true
        break
      }

      const rejectedType = classifySyncIngestionRejection(usageResult.result)

      if (rejectedType === "usage_limited") {
        usageEventsLimitExceeded.add(1)

        if (candidateIndex < featureCandidates.length - 1) {
          continue
        }

        eventHandled = true
        break
      }

      hardFail(`usage.consume rejected unexpectedly: ${JSON.stringify(usageResult.result)}`)
    }

    if (!eventHandled) {
      hardFail("ingestSync usage event could not be handled by any usage target")
    }

    usageEventsSent.add(1)
  }

  for (let i = 0; i < VERIFY_EVENTS_PER_CUSTOMER; i += 1) {
    const verifyResult = await client.access.check({
      customerId: vuCustomerId,
      featureSlug: randomFrom(vuEntitlementFeatureSlugs),
    })

    check(verifyResult, {
      "access.check succeeds": (res) => !res.error && !!res.result,
    })

    verifyEventsSent.add(1)
  }

  sleep(1)
}

function hardFail(message: string): never {
  if (exec?.test?.abort) {
    exec.test.abort(message)
  }
  fail(message)
}

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: API_TOKEN,
  })

  return sdk
}

function randomFrom<T>(list: T[]): T {
  const value = list[Math.floor(Math.random() * list.length)]

  if (value === undefined) {
    hardFail("Cannot pick a random value from an empty list")
  }

  return value
}

function randomUsage(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function uuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function classifySyncIngestionRejection(result: { rejectionReason?: string }):
  | "usage_limited"
  | "unknown" {
  if (result.rejectionReason === "LIMIT_EXCEEDED") {
    return "usage_limited"
  }

  return "unknown"
}

function buildIngestionProperties(
  usageTarget: UsageEventTarget,
  usageAmount: number
): Record<string, unknown> | null {
  if (usageTarget.aggregationMethod === "count") {
    return {}
  }

  if (usageTarget.aggregationField) {
    return {
      [usageTarget.aggregationField]: usageAmount,
    }
  }

  return null
}

function rotateValues<T>(values: T[]): T[] {
  if (values.length <= 1) {
    return [...values]
  }

  const start = Math.floor(Math.random() * values.length)
  const ordered: T[] = []

  for (let i = 0; i < values.length; i += 1) {
    ordered.push(values[(start + i) % values.length]!)
  }

  return ordered
}

async function resolveProvisionedProfile(
  client: K6SdkClient,
  customerId: string
): Promise<CustomerUsageProfile> {
  const deadlineAt = Date.now() + PROVISIONING_TIMEOUT_MS

  sleep(3)

  while (Date.now() < deadlineAt) {
    const subscriptionResult = await client.subscriptions.get({ customerId })

    if (isRateLimited(subscriptionResult)) {
      sleep(PROVISIONING_POLL_MS / 1000)
      continue
    }

    const subscriptionOk = check(subscriptionResult, {
      "subscriptions.get succeeds": (res) => !res.error && !!res.result,
    })

    if (!subscriptionOk || subscriptionResult.error) {
      hardFail(`subscriptions.get failed: ${describeSdkError(subscriptionResult)}`)
    }

    if (subscriptionResult.result.activePhase) {
      const profile = await discoverCustomerUsageProfile({
        customerId,
        sdk: client,
      })

      if (profile.featureSlugs.length > 0 && profile.usageEvents.length > 0) {
        return profile
      }
    }

    sleep(PROVISIONING_POLL_MS / 1000)
  }

  hardFail(
    `Customer provisioning did not complete within ${PROVISIONING_TIMEOUT_MS}ms. Subscription activePhase/entitlements still unavailable.`
  )
}

async function provisionCustomerForVu(client: K6SdkClient): Promise<{
  customerId: string
  entitlementFeatureSlugs: string[]
  usageTargets: UsageEventTarget[]
}> {
  for (let attempt = 0; attempt < SIGNUP_RETRY_MAX; attempt += 1) {
    const suffix = `${Date.now()}-${__VU}-${attempt}`
    const signUpResult = await client.customers.signUp({
      creditLinePolicy: "uncapped",
      name: `k6-customer-${suffix}`,
      email: `k6+${suffix}@example.com`,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      planSlug: PLAN_SLUG,
    })

    if (isRateLimited(signUpResult)) {
      const backoffMs = SIGNUP_RETRY_BACKOFF_MS * (attempt + 1)

      if (attempt < SIGNUP_RETRY_MAX - 1) {
        sleep(backoffMs / 1000)
        continue
      }

      hardFail(
        `signUp rate-limited after ${SIGNUP_RETRY_MAX} attempts. Last error=${describeSdkError(signUpResult)}`
      )
    }

    const signUpOk = check(signUpResult, {
      "customers.signUp succeeds": (res) => !res.error && !!res.result,
    })

    if (!signUpOk || signUpResult.error) {
      hardFail(`customers.signUp failed: ${describeSdkError(signUpResult)}`)
    }

    if (signUpResult.result.success === false) {
      hardFail("customers.signUp returned success=false")
    }

    if (signUpResult.result.url && signUpResult.result.url !== SUCCESS_URL) {
      hardFail(
        `signUp returned a non-direct provisioning URL (${signUpResult.result.url}). Use a plan without required payment method for this load test.`
      )
    }

    const customerId = signUpResult.result.customerId

    if (!customerId) {
      hardFail(
        `customers.signUp response missing customerId: ${JSON.stringify(signUpResult.result)}`
      )
    }

    const profile = await resolveProvisionedProfile(client, customerId)

    customersCreated.add(1)

    return {
      customerId,
      entitlementFeatureSlugs: profile.featureSlugs,
      usageTargets: profile.usageEvents,
    }
  }

  hardFail(`signUp failed after ${SIGNUP_RETRY_MAX} attempts`)
}
