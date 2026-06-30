// @ts-nocheck
import { check, fail, sleep } from "k6"
import exec from "k6/execution"
import http from "k6/http"
import { Counter } from "k6/metrics"
import { Unprice } from "../../packages/api/src/index"

const customersCreated = new Counter("customers_created")
const usageEventsSent = new Counter("usage_events_sent")
const usageEventsRerouted = new Counter("usage_events_rerouted")
const usageEventsLimitExceeded = new Counter("usage_events_limit_exceeded")
const usageEventsRateLimited = new Counter("usage_events_rate_limited")
const verifyEventsSent = new Counter("verify_events_sent")

// const BASE_URL = __ENV.BASE_URL || "https://preview-api.unprice.dev"
const BASE_URL = __ENV.BASE_URL || "http://localhost:8787"
const API_TOKEN = __ENV.UNPRICE_TOKEN || ""
const BILLING_INTERVAL = __ENV.BILLING_INTERVAL || "month"
const CURRENCY = __ENV.CURRENCY || "USD"
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
let vuEntitlementFeatureSlugs = []
let vuUsageTargets = []

export const options = {
  stages: [{ duration: "5s", target: 1 }],
  thresholds: {
    http_req_duration: ["p(50)<120", "p(90)<400", "p(99)<1000"],
    http_req_failed: ["rate<0.05"],
  },
}

function hardFail(message) {
  if (exec?.test?.abort) {
    exec.test.abort(message)
  }
  fail(message)
}

class K6Headers {
  constructor(init = {}) {
    this.values = new Map()

    if (init instanceof K6Headers) {
      for (const [key, value] of init.entries()) {
        this.set(key, value)
      }
      return
    }

    if (typeof init.entries === "function") {
      for (const [key, value] of init.entries()) {
        this.set(key, value)
      }
      return
    }

    for (const [key, value] of Object.entries(init)) {
      this.set(key, Array.isArray(value) ? value.join(",") : value)
    }
  }

  append(key, value) {
    const normalizedKey = key.toLowerCase()
    const currentValue = this.values.get(normalizedKey)
    this.values.set(normalizedKey, currentValue ? `${currentValue}, ${value}` : String(value))
  }

  delete(key) {
    this.values.delete(key.toLowerCase())
  }

  entries() {
    return this.values.entries()
  }

  get(key) {
    return this.values.get(key.toLowerCase()) ?? null
  }

  set(key, value) {
    this.values.set(key.toLowerCase(), String(value))
  }
}

class K6Request {
  constructor(input, init = {}) {
    const source = typeof input === "string" ? null : input
    this.url = typeof input === "string" ? input : input.url
    this.method = init.method ?? source?.method ?? "GET"
    this.headers = new K6Headers(init.headers ?? source?.headers ?? {})
    this.body = init.body ?? source?.body
  }

  clone() {
    return new K6Request(this.url, {
      body: this.body,
      headers: this.headers,
      method: this.method,
    })
  }
}

class K6Response {
  constructor(response) {
    this.body = response.body
    this.headers = new K6Headers(response.headers)
    this.ok = response.status >= 200 && response.status <= 299
    this.status = response.status
    this.statusText = response.status_text ?? String(response.status)
  }

  async json() {
    return JSON.parse(this.body)
  }

  async text() {
    return this.body ?? ""
  }
}

if (!globalThis.Headers) {
  globalThis.Headers = K6Headers
}

if (!globalThis.Request) {
  globalThis.Request = K6Request
}

if (!globalThis.Response) {
  globalThis.Response = K6Response
}

if (!globalThis.FormData) {
  globalThis.FormData = class FormData {}
}

function k6Fetch(request) {
  const requestPath = request.url.startsWith(BASE_URL)
    ? request.url.slice(BASE_URL.length).split("?")[0] || "/"
    : request.url
  const response = http.request(request.method, request.url, request.body, {
    headers: Object.fromEntries(request.headers.entries()),
    tags: {
      name: `${request.method} ${requestPath}`,
    },
  })

  return Promise.resolve(new K6Response(response))
}

function describeSdkError(result) {
  if (!result?.error) {
    return "unknown SDK error"
  }

  return `${result.error.code}: ${result.error.message} (${result.error.requestId})`
}

function isRateLimited(result) {
  return result?.error?.code === "RATE_LIMITED"
}

