import { check, fail } from "k6"
import { Counter, Trend } from "k6/metrics"
import type { ApiResult } from "../../packages/api/src/index"
import { type K6SdkClient, createK6SdkClient, describeSdkError } from "./sdk-client"
import {
  type CustomerUsageProfile,
  buildProperties,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

const runsStarted = new Counter("runs_started")
const runsCompleted = new Counter("runs_completed")
const syncEventsAccepted = new Counter("sync_events_accepted")
const syncEventsDenied = new Counter("sync_events_denied")
const budgetDenials = new Counter("run_budget_denials")
const startRunDuration = new Trend("start_run_duration", true)
const syncEventDuration = new Trend("sync_event_duration", true)
const endRunDuration = new Trend("end_run_duration", true)

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const BUDGET_AMOUNT = positiveInteger(__ENV.BUDGET_AMOUNT, 100)
const EVENTS_PER_RUN = positiveInteger(__ENV.EVENTS_PER_RUN, 50)
const RUNS = positiveInteger(__ENV.RUNS, 10)
const VUS = positiveInteger(__ENV.VUS, Math.min(5, RUNS))
let sdk: K6SdkClient | null = null

export const options = {
  scenarios: {
    budgeted_runs: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: Math.ceil(RUNS / VUS),
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    start_run_duration: ["p(95)<2000"],
    sync_event_duration: ["p(95)<500", "p(99)<1500"],
    end_run_duration: ["p(95)<3000"],
  },
}

export async function setup(): Promise<CustomerUsageProfile> {
  validateConfig()

  const profile = await discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    sdk: getSdk(),
  })

  if (profile.usageEvents.length === 0) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  check(profile, {
    "access.entitlements.list returns usage profile": (p) => p.usageEvents.length > 0,
    "usage events have featureSlug": (p) => p.usageEvents.every((e) => e.featureSlug.length > 0),
  })

  return profile
}

export default async function (profile: CustomerUsageProfile): Promise<void> {
  const client = getSdk()
  const runIdempotencyKey = `k6-run-${__VU}-${__ITER}-${Date.now()}`
  const startResult = await timeSdkCall(startRunDuration, () =>
    client.runs.start({
      customerId: CUSTOMER_ID,
      budgetAmountMinor: BUDGET_AMOUNT,
      idempotencyKey: runIdempotencyKey,
      workloadType: "agent",
      workloadId: `k6-agent-vu${__VU}`,
      metadata: { k6_vu: __VU, k6_iter: __ITER },
    })
  )

  const startOk = check(startResult, {
    "run started": (r) => !r.error && !!r.result,
  })

  if (!startOk || !startResult.result) {
    const message = startResult.error?.message ?? describeSdkError(startResult)

    if (message.includes("wallet balance")) {
      console.warn(`[VU${__VU}] Skipping iteration: ${message}`)
      return
    }

    fail(`Failed to start run: ${describeSdkError(startResult)}`)
  }

  const run = startResult.result
  const runId = run.runId
  runsStarted.add(1)

  check(run, {
    "runId is present": (r) => r.runId.length > 0,
    "run status is running": (r) => r.status === "running",
    "customerId matches": (r) => r.customerId === CUSTOMER_ID,
  })

  let denied = false

  for (let i = 0; i < EVENTS_PER_RUN; i++) {
    const target = profile.usageEvents[i % profile.usageEvents.length]!
    const consumeResult = await timeSdkCall(syncEventDuration, () =>
      client.runs.consume({
        runId,
        featureSlug: target.featureSlug,
        eventSlug: target.eventSlug,
        idempotencyKey: `k6-evt-${runId}-${i}-${randomInteger(100000, 999999)}`,
        properties: buildProperties(target.propertyFields),
      })
    )

    const consumeOk = check(consumeResult, {
      "sync event response": (r) => !r.error && !!r.result,
    })

    if (!consumeOk || consumeResult.error) {
      fail(`Failed to consume run event: ${describeSdkError(consumeResult)}`)
    }

    if (!consumeResult.result.accepted) {
      syncEventsDenied.add(1)
      budgetDenials.add(1)
      denied = true
      break
    }

    syncEventsAccepted.add(1)
  }

  const endResult = await timeSdkCall(endRunDuration, () =>
    client.runs.end({
      runId,
      status: denied ? "completed" : "completed",
    })
  )

  check(endResult, {
    "run ended": (r) => !r.error && !!r.result,
  })

  if (endResult.result) {
    runsCompleted.add(1)

    check(endResult.result, {
      "end status is completed": (r) => r.status === "completed",
      "consumed <= budget": (r) => r.consumedAmountMinor <= BUDGET_AMOUNT,
    })
  }

  const getResult = await client.runs.get({ runId })

  check(getResult, {
    "get run": (r) => !r.error && !!r.result,
  })

  if (getResult.result) {
    check(getResult.result, {
      "final status is terminal": (r) =>
        ["completed", "canceled", "expired", "budget_exceeded", "failed"].includes(r.status),
      "final consumed <= budget": (r) => r.consumedAmountMinor <= BUDGET_AMOUNT,
      "final remaining is non-negative": (r) => r.remainingAmountMinor >= 0,
    })
  }
}

export function teardown(): void {
  // No teardown needed; each run is self-contained.
}

function validateConfig(): void {
  if (!UNPRICE_TOKEN) fail("Missing UNPRICE_TOKEN")
  if (!PROJECT_ID) fail("Missing PROJECT_ID")
  if (!CUSTOMER_ID) fail("Missing CUSTOMER_ID")
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

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: UNPRICE_TOKEN,
  })

  return sdk
}
