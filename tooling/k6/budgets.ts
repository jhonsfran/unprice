import { check, fail } from "k6"
import http, { type BatchRequest, type Response } from "k6/http"
import { Counter } from "k6/metrics"
import type { ErrorResponse } from "../../packages/api/src/index"
import type { OperationInput, OperationResponse } from "../../packages/api/src/operation-types"
import { type K6SdkClient, createK6SdkClient, describeSdkError } from "./sdk-client"
import {
  nonNegativeInteger,
  normalizeBaseUrl,
  positiveInteger,
  randomInteger,
} from "./usage-profile.js"

// Concurrency, accuracy, and latency of budgets (ADR-0006).
//
// `gated` fires authorize→settle, authorize→release, and charge at a fixed arrival rate against
// KEYS budgets sized to run out partway through, so admits and denials race on one counter.
// `recorded` sends usage to its own smaller budget, whose hard limit caps record the same way. A
// share of the final writes go out twice in one batch, the way a client retry races its original.
//
// Accuracy: every applied amount adds to `budget_drift_ticks`, and teardown subtracts what each
// budget consumed, so the counter ends at 0 only when nothing was lost or counted twice.
// Concurrency: teardown checks that no hard limit was overspent and no hold was left open.

const drift = new Counter("budget_drift_ticks")
const admitted = new Counter("budget_admitted")
const denied = new Counter("budget_denied")
const unexpected = new Counter("budget_unexpected")
const broken = new Counter("budget_broken_invariants")

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL || "http://localhost:8787")
const UNPRICE_TOKEN = __ENV.UNPRICE_TOKEN || ""
const RATE = positiveInteger(__ENV.RATE, 50)
const DURATION = __ENV.DURATION || "30s"
const VUS = positiveInteger(__ENV.VUS, 50)
const KEYS = positiveInteger(__ENV.KEYS, 1)
const LIMIT = positiveInteger(__ENV.LIMIT, 200)
const RECORD_RATE = nonNegativeInteger(__ENV.RECORD_RATE, Math.max(1, Math.floor(RATE / 10)))
const DUPLICATE_PERCENT = nonNegativeInteger(__ENV.DUPLICATE_PERCENT, 10)
const P95_MS = positiveInteger(__ENV.P95_MS, 500)
const P99_MS = positiveInteger(__ENV.P99_MS, 1500)

/** Amounts are whole ticks of 0.0001, from one tick to one unit, so sums stay exact in a double. */
const TICKS_PER_UNIT = 10_000
const LIMIT_ID = "lifetime"
const VERBS = ["authorize", "settle", "release", "charge", "record"] as const

type Verb = (typeof VERBS)[number]
type Results = { [V in Verb]: OperationResponse<`budgets.${V}`> }
/** The API answered with an error status. */
type Refused = { ok: false; status: number; error: ErrorResponse["error"] | null }
/** No HTTP response arrived (k6 reports status 0): the transport error. */
type Lost = { ok: false; transport: string }
type Failure = Refused | Lost
type Answer<R> = { ok: true; result: R } | Failure
type BudgetData = { keys: string[]; recordKey: string }

let sdk: K6SdkClient | null = null

// A 402 is a decision, not a failed request.
http.setResponseCallback(http.expectedStatuses(200, 402))

