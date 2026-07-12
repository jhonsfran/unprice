import { check, fail } from "k6"
import { Counter } from "k6/metrics"
import { type K6SdkClient, createK6SdkClient, describeSdkError } from "./sdk-client"
import {
  type UsageEventTarget,
  buildProperties,
  discoverCustomerUsageProfile,
  normalizeBaseUrl,
  positiveInteger,
} from "./usage-profile.js"

// This scenario deliberately sends more concurrent consume attempts than the
// shared run budget can afford. The authoritative assertion is the final run
// balance, not the number of accepted events: a meter can cost more than one
// currency minor unit per event.
const acceptedAttempts = new Counter("overspend_accepted_attempts")
const budgetDeniedAttempts = new Counter("overspend_budget_denied_attempts")
const unexpectedFailures = new Counter("overspend_unexpected_failures")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const PROJECT_ID = __ENV.PROJECT_ID || ""
const CUSTOMER_ID = __ENV.CUSTOMER_ID || ""
const BUDGET_AMOUNT = positiveInteger(__ENV.BUDGET_AMOUNT, 100)
const ATTEMPTS = positiveInteger(__ENV.ATTEMPTS, Math.max(BUDGET_AMOUNT * 2, 2))
const VUS = positiveInteger(__ENV.VUS, 10)

type StartedRun = NonNullable<Awaited<ReturnType<K6SdkClient["runs"]["start"]>>["result"]>
type ConsumeResult = Awaited<ReturnType<K6SdkClient["runs"]["consume"]>>

type OverspendData = {
  event: UsageEventTarget
  run: Pick<StartedRun, "budgetAmountMinor" | "runId">
}

type SummaryMetric = {
  values?: {
    count?: number
    fails?: number
    rate?: number
  }
}

type SummaryData = {
  metrics: Record<string, SummaryMetric>
}

let sdk: K6SdkClient | null = null

export const options = {
  scenarios: {
    shared_run_overspend: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: ATTEMPTS,
      maxDuration: "5m",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    overspend_unexpected_failures: ["count==0"],
  },
}

export async function setup(): Promise<OverspendData> {
  validateConfig()

  const profile = await discoverCustomerUsageProfile({
    customerId: CUSTOMER_ID,
    projectId: PROJECT_ID,
    sdk: getSdk(),
  })
  const event = profile.usageEvents[0]

  if (!event) {
    fail(`No usage-metered entitlements found for customer ${CUSTOMER_ID}`)
  }

  const startResult = await getSdk().runs.start({
    customerId: CUSTOMER_ID,
    budgetAmountMinor: BUDGET_AMOUNT,
    idempotencyKey: `k6-overspend-shared-run-${Date.now()}`,
    workloadType: "agent",
    workloadId: "k6-overspend-shared-run",
    metadata: { scenario: "overspend" },
  })

  if (!startResult.result || startResult.error) {
    unexpectedFailures.add(1)
    check(startResult, {
      "overspend shared run starts": () => false,
    })
    fail(`Failed to start overspend run: ${describeSdkError(startResult)}`)
  }

  const run = startResult.result
  const startedAsExpected = check(run, {
    "overspend shared run is running": (value) => value.status === "running",
    "overspend shared run uses configured budget": (value) =>
      value.budgetAmountMinor === BUDGET_AMOUNT,
  })

  if (!startedAsExpected) {
    unexpectedFailures.add(1)
    fail("Overspend run did not start in the expected state")
  }

  return {
    event: {
      aggregationField: event.aggregationField,
      aggregationMethod: event.aggregationMethod,
      eventSlug: event.eventSlug,
      featureSlug: event.featureSlug,
      propertyFields: [...event.propertyFields],
    },
    run: {
      budgetAmountMinor: run.budgetAmountMinor,
      runId: run.runId,
    },
  }
}

