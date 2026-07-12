import { check, fail } from "k6"
import { Counter, Trend } from "k6/metrics"
import type { ApiResult } from "../../packages/api/src/index"
import { type K6SdkClient, createK6SdkClient, describeSdkError } from "./sdk-client"
import {
  type CustomerUsageProfile,
  type UsageEventTarget,
  buildProperties,
  discoverCustomerUsageProfile,
  nonNegativeInteger,
  normalizeBaseUrl,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

// Latency benchmark, not a load test: measure what an integrator's code
// actually observes (SDK call round-trip) for each request-path endpoint,
// one endpoint at a time so they never contend with each other. Scenarios
// run sequentially: a short warm-up (cache fill, not recorded), then
// access.check, usage.record, and usage.consume at a constant arrival rate,
// plus an optional cold-path scenario that signs up brand-new customers and
// times their first check (new Durable Object + cache miss).
//
// No latency thresholds on purpose — this script produces numbers, it does
// not gate on them. The summary prints a percentile table and one
// LATENCY_SUMMARY_JSON line for machines.

const checkDuration = new Trend("check_duration", true)
const recordDuration = new Trend("record_duration", true)
const consumeDuration = new Trend("consume_duration", true)
const signupDuration = new Trend("signup_duration", true)
const firstCheckDuration = new Trend("first_check_duration", true)

const apiErrors = new Counter("api_errors")
const consumeDenied = new Counter("consume_denied")
const coldCustomersCreated = new Counter("cold_customers_created")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const FEATURE_SLUG = __ENV.FEATURE_SLUG || ""
const RATE = positiveInteger(__ENV.RATE, 20)
const DURATION_SECONDS = parseDurationSeconds(__ENV.DURATION || "60s")
const COLD_SIGNUPS = nonNegativeInteger(__ENV.COLD_SIGNUPS, 0)
const PLAN_SLUG = __ENV.PLAN_SLUG || ""

const WARMUP_SECONDS = 10
// 5s of quiet between scenarios so one endpoint's tail never lands inside
// the next endpoint's measurement window.
const GAP_SECONDS = 5

let sdk: K6SdkClient | null = null

type BenchData = {
  checkFeatureSlug: string
  usageEvent: UsageEventTarget
}

const scenarioStart = (index: number) =>
  `${WARMUP_SECONDS + GAP_SECONDS + index * (DURATION_SECONDS + GAP_SECONDS)}s`

const constantRate = (exec: string, index: number) => ({
  executor: "constant-arrival-rate",
  exec,
  rate: RATE,
  timeUnit: "1s",
  duration: `${DURATION_SECONDS}s`,
  startTime: scenarioStart(index),
  preAllocatedVUs: Math.max(10, RATE),
  maxVUs: Math.max(20, RATE * 2),
})

const scenarios: Record<string, unknown> = {
  warmup: {
    executor: "constant-arrival-rate",
    exec: "warmup",
    rate: 5,
    timeUnit: "1s",
    duration: `${WARMUP_SECONDS}s`,
    startTime: "0s",
    preAllocatedVUs: 5,
    maxVUs: 10,
  },
  warm_check: constantRate("warmCheck", 0),
  usage_record: constantRate("usageRecord", 1),
  usage_consume: constantRate("usageConsume", 2),
}

if (COLD_SIGNUPS > 0) {
  scenarios.cold_check = {
    executor: "per-vu-iterations",
    exec: "coldCheck",
    vus: Math.min(5, COLD_SIGNUPS),
    iterations: Math.ceil(COLD_SIGNUPS / Math.min(5, COLD_SIGNUPS)),
    startTime: scenarioStart(3),
    maxDuration: "5m",
  }
}

export const options = {
  scenarios,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"],
  thresholds: {
    // Sanity only. Latency is reported, never gated here.
    http_req_failed: ["rate<0.05"],
  },
}

export async function setup(): Promise<BenchData> {
  validateConfig()

  const profile = await discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    sdk: getSdk(),
  })

  const usageEvent = profile.usageEvents[0]

  if (!usageEvent) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  const checkFeatureSlug = resolveCheckFeatureSlug(profile, usageEvent)

  check(profile, {
    "check feature slug resolved": () => checkFeatureSlug.length > 0,
  })

  return { checkFeatureSlug, usageEvent }
}