function createSdkClient() {
  return new Unprice({
    baseUrl: BASE_URL,
    disableTelemetry: true,
    fetch: k6Fetch,
    retry: {
      attempts: 0,
    },
    token: API_TOKEN,
  })
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function randomUsage(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function uuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function classifySyncIngestionRejection(result) {
  if (result?.result?.rejectionReason === "LIMIT_EXCEEDED") {
    return "usage_limited"
  }

  return "unknown"
}

function buildIngestionProperties(usageTarget, usageAmount) {
  if (usageTarget.aggregationMethod === "count") {
    return {}
  }

  if (
    typeof usageTarget.aggregationField === "string" &&
    usageTarget.aggregationField.trim().length > 0
  ) {
    return {
      [usageTarget.aggregationField]: usageAmount,
    }
  }

  return null
}

function rotateFeatureSlugs(featureSlugs) {
  if (featureSlugs.length <= 1) {
    return [...featureSlugs]
  }

  const start = Math.floor(Math.random() * featureSlugs.length)
  const ordered = []

  for (let i = 0; i < featureSlugs.length; i += 1) {
    ordered.push(featureSlugs[(start + i) % featureSlugs.length])
  }

  return ordered
}

async function _resolvePlanSlug(sdk) {
  if (PLAN_SLUG) {
    return PLAN_SLUG
  }

  const listVersionsResult = await sdk.planVersions.list({
    onlyPublished: true,
    onlyLatest: true,
    billingInterval: BILLING_INTERVAL,
    currency: CURRENCY,
  })

  const isOk = check(listVersionsResult, {
    "planVersions.list succeeds": (res) => !res.error && Array.isArray(res.result?.planVersions),
  })

  if (!isOk || listVersionsResult.error) {
    fail(`planVersions.list failed: ${describeSdkError(listVersionsResult)}`)
  }

  const planVersions = listVersionsResult.result?.planVersions || []

  if (planVersions.length === 0) {
    fail("listVersions returned no plan versions")
  }

  const noPaymentPlans = planVersions.filter((pv) => pv?.paymentMethodRequired === false)
  const defaultNoPaymentPlan = noPaymentPlans.find((pv) => pv?.plan?.defaultPlan)
  const selected = defaultNoPaymentPlan || noPaymentPlans[0]

  if (!selected) {
    fail(
      "No published plan with paymentMethodRequired=false found. Set PLAN_SLUG to a non-payment-required plan for this load test."
    )
  }

  const selectedPlanSlug = selected?.plan?.slug

  if (!selectedPlanSlug) {
    fail("Could not resolve planSlug from listVersions response")
  }

  return selectedPlanSlug
}

async function resolveEntitlementFeatureSlugs(sdk, customerId) {
  const deadlineAt = Date.now() + PROVISIONING_TIMEOUT_MS

  // let's give some time to update its state
  sleep(3)

  while (Date.now() < deadlineAt) {
    const subscriptionResult = await sdk.subscriptions.get({ customerId })

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

    const hasActivePhase = Boolean(subscriptionResult.result?.activePhase)
    const entitlementsResult = await sdk.access.entitlements.list({ customerId })

    if (isRateLimited(entitlementsResult)) {
      sleep(PROVISIONING_POLL_MS / 1000)
      continue
    }

    const isOk = check(entitlementsResult, {
      "access.entitlements.list succeeds": (res) => !res.error && Array.isArray(res.result),
    })

    if (!isOk || entitlementsResult.error) {
      hardFail(`access.entitlements.list failed: ${describeSdkError(entitlementsResult)}`)
    }

    const slugs = Array.isArray(entitlementsResult.result)
      ? entitlementsResult.result
          .map((entitlement) => entitlement?.featureSlug)
          .filter((slug) => typeof slug === "string" && slug.length > 0)
      : []

    if (hasActivePhase && slugs.length > 0) {
      return [...new Set(slugs)]
    }

    sleep(PROVISIONING_POLL_MS / 1000)
  }

  hardFail(
    `Customer provisioning did not complete within ${PROVISIONING_TIMEOUT_MS}ms. Subscription activePhase/entitlements still unavailable.`
  )
}

async function resolveUsageTargets(sdk, customerId, featureSlugs) {
  const targets = []

  for (const featureSlug of featureSlugs) {
    let verifyResult = null

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await sdk.access.check({ customerId, featureSlug })

      if (isRateLimited(result)) {
        sleep(PROVISIONING_POLL_MS / 1000)
        continue
      }

      const verifyOk = check(result, {
        "access.check succeeds during usage target resolution": (res) => !res.error && !!res.result,
      })

      if (!verifyOk || result.error) {
        hardFail(`access.check failed while resolving usage targets: ${describeSdkError(result)}`)
      }

      verifyResult = result
      break
    }

    const meterConfig = verifyResult?.result?.meterConfig
    const eventSlug = meterConfig?.eventSlug

    if (typeof eventSlug === "string" && eventSlug.length > 0) {
      targets.push({
        featureSlug,
        eventSlug,
        aggregationMethod: meterConfig?.aggregationMethod,
        aggregationField: meterConfig?.aggregationField,
      })
    }
  }

  if (targets.length === 0) {
    hardFail(
      "No usage-capable entitlement features found (missing meterConfig.eventSlug). Ensure the selected plan includes usage-metered features."
    )
  }

  return targets
}

async function provisionCustomerForVu(sdk) {
  // const resolvedPlanSlug = resolvePlanSlug(sdk)

  for (let attempt = 0; attempt < SIGNUP_RETRY_MAX; attempt += 1) {
    const suffix = `${Date.now()}-${__VU}-${attempt}`
    const signUpPayload = {
      creditLinePolicy: "uncapped",
      name: `k6-customer-${suffix}`,
      email: `k6+${suffix}@example.com`,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      planSlug: PLAN_SLUG,
    }

    const signUpResult = await sdk.customers.signUp(signUpPayload)

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

    if (signUpResult.result?.success === false) {
      hardFail("customers.signUp returned success=false")
    }

    if (signUpResult.result?.url && signUpResult.result.url !== SUCCESS_URL) {
      hardFail(
        `signUp returned a non-direct provisioning URL (${signUpResult.result.url}). Use a plan without required payment method for this load test.`
      )
    }

    const customerId = signUpResult.result?.customerId

    if (!customerId) {
      hardFail(
        `customers.signUp response missing customerId: ${JSON.stringify(signUpResult.result)}`
      )
    }

    const entitlementFeatureSlugs = await resolveEntitlementFeatureSlugs(sdk, customerId)
    const usageTargets = await resolveUsageTargets(sdk, customerId, entitlementFeatureSlugs)

    customersCreated.add(1)

    return {
      customerId,
      entitlementFeatureSlugs,
      usageTargets,
    }
  }

  hardFail(`signUp failed after ${SIGNUP_RETRY_MAX} attempts`)
}

export default async function () {
  if (!API_TOKEN) {
    fail("Missing UNPRICE_TOKEN env var")
  }

  const sdk = createSdkClient()
  if (!vuCustomerId || vuEntitlementFeatureSlugs.length === 0 || vuUsageTargets.length === 0) {
    const provisioned = await provisionCustomerForVu(sdk)
    vuCustomerId = provisioned.customerId
    vuEntitlementFeatureSlugs = provisioned.entitlementFeatureSlugs
    vuUsageTargets = provisioned.usageTargets
  }

  const customerId = vuCustomerId
  const usageTargets = vuUsageTargets
  const verifyFeatureSlugs = vuEntitlementFeatureSlugs

  for (let i = 0; i < USAGE_EVENTS_PER_CUSTOMER; i += 1) {
    const usageAmount = randomUsage(1, 25)
    const featureCandidates = rotateFeatureSlugs(usageTargets)
    let eventHandled = false

    for (let candidateIndex = 0; candidateIndex < featureCandidates.length; candidateIndex += 1) {
      const usageTarget = featureCandidates[candidateIndex]
      const ingestionProperties = buildIngestionProperties(usageTarget, usageAmount)

      if (!ingestionProperties) {
        hardFail(
          `Invalid meter configuration for sync ingestion: featureSlug=${usageTarget.featureSlug} eventSlug=${usageTarget.eventSlug}`
        )
      }

      const usageResult = await sdk.usage.consume({
        customerId,
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

      if (usageResult.result?.allowed) {
        if (candidateIndex > 0) {
          usageEventsRerouted.add(1)
        }
        eventHandled = true
        break
      }

      const rejectedType = classifySyncIngestionRejection(usageResult)

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
    const verifyResult = await sdk.access.check({
      customerId,
      featureSlug: randomFrom(verifyFeatureSlugs),
    })

    check(verifyResult, {
      "access.check succeeds": (res) => !res.error && !!res.result,
    })

    verifyEventsSent.add(1)
  }

  sleep(1)
}