export default async function (data: OverspendData): Promise<void> {
  const key = `k6-overspend-${data.run.runId}-vu-${__VU}-iter-${__ITER}`
  let result: ConsumeResult

  try {
    result = await getSdk().runs.consume({
      runId: data.run.runId,
      featureSlug: data.event.featureSlug,
      eventSlug: data.event.eventSlug,
      id: `evt-${key}`,
      idempotencyKey: key,
      properties: buildProperties(data.event.propertyFields),
    })
  } catch (_error) {
    unexpectedFailures.add(1)
    check(null, {
      "overspend consume returns a decision": () => false,
    })
    return
  }

  if (!result.result || result.error) {
    unexpectedFailures.add(1)
    check(result, {
      "overspend consume returns a decision": () => false,
    })
    return
  }

  const decision = result.result
  const expectedDecision =
    (decision.accepted && decision.reason === "accepted") ||
    (!decision.accepted && decision.reason === "insufficient_budget")

  if (
    !check(decision, {
      "overspend consume decision is accepted or budget denied": () => expectedDecision,
    })
  ) {
    unexpectedFailures.add(1)
    return
  }

  if (decision.accepted) {
    acceptedAttempts.add(1)
    return
  }

  budgetDeniedAttempts.add(1)
}

export async function teardown(data: OverspendData): Promise<void> {
  try {
    const endResult = await getSdk().runs.end({
      runId: data.run.runId,
      status: "completed",
    })

    if (!endResult.result || endResult.error) {
      unexpectedFailures.add(1)
      check(endResult, {
        "overspend shared run end response is valid": () => false,
      })
    } else if (
      !check(endResult.result, {
        "overspend shared run ends terminally": (run) => isTerminalStatus(run.status),
      })
    ) {
      unexpectedFailures.add(1)
    }
  } catch (_error) {
    unexpectedFailures.add(1)
    check(null, {
      "overspend shared run end response is valid": () => false,
    })
  }

  // Always read the authoritative RunBudget state, including when end failed.
  try {
    const finalResult = await getSdk().runs.get({ runId: data.run.runId })

    if (!finalResult.result || finalResult.error) {
      unexpectedFailures.add(1)
      check(finalResult, {
        "overspend final read response is valid": () => false,
      })
      return
    }

    const finalRun = finalResult.result
    const finalStateExpected = check(finalRun, {
      "overspend final run is terminal": (run) => isTerminalStatus(run.status),
      "overspend final consumed is non-negative and within budget": (run) =>
        run.consumedAmountMinor >= 0 && run.consumedAmountMinor <= BUDGET_AMOUNT,
      "overspend final remaining is non-negative": (run) => run.remainingAmountMinor >= 0,
    })

    if (!finalStateExpected) {
      unexpectedFailures.add(1)
    }
  } catch (_error) {
    unexpectedFailures.add(1)
    check(null, {
      "overspend final read response is valid": () => false,
    })
  }
}

export function handleSummary(data: SummaryData): Record<string, string> {
  const checksRate = metricRate(data, "checks")
  const httpReqFailedRate = metricRate(data, "http_req_failed")
  const summary = {
    acceptedAttempts: metricCount(data, "overspend_accepted_attempts"),
    attempts: ATTEMPTS,
    budgetAmountMinor: BUDGET_AMOUNT,
    budgetDeniedAttempts: metricCount(data, "overspend_budget_denied_attempts"),
    checksRate,
    httpReqFailedRate,
    invariantPassed:
      checksRate === 1 &&
      httpReqFailedRate === 0 &&
      metricCount(data, "overspend_unexpected_failures") === 0,
    unexpectedFailures: metricCount(data, "overspend_unexpected_failures"),
    vus: VUS,
  }

  return {
    stdout: `OVERSPEND_SUMMARY_JSON ${JSON.stringify(summary)}\n`,
  }
}

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({
    baseUrl: BASE_URL,
    token: UNPRICE_TOKEN,
  })

  return sdk
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "canceled", "expired", "budget_exceeded", "failed"].includes(status)
}

function metricCount(data: SummaryData, name: string): number {
  return data.metrics[name]?.values?.count ?? 0
}

function metricRate(data: SummaryData, name: string): number {
  return data.metrics[name]?.values?.rate ?? 0
}

function validateConfig(): void {
  if (!UNPRICE_TOKEN) fail("Missing UNPRICE_TOKEN")
  if (!PROJECT_ID) fail("Missing PROJECT_ID")
  if (!CUSTOMER_ID) fail("Missing CUSTOMER_ID")
}