// Fills the API-key, grant-context, and Durable Object caches before the
// measured window opens. Results are deliberately not recorded.
export async function warmup(data: BenchData): Promise<void> {
  await getSdk().access.check({
    customerId: CUSTOMER_ID,
    featureSlug: data.checkFeatureSlug,
  })
}

export async function warmCheck(data: BenchData): Promise<void> {
  const result = await timeSdkCall(checkDuration, () =>
    getSdk().access.check({
      customerId: CUSTOMER_ID,
      featureSlug: data.checkFeatureSlug,
    })
  )

  recordApiResult("access.check", result)
}

export async function usageRecord(data: BenchData): Promise<void> {
  const result = await timeSdkCall(recordDuration, () =>
    getSdk().usage.record({
      customerId: CUSTOMER_ID,
      eventSlug: data.usageEvent.eventSlug,
      idempotencyKey: uniqueKey("lat-record"),
      properties: buildProperties(data.usageEvent.propertyFields),
    })
  )

  recordApiResult("usage.record", result)
}

export async function usageConsume(data: BenchData): Promise<void> {
  const result = await timeSdkCall(consumeDuration, () =>
    getSdk().usage.consume({
      customerId: CUSTOMER_ID,
      featureSlug: data.usageEvent.featureSlug,
      eventSlug: data.usageEvent.eventSlug,
      idempotencyKey: uniqueKey("lat-consume"),
      properties: buildProperties(data.usageEvent.propertyFields),
    })
  )

  recordApiResult("usage.consume", result)

  // A business denial (limit exhausted) is still a valid request-path
  // answer — its duration counts; it is just tallied separately.
  if (result.result && !result.result.allowed) {
    consumeDenied.add(1)
  }
}

// Cold path: a brand-new customer means a new Durable Object and a grant
// -context cache miss, so the first check pays the full cost. Creates real
// customers in the target project — run it only against a disposable
// load-test project.
export async function coldCheck(data: BenchData): Promise<void> {
  const suffix = `${Date.now()}-${__VU}-${__ITER}-${randomInteger(1000, 9999)}`
  const client = getSdk()

  const signupResult = await timeSdkCall(signupDuration, () =>
    client.customers.signUp({
      name: `k6 cold ${suffix}`,
      email: `k6-cold-${suffix}@example.com`,
      planSlug: PLAN_SLUG,
      externalId: `k6-cold-${suffix}`,
      successUrl: "https://example.com/welcome",
      cancelUrl: "https://example.com/pricing",
    })
  )

  recordApiResult("customers.signUp", signupResult)

  const customerId = signupResult.result?.customerId

  if (!signupResult.result?.success || !customerId) {
    return
  }

  coldCustomersCreated.add(1)

  const checkResult = await timeSdkCall(firstCheckDuration, () =>
    client.access.check({
      customerId,
      featureSlug: data.checkFeatureSlug,
    })
  )

  recordApiResult("access.check (cold)", checkResult)
}

type SummaryMetric = {
  type?: string
  contains?: string
  values?: Record<string, number>
}

type SummaryData = {
  metrics: Record<string, SummaryMetric>
}

const REPORT_ROWS: Array<{ metric: string; label: string }> = [
  { metric: "check_duration", label: "access.check (warm)" },
  { metric: "record_duration", label: "usage.record (async)" },
  { metric: "consume_duration", label: "usage.consume (sync)" },
  { metric: "signup_duration", label: "customers.signUp (cold)" },
  { metric: "first_check_duration", label: "access.check (first, cold)" },
]

