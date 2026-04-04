// @ts-nocheck
import { check, fail, sleep } from "k6"
import exec from "k6/execution"
import http from "k6/http"
import { Counter } from "k6/metrics"

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

function authHeaders() {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
  }
}

function post(path, payload, tags = {}) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(payload), {
    headers: authHeaders(),
    tags,
  })
}

function _get(path, tags = {}) {
  return http.get(`${BASE_URL}${path}`, {
    headers: authHeaders(),
    tags,
  })
}

function parseJson(response) {
  try {
    return response.json()
  } catch (_err) {
    return null
  }
}

function hardFail(message) {
  if (exec?.test?.abort) {
    exec.test.abort(message)
  }
  fail(message)
}

function unwrapResponse(response) {
  const body = parseJson(response)
  if (response.status >= 200 && response.status <= 299) {
    return { result: body, __response: response }
  }
  const errorBody = body?.error ? body.error : body
  return {
    error: {
      code: errorBody?.code || `HTTP_${response.status}`,
      message: errorBody?.message || response.body,
      requestId: errorBody?.requestId || response.headers["unprice-request-id"] || "N/A",
    },
    __response: response,
  }
}

function createSdkClient() {
  return {
    plans: {
      listPlanVersions(req) {
        const response = post("/v1/plans/listPlanVersions", req, { name: "plan-list" })
        return unwrapResponse(response)
      },
    },
    customers: {
      signUp(req) {
        const response = post("/v1/customer/signUp", req, { name: "customer-signup" })
        return unwrapResponse(response)
      },
      getEntitlements(req) {
        const response = post("/v1/customer/getEntitlements", req, {
          name: "customer-get-entitlements",
        })
        return unwrapResponse(response)
      },
      getSubscription(req) {
        const response = post("/v1/customer/getSubscription", req, {
          name: "customer-get-subscription",
        })
        return unwrapResponse(response)
      },
      verify(req) {
        const response = post("/v1/customer/verify", req, { name: "customer-verify" })
        return unwrapResponse(response)
      },
    },
    events: {
      ingest(req) {
        const response = post("/v1/events/ingest", req, { name: "events-ingest" })
        return unwrapResponse(response)
      },
      ingestSync(req) {
        const response = post("/v1/events/ingest/sync", req, { name: "events-ingest-sync" })
        return unwrapResponse(response)
      },
    },
  }
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

function classifyIngestion429(response) {
  const body = parseJson(response)

  if (body?.error?.code === "RATE_LIMITED" || body?.code === "RATE_LIMITED") {
    return "rate_limited"
  }

  if (body?.deniedReason === "LIMIT_EXCEEDED" || body?.rejectionReason === "LIMIT_EXCEEDED") {
    return "usage_limited"
  }

  return "unknown"
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

function _resolvePlanSlug(sdk) {
  if (PLAN_SLUG) {
    return PLAN_SLUG
  }

  const listPlanVersionsResult = sdk.plans.listPlanVersions({
    onlyPublished: true,
    onlyLatest: true,
    billingInterval: BILLING_INTERVAL,
    currency: CURRENCY,
  })

  const isOk = check(listPlanVersionsResult.__response, {
    "listPlanVersions status is 200": (r) => r.status === 200,
  })

  if (!isOk || listPlanVersionsResult.error) {
    fail(
      `listPlanVersions failed: status=${listPlanVersionsResult.__response.status} body=${listPlanVersionsResult.__response.body}`
    )
  }

  const planVersions = listPlanVersionsResult.result?.planVersions || []

  if (planVersions.length === 0) {
    fail("listPlanVersions returned no plan versions")
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
    fail("Could not resolve planSlug from listPlanVersions response")
  }

  return selectedPlanSlug
}

function resolveEntitlementFeatureSlugs(sdk, customerId) {
  const deadlineAt = Date.now() + PROVISIONING_TIMEOUT_MS

  // let's give some time to update its state
  sleep(3)

  while (Date.now() < deadlineAt) {
    const subscriptionResult = sdk.customers.getSubscription({ customerId })

    if (subscriptionResult.__response.status === 429) {
      sleep(PROVISIONING_POLL_MS / 1000)
      continue
    }

    const subscriptionOk = check(subscriptionResult.__response, {
      "getSubscription status is 200": (r) => r.status === 200,
    })

    if (!subscriptionOk || subscriptionResult.error) {
      hardFail(
        `getSubscription failed: status=${subscriptionResult.__response.status} body=${subscriptionResult.__response.body}`
      )
    }

    const hasActivePhase = Boolean(subscriptionResult.result?.activePhase)
    const entitlementsResult = sdk.customers.getEntitlements({ customerId })

    if (entitlementsResult.__response.status === 429) {
      sleep(PROVISIONING_POLL_MS / 1000)
      continue
    }

    const isOk = check(entitlementsResult.__response, {
      "getEntitlements status is 200": (r) => r.status === 200,
    })

    if (!isOk || entitlementsResult.error) {
      hardFail(
        `getEntitlements failed: status=${entitlementsResult.__response.status} body=${entitlementsResult.__response.body}`
      )
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

function resolveUsageTargets(sdk, customerId, featureSlugs) {
  const targets = []

  for (const featureSlug of featureSlugs) {
    let verifyResult = null

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = sdk.customers.verify({ customerId, featureSlug })

      if (result.__response.status === 429) {
        sleep(PROVISIONING_POLL_MS / 1000)
        continue
      }

      const verifyOk = check(result.__response, {
        "verify status is 200 during usage target resolution": (r) => r.status === 200,
      })

      if (!verifyOk || result.error) {
        hardFail(
          `verify failed while resolving usage targets: status=${result.__response.status} body=${result.__response.body}`
        )
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

function provisionCustomerForVu(sdk) {
  // const resolvedPlanSlug = resolvePlanSlug(sdk)

  for (let attempt = 0; attempt < SIGNUP_RETRY_MAX; attempt += 1) {
    const suffix = `${Date.now()}-${__VU}-${attempt}`
    const signUpPayload = {
      name: `k6-customer-${suffix}`,
      email: `k6+${suffix}@example.com`,
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
      planSlug: PLAN_SLUG,
    }

    const signUpResult = sdk.customers.signUp(signUpPayload)

    if (signUpResult.__response.status === 429) {
      const backoffMs = SIGNUP_RETRY_BACKOFF_MS * (attempt + 1)

      if (attempt < SIGNUP_RETRY_MAX - 1) {
        sleep(backoffMs / 1000)
        continue
      }

      hardFail(
        `signUp rate-limited after ${SIGNUP_RETRY_MAX} attempts. Last body=${signUpResult.__response.body}`
      )
    }

    const signUpOk = check(signUpResult.__response, {
      "signUp status is 200": (r) => r.status === 200,
    })

    if (!signUpOk || signUpResult.error) {
      hardFail(
        `signUp failed: status=${signUpResult.__response.status} body=${signUpResult.__response.body}`
      )
    }

    if (signUpResult.result?.success === false) {
      hardFail(`signUp returned success=false: body=${signUpResult.__response.body}`)
    }

    if (signUpResult.result?.url && signUpResult.result.url !== SUCCESS_URL) {
      hardFail(
        `signUp returned a non-direct provisioning URL (${signUpResult.result.url}). Use a plan without required payment method for this load test.`
      )
    }

    const customerId = signUpResult.result?.customerId

    if (!customerId) {
      hardFail(`signUp response missing customerId: body=${signUpResult.__response.body}`)
    }

    const entitlementFeatureSlugs = resolveEntitlementFeatureSlugs(sdk, customerId)
    const usageTargets = resolveUsageTargets(sdk, customerId, entitlementFeatureSlugs)

    customersCreated.add(1)

    return {
      customerId,
      entitlementFeatureSlugs,
      usageTargets,
    }
  }

  hardFail(`signUp failed after ${SIGNUP_RETRY_MAX} attempts`)
}

export default function () {
  if (!API_TOKEN) {
    fail("Missing UNPRICE_TOKEN env var")
  }

  const sdk = createSdkClient()
  if (!vuCustomerId || vuEntitlementFeatureSlugs.length === 0 || vuUsageTargets.length === 0) {
    const provisioned = provisionCustomerForVu(sdk)
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

      const usageResult = sdk.events.ingestSync({
        customerId,
        featureSlug: usageTarget.featureSlug,
        eventSlug: usageTarget.eventSlug,
        properties: ingestionProperties,
        idempotencyKey: uuidV4(),
      })

      const usageOk = check(usageResult.__response, {
        "ingestSync status is 200 or 429": (r) => r.status === 200 || r.status === 429,
      })

      if (!usageOk) {
        hardFail(
          `ingestSync failed: status=${usageResult.__response.status} body=${usageResult.__response.body}`
        )
      }

      if (usageResult.__response.status === 200) {
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

        hardFail(
          `ingestSync rejected unexpectedly: status=${usageResult.__response.status} body=${usageResult.__response.body}`
        )
      }

      const status429Type = classifyIngestion429(usageResult.__response)

      if (status429Type === "rate_limited") {
        usageEventsRateLimited.add(1)
        sleep(PROVISIONING_POLL_MS / 1000)
        eventHandled = true
        break
      }

      hardFail(
        `ingestSync returned unknown 429 shape: status=${usageResult.__response.status} body=${usageResult.__response.body}`
      )
    }

    if (!eventHandled) {
      hardFail("ingestSync usage event could not be handled by any usage target")
    }

    usageEventsSent.add(1)
  }

  for (let i = 0; i < VERIFY_EVENTS_PER_CUSTOMER; i += 1) {
    const verifyResult = sdk.customers.verify({
      customerId,
      featureSlug: randomFrom(verifyFeatureSlugs),
    })

    check(verifyResult.__response, {
      "verify status is 200": (r) => r.status === 200,
    })

    verifyEventsSent.add(1)
  }

  sleep(1)
}
