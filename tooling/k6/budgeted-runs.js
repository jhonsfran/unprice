import { check, fail } from "k6"
import http from "k6/http"
import { Counter, Trend } from "k6/metrics"
import {
  buildProperties,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
  parseJson,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

// --- Custom metrics ---
const runsStarted = new Counter("runs_started")
const runsCompleted = new Counter("runs_completed")
const syncEventsAccepted = new Counter("sync_events_accepted")
const syncEventsDenied = new Counter("sync_events_denied")
const budgetDenials = new Counter("run_budget_denials")
const startRunDuration = new Trend("start_run_duration", true)
const syncEventDuration = new Trend("sync_event_duration", true)
const endRunDuration = new Trend("end_run_duration", true)

// --- Configuration ---
const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
// Budget per run in currency minor units (cents). Keep small relative to the
// wallet cap so multiple concurrent runs can coexist. Default: 100 = $1.00/€1.00.
const BUDGET_AMOUNT = positiveInteger(__ENV.BUDGET_AMOUNT, 100)
const EVENTS_PER_RUN = positiveInteger(__ENV.EVENTS_PER_RUN, 50)
const RUNS = positiveInteger(__ENV.RUNS, 10)
const VUS = positiveInteger(__ENV.VUS, Math.min(5, RUNS))

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

export function setup() {
  validateConfig()

  const profile = discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    postJson,
  })

  if (profile.usageEvents.length === 0) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  check(profile, {
    "access.entitlements.list returns usage profile": (p) => p.usageEvents.length > 0,
    "usage events have featureSlug": (p) => p.usageEvents.every((e) => e.featureSlug),
  })

  return profile
}

export default function (profile) {
  // 1. Start a budgeted run
  const runIdempotencyKey = `k6-run-${__VU}-${__ITER}-${Date.now()}`

  const startRes = postJson(
    "/v1/runs/start",
    {
      customerId: CUSTOMER_ID,
      budgetAmount: BUDGET_AMOUNT,
      idempotencyKey: runIdempotencyKey,
      workloadType: "agent",
      workloadId: `k6-agent-vu${__VU}`,
      metadata: { k6_vu: __VU, k6_iter: __ITER },
    },
    "POST /v1/runs/start"
  )

  startRunDuration.add(startRes.timings.duration)

  const startOk = check(startRes, {
    "run started (200)": (r) => r.status === 200,
  })

  if (!startOk) {
    const body = parseJson(startRes)
    const message = body?.error?.message || startRes.body

    // Wallet-empty is an expected condition in load tests -- log and skip iteration
    if (startRes.status === 400 && message.includes("wallet balance")) {
      console.warn(`[VU${__VU}] Skipping iteration: ${message}`)
      return
    }

    fail(`Failed to start run: ${startRes.status} ${message}`)
  }

  const run = parseJson(startRes)
  const runId = run.runId
  runsStarted.add(1)

  check(run, {
    "runId is present": (r) => r.runId && r.runId.length > 0,
    "run status is running": (r) => r.status === "running",
    "customerId matches": (r) => r.customerId === CUSTOMER_ID,
  })

  // 2. Stream sync events into the run
  let denied = false

  for (let i = 0; i < EVENTS_PER_RUN; i++) {
    const target = profile.usageEvents[i % profile.usageEvents.length]

    const eventRes = postJson(
      `/v1/runs/consume/${runId}`,
      {
        featureSlug: target.featureSlug,
        eventSlug: target.eventSlug,
        idempotencyKey: `k6-evt-${runId}-${i}-${randomInteger(100000, 999999)}`,
        properties: buildProperties(target.propertyFields),
      },
      "POST /v1/runs/consume/:runId"
    )

    syncEventDuration.add(eventRes.timings.duration)

    check(eventRes, {
      "sync event response (200)": (r) => r.status === 200,
    })

    if (eventRes.status !== 200) {
      break
    }

    const decision = parseJson(eventRes)

    if (!decision.accepted) {
      syncEventsDenied.add(1)
      budgetDenials.add(1)
      denied = true
      break
    }

    syncEventsAccepted.add(1)
  }

  // 3. End the run
  const endStatus = denied ? "completed" : "completed"
  const endRes = postJson(
    `/v1/runs/end/${runId}`,
    { status: endStatus },
    "POST /v1/runs/end/:runId"
  )

  endRunDuration.add(endRes.timings.duration)

  check(endRes, {
    "run ended (200)": (r) => r.status === 200,
  })

  if (endRes.status === 200) {
    runsCompleted.add(1)
    const endBody = parseJson(endRes)

    check(endBody, {
      "end status is completed": (r) => r.status === "completed",
      "consumed <= budget": (r) => r.consumedAmount <= BUDGET_AMOUNT,
    })
  }

  // 4. Verify final state via GET
  const getRes = http.get(
    `${BASE_URL}/v1/runs/get/${runId}`,
    requestParams("GET /v1/runs/get/:runId")
  )

  check(getRes, {
    "get run (200)": (r) => r.status === 200,
  })

  if (getRes.status === 200) {
    const final = parseJson(getRes)

    check(final, {
      "final status is terminal": (r) =>
        ["completed", "canceled", "expired", "budget_exceeded", "failed"].includes(r.status),
      "final consumed <= budget": (r) => r.consumedAmount <= BUDGET_AMOUNT,
      "final remaining is non-negative": (r) => r.remainingAmount >= 0,
    })
  }
}

export function teardown() {
  // No teardown needed -- each run is self-contained
}

// --- Helpers ---

function postJson(path, body, name) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), requestParams(name))
}

function requestParams(name) {
  return {
    headers: {
      authorization: `Bearer ${UNPRICE_TOKEN}`,
      "content-type": "application/json",
    },
    tags: { name },
  }
}

function validateConfig() {
  if (!UNPRICE_TOKEN) fail("Missing UNPRICE_TOKEN")
  if (!PROJECT_ID) fail("Missing PROJECT_ID")
  if (!CUSTOMER_ID) fail("Missing CUSTOMER_ID")
}