export function handleSummary(data: SummaryData): Record<string, string> {
  const lines: string[] = []
  const jsonMetrics: Record<string, Record<string, number>> = {}

  lines.push("")
  lines.push("UNPRICE LATENCY BENCHMARK — SDK-observed round-trip, milliseconds")
  lines.push(`target: ${BASE_URL}`)
  lines.push(
    `profile: ${RATE} req/s per scenario · ${DURATION_SECONDS}s per scenario · sequential, never overlapping`
  )
  lines.push("")

  const header = ["endpoint".padEnd(28), "count", "p50", "p90", "p95", "p99", "max"]
    .map((cell, index) => (index === 0 ? cell : String(cell).padStart(9)))
    .join("")
  lines.push(header)
  lines.push("-".repeat(header.length))

  for (const row of REPORT_ROWS) {
    const values = data.metrics[row.metric]?.values

    if (!values || !values.count) {
      continue
    }

    jsonMetrics[row.metric] = {
      count: values.count,
      p50: round(values.med),
      p90: round(values["p(90)"]),
      p95: round(values["p(95)"]),
      p99: round(values["p(99)"]),
      max: round(values.max),
    }

    lines.push(
      [
        row.label.padEnd(28),
        String(values.count).padStart(9),
        formatMs(values.med),
        formatMs(values["p(90)"]),
        formatMs(values["p(95)"]),
        formatMs(values["p(99)"]),
        formatMs(values.max),
      ].join("")
    )
  }

  lines.push("")

  const errors = data.metrics.api_errors?.values?.count ?? 0
  const denied = data.metrics.consume_denied?.values?.count ?? 0
  const coldCreated = data.metrics.cold_customers_created?.values?.count ?? 0
  const failedRate = data.metrics.http_req_failed?.values?.rate ?? 0

  lines.push(`api errors: ${errors} · consume denials (business): ${denied}`)
  lines.push(`http_req_failed rate: ${(failedRate * 100).toFixed(2)}%`)

  if (coldCreated > 0) {
    lines.push(`cold customers created: ${coldCreated} (clean up the load-test project)`)
  }

  lines.push("")
  lines.push(
    "Publishing note: pair every number with region, date, and this harness — percentiles without a method are marketing."
  )
  lines.push("")

  const summaryJson = {
    baseUrl: BASE_URL,
    ratePerSecond: RATE,
    durationSecondsPerScenario: DURATION_SECONDS,
    coldSignups: COLD_SIGNUPS,
    apiErrors: errors,
    consumeDenied: denied,
    httpReqFailedRate: failedRate,
    metrics: jsonMetrics,
  }

  lines.push(`LATENCY_SUMMARY_JSON=${JSON.stringify(summaryJson)}`)
  lines.push("")

  return { stdout: lines.join("\n") }
}

function resolveCheckFeatureSlug(profile: CustomerUsageProfile, usageEvent: UsageEventTarget) {
  if (FEATURE_SLUG) {
    if (!profile.featureSlugs.includes(FEATURE_SLUG)) {
      fail(
        `FEATURE_SLUG "${FEATURE_SLUG}" is not among the customer's entitlements: ${profile.featureSlugs.join(", ")}`
      )
    }

    return FEATURE_SLUG
  }

  return usageEvent.featureSlug
}

function validateConfig(): void {
  if (!UNPRICE_TOKEN) fail("Missing UNPRICE_TOKEN")
  if (!PROJECT_ID) fail("Missing PROJECT_ID")
  if (!CUSTOMER_ID) fail("Missing CUSTOMER_ID")
  if (COLD_SIGNUPS > 0 && !PLAN_SLUG) {
    fail("COLD_SIGNUPS requires PLAN_SLUG (the plan new cold-path customers sign up to)")
  }
}

function recordApiResult(operation: string, result: ApiResult<unknown>): void {
  if (result.error) {
    apiErrors.add(1)
    console.warn(`[${operation}] ${describeSdkError(result)}`)
  }

  check(result, {
    [`${operation} responds`]: (r) => !r.error,
  })
}

async function timeSdkCall<T>(
  trend: Trend,
  operation: () => Promise<ApiResult<T>>
): Promise<ApiResult<T>> {
  const startedAt = Date.now()

  try {
    return await operation()
  } finally {
    trend.add(Date.now() - startedAt)
  }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${__VU}-${__ITER}-${randomInteger(100000, 999999)}`
}

function parseDurationSeconds(value: string): number {
  const match = /^(\d+)(s|m)$/.exec(value.trim())

  if (!match) {
    fail(`DURATION must look like "60s" or "2m", received: ${value}`)
  }

  const amount = Number(match[1])
  return match[2] === "m" ? amount * 60 : amount
}

function formatMs(value: number | undefined): string {
  return (value === undefined ? "—" : value.toFixed(1)).padStart(9)
}

function round(value: number | undefined): number {
  return value === undefined ? 0 : Math.round(value * 10) / 10
}

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: UNPRICE_TOKEN,
  })

  return sdk
}