export const options = {
  scenarios: {
    gated: {
      executor: "constant-arrival-rate",
      exec: "gated",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: VUS,
      maxVUs: VUS * 4,
    },
    ...(RECORD_RATE > 0
      ? {
          recorded: {
            executor: "constant-arrival-rate",
            exec: "recorded",
            rate: RECORD_RATE,
            timeUnit: "1s",
            duration: DURATION,
            preAllocatedVUs: Math.max(1, Math.ceil(VUS / 10)),
            maxVUs: VUS,
          },
        }
      : {}),
  },
  thresholds: {
    budget_drift_ticks: ["count==0"],
    budget_unexpected: ["count==0"],
    budget_broken_invariants: ["count==0"],
    checks: ["rate==1"],
    http_req_failed: ["rate==0"],
    ...Object.fromEntries(
      VERBS.map((verb) => [
        `http_req_duration{name:POST /v1/budgets/${verb}}`,
        [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
      ])
    ),
  },
}

export async function setup(): Promise<BudgetData> {
  if (!UNPRICE_TOKEN) fail("Missing UNPRICE_TOKEN")

  const run = `k6:budgets/${Date.now()}`
  const keys = Array.from({ length: KEYS }, (_, index) => `${run}/gated:${index}`)
  const recordKey = `${run}/recorded`

  for (const key of keys) {
    await upsert(key, String(LIMIT))
  }
  // RECORD_RATE defaults to a tenth of RATE, so a tenth of the limit runs out partway through too.
  await upsert(recordKey, String(Math.max(1, Math.floor(LIMIT / 10))))

  console.info(`budgets: ${KEYS} gated key(s) with a ${LIMIT} limit under ${run}`)
  return { keys, recordKey }
}

export function gated(data: BudgetData): void {
  const key = data.keys[randomInteger(0, data.keys.length - 1)]!
  const id = `${__VU}-${__ITER}`
  const amount = randomInteger(1, TICKS_PER_UNIT)
  const roll = randomInteger(1, 100)

  if (roll > 70) {
    const body = { key, amount: toDecimal(amount), idempotencyKey: `charge-${id}` }
    tally("charge", post("charge", body, copies()), amount)
    return
  }

  const body = { key, amount: toDecimal(amount), idempotencyKey: `hold-${id}` }
  const hold = tally("authorize", post("authorize", body), 0)
  if (!hold) return

  if (roll > 55) {
    tally("release", post("release", { key, holdId: hold.holdId }, copies()), 0)
    return
  }

  const actual = randomInteger(0, amount)
  const settle = { key, holdId: hold.holdId, amount: toDecimal(actual) }
  tally("settle", post("settle", settle, copies()), actual)
}

export function recorded(data: BudgetData): void {
  const amount = randomInteger(1, TICKS_PER_UNIT)
  const body = {
    key: data.recordKey,
    amount: toDecimal(amount),
    idempotencyKey: `record-${__VU}-${__ITER}`,
    occurredAt: Date.now(),
  }
  tally("record", post("record", body, copies()), amount)
}

export async function teardown(data: BudgetData): Promise<void> {
  for (const key of [...data.keys, data.recordKey]) {
    const { result, error } = await getSdk().budgets.get({ key })

    if (error) {
      broken.add(1)
      console.error(`budgets.get ${key}: ${describeSdkError({ error })}`)
      continue
    }

    const limit = result.budget.balance.limits.find((candidate) => candidate.id === LIMIT_ID)
    if (!limit) fail(`${key} has no ${LIMIT_ID} limit`)

    const consumed = toTicks(limit.consumed)
    drift.add(-consumed)

    const held = check(limit, {
      "teardown: no hold is left open": (value) => value.held === "0",
      "teardown: remaining is the limit minus consumed": (value) =>
        toTicks(value.remaining) === toTicks(value.amount) - consumed,
      "teardown: a hard limit is never overspent": (value) => consumed <= toTicks(value.amount),
    })
    if (!held) broken.add(1)

    console.info(`${key}: consumed ${limit.consumed} of ${limit.amount}, held ${limit.held}`)
  }
}

/** Sends `body` as `copies` concurrent requests in one batch: a retry racing its original. */
function post<V extends Verb>(verb: V, body: OperationInput<`budgets.${V}`>, copies = 1) {
  const path = `/v1/budgets/${verb}`
  const request: BatchRequest = [
    "POST",
    `${BASE_URL}${path}`,
    JSON.stringify(body),
    {
      headers: { authorization: `Bearer ${UNPRICE_TOKEN}`, "content-type": "application/json" },
      tags: { name: `POST ${path}` },
    },
  ]
  return http.batch(Array.from({ length: copies }, () => request)).map(answerOf<V>)
}

function answerOf<V extends Verb>(response: Response): Answer<Results[V]> {
  if (response.status === 0) return { ok: false, transport: response.error }
  const body = response.body ? JSON.parse(response.body) : null
  // The response is trusted to match its OpenAPI contract; the checks below verify the semantics.
  return response.status === 200
    ? { ok: true, result: body as Results[V] }
    : { ok: false, status: response.status, error: (body as ErrorResponse | null)?.error ?? null }
}

/**
 * Counts one logical request sent as one or more copies. Of the copies that succeeded, exactly
 * one applied and the rest replayed it; its amount is added once. Returns the applied answer.
 */
function tally<R extends { replayed: boolean }>(
  verb: Verb,
  answers: Answer<R>[],
  amount: number
): R | null {
  const succeeded = answers.flatMap((answer) => (answer.ok ? [answer.result] : []))
  const applied = succeeded.filter((result) => !result.replayed)
  const failures = answers.flatMap((answer) => (answer.ok ? [] : [answer]))
  const denials = failures.filter((failure) => isLimitDenial(verb, failure))

  for (const failure of failures) {
    if (denials.includes(failure)) continue
    unexpected.add(1, { verb })
    console.error(
      "transport" in failure
        ? `${verb}: no response (${failure.transport})`
        : `${verb} ${failure.status}: ${JSON.stringify(failure.error)}`
    )
  }

  check(applied, {
    [`${verb}: a request applies once and its retries replay it`]: (value) =>
      succeeded.length === 0 || value.length === 1,
  })

  const [result] = applied
  if (result) {
    admitted.add(1, { verb })
    drift.add(amount)
    return result
  }
  if (denials.length > 0) denied.add(1, { verb })
  return null
}

/** A 402 from a debiting verb, naming the lifetime limit and a remedy that can apply to it. */
function isLimitDenial(verb: Verb, failure: Failure): boolean {
  if ("transport" in failure) return false
  const { error } = failure
  return (
    (verb === "authorize" || verb === "charge" || verb === "record") &&
    failure.status === 402 &&
    error?.code === "BUDGET_EXCEEDED" &&
    error.details?.kind === "budget_exceeded" &&
    error.details.blocked.limitId === LIMIT_ID &&
    // A lifetime limit never resets.
    error.details.blocked.remedy !== "wait_for_reset"
  )
}

function copies(): number {
  return randomInteger(1, 100) <= DUPLICATE_PERCENT ? 2 : 1
}

async function upsert(key: string, amount: string): Promise<void> {
  const { error } = await getSdk().budgets.upsert({
    key,
    unit: "units:k6",
    limits: [{ id: LIMIT_ID, amount, window: "never" }],
  })
  if (error) fail(`budgets.upsert ${key}: ${describeSdkError({ error })}`)
}

function toDecimal(ticks: number): string {
  const whole = Math.floor(ticks / TICKS_PER_UNIT)
  const fraction = String(ticks % TICKS_PER_UNIT)
    .padStart(4, "0")
    .replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function toTicks(decimal: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(decimal)
  if (!match) fail(`${decimal} is not a decimal with at most 4 places: an amount was corrupted`)
  const [, sign, whole = "0", fraction = ""] = match
  const ticks = Number(whole) * TICKS_PER_UNIT + Number(fraction.padEnd(4, "0"))
  return sign ? -ticks : ticks
}

function getSdk(): K6SdkClient {
  sdk ??= createK6SdkClient({ baseUrl: BASE_URL, token: UNPRICE_TOKEN })
  return sdk
}
