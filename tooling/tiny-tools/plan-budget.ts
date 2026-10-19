import {
  type ApiError,
  type ApiResult,
  type BudgetBalance,
  type BudgetHold,
  Unprice,
} from "@unprice/api"
import { assert, colors, passed, step } from "./harness"

// End-to-end walk through one budget: every verb, its replay, its denial, and the closing rules.
// Steps share one budget and run in order; each asserts the exact balance the previous left.

const UNPRICE_TOKEN = process.env.UNPRICE_TOKEN || "unprice_dev_1234567890"
const UNPRICE_API_URL = process.env.UNPRICE_API_URL || "http://localhost:8787"
const KEY = `e2e:budget/run:${Date.now()}`

const unprice = new Unprice({ token: UNPRICE_TOKEN, baseUrl: UNPRICE_API_URL })
const budget = unprice.budget(KEY)

// A hard monthly cap and a soft lifetime warning. The soft limit never denies; it only shows up in
// `crossed` when a request takes it below zero.
const definition = {
  key: KEY,
  unit: "USD",
  limits: [
    { amount: "10", window: "month" as const },
    { id: "warn", amount: "5", window: "never" as const, enforce: "soft" as const },
  ],
  holds: { defaultTtlMs: 60_000, maxTtlMs: 300_000 },
}

let firstHold: BudgetHold | null = null
let openHold: BudgetHold | null = null
const recordedAt = Date.now()

function equal<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

function ok<T>(response: ApiResult<T>, label: string): T {
  if (response.error) {
    throw new Error(`${label}: ${response.error.code} ${response.error.message}`)
  }
  return response.result
}

function failsWith(response: ApiResult<unknown>, code: ApiError["code"], label: string): ApiError {
  assert(response.error, `${label}: expected ${code}, got ${JSON.stringify(response.result)}`)
  equal(response.error.code, code, `${label} error code`)
  return response.error
}

function limit(balance: BudgetBalance, id: string) {
  const found = balance.limits.find((candidate) => candidate.id === id)
  assert(found, `limit ${id} should be in the balance`)
  return found
}

/** Asserts the hard monthly limit: consumed, held, and remaining. */
function expectMonth(balance: BudgetBalance, consumed: string, held: string, remaining: string) {
  const month = limit(balance, "month")
  equal(
    { consumed: month.consumed, held: month.held, remaining: month.remaining },
    { consumed, held, remaining },
    "month limit"
  )
  equal(balance.remaining, remaining, "budget remaining")
}

async function createBudget(): Promise<void> {
  const { changes, budget: created } = ok(await unprice.budgets.upsert(definition), "upsert")

  equal(
    changes.map((change) => `${change.change}:${change.limitId}`),
    ["limit.added:month", "limit.added:warn"],
    "changes"
  )
  equal(created.unit, "money:USD", "unit")
  equal(created.version, 1, "version")
  equal(created.closed, false, "closed")
  expectMonth(created.balance, "0", "0", "10")
}

async function upsertIsIdempotent(): Promise<void> {
  const { changes, budget: same } = ok(await unprice.budgets.upsert(definition), "upsert")

  equal(changes, [], "changes")
  equal(same.version, 1, "version")
}

async function getReturnsBudget(): Promise<void> {
  const { budget: read, history } = ok(await budget.get(), "get")

  equal(read.key, KEY, "key")
  equal(
    read.limits.map((l) => `${l.id}:${l.window}:${l.enforce}`),
    ["month:month:hard", "warn:never:soft"],
    "limits"
  )
  equal(read.holds, definition.holds, "holds")
  assert(Array.isArray(history), "history should be an array")
}

async function authorizeHolds(): Promise<void> {
  const authorized = ok(
    await budget.authorize({ amount: 3, idempotencyKey: "auth-1" }),
    "authorize"
  )
  assert(authorized.allowed, "authorize 3 should be allowed")

  equal(authorized.hold.amount, "3", "hold amount")
  equal(authorized.replayed, false, "replayed")
  assert(authorized.hold.expiresAt > Date.now(), "hold should expire in the future")
  expectMonth(authorized.balance, "0", "3", "7")

  const replay = ok(await budget.authorize({ amount: 3, idempotencyKey: "auth-1" }), "replay")
  assert(replay.allowed, "replayed authorize should be allowed")
  equal(replay.hold.id, authorized.hold.id, "replayed hold id")
  equal(replay.replayed, true, "replayed")
  expectMonth(replay.balance, "0", "3", "7")

  firstHold = authorized.hold
}

async function settleReturnsTheRest(): Promise<void> {
  assert(firstHold, "authorize must run first")
  const settled = ok(await firstHold.settle({ amount: "2.5" }), "settle")

  equal([settled.actual, settled.released], ["2.5", "0.5"], "actual and released")
  equal([settled.expired, settled.replayed, settled.crossed], [false, false, []], "flags")
  expectMonth(settled.balance, "2.5", "0", "7.5")

  const replay = ok(await firstHold.settle({ amount: "2.5" }), "settle replay")
  equal(replay.replayed, true, "settle replayed")
  expectMonth(replay.balance, "2.5", "0", "7.5")

  failsWith(await firstHold.settle({ amount: "2" }), "CONFLICT", "settle with another amount")
}

async function releaseReturnsTheHold(): Promise<void> {
  const authorized = ok(
    await budget.authorize({ amount: 1, idempotencyKey: "auth-release" }),
    "authorize"
  )
  assert(authorized.allowed, "authorize 1 should be allowed")

  const released = ok(await authorized.hold.release(), "release")
  equal(released.released, "1", "released")
  expectMonth(released.balance, "2.5", "0", "7.5")

  const replay = ok(await authorized.hold.release(), "release replay")
  equal(replay.replayed, true, "release replayed")
}

async function chargeIsIdempotent(): Promise<void> {
  const charged = ok(await budget.charge({ amount: "1.25", idempotencyKey: "charge-1" }), "charge")
  assert(charged.allowed, "charge should be allowed")
  equal(charged.crossed, [], "crossed")
  expectMonth(charged.balance, "3.75", "0", "6.25")

  const replay = ok(await budget.charge({ amount: "1.25", idempotencyKey: "charge-1" }), "replay")
  assert(replay.allowed, "replayed charge should be allowed")
  equal(replay.replayed, true, "charge replayed")
  expectMonth(replay.balance, "3.75", "0", "6.25")

  failsWith(
    await unprice.budgets.charge({ key: KEY, amount: "2", idempotencyKey: "charge-1" }),
    "CONFLICT",
    "same key, another amount"
  )
}

async function decimalsStayExact(): Promise<void> {
  ok(await budget.charge({ amount: 0.1, idempotencyKey: "charge-0.1" }), "charge 0.1")
  const charged = ok(
    await budget.charge({ amount: 0.2, idempotencyKey: "charge-0.2" }),
    "charge 0.2"
  )
  assert(charged.allowed, "charge should be allowed")

  expectMonth(charged.balance, "4.05", "0", "5.95")
}

async function spendSettlesTheActual(): Promise<void> {
  const value = await budget.spend({ estimate: 1 }, async (hold) => {
    assert(hold.amount === "1", "spend should hold the estimate")
    return { value: "done", actual: 0.95 }
  })
  equal(value, "done", "spend value")

  const { budget: read } = ok(await budget.get(), "get")
  expectMonth(read.balance, "5", "0", "5")
}

async function softLimitOnlyReports(): Promise<void> {
  const charged = ok(await budget.charge({ amount: 1, idempotencyKey: "charge-soft" }), "charge")
  assert(charged.allowed, "a soft limit should never deny")

  equal(charged.crossed, ["warn"], "crossed")
  equal(limit(charged.balance, "warn").remaining, "-1", "warn remaining")
  expectMonth(charged.balance, "6", "0", "4")
}

async function hardLimitDenies(): Promise<void> {
  const tooLarge = ok(
    await budget.authorize({ amount: 100, idempotencyKey: "auth-100" }),
    "authorize 100"
  )
  assert(!tooLarge.allowed && !tooLarge.degraded, "authorize 100 should be denied by the limit")
  equal([tooLarge.blocked.limitId, tooLarge.blocked.remedy], ["month", "raise_limit"], "blocked by")

  const doesNotFit = ok(await budget.charge({ amount: 5, idempotencyKey: "charge-5" }), "charge 5")
  assert(!doesNotFit.allowed && !doesNotFit.degraded, "charge 5 should be denied by the limit")
  equal(
    [doesNotFit.blocked.remedy, doesNotFit.blocked.remaining],
    ["wait_for_reset", "4"],
    "remedy and remaining"
  )
  assert(doesNotFit.blocked.resetsAt !== null, "a monthly limit should reset")

  const authorized = ok(
    await budget.authorize({ amount: 3, idempotencyKey: "auth-open" }),
    "authorize 3"
  )
  assert(authorized.allowed, "authorize 3 should fit")
  openHold = authorized.hold

  const behindHold = ok(await budget.charge({ amount: 2, idempotencyKey: "charge-2" }), "charge 2")
  assert(!behindHold.allowed && !behindHold.degraded, "charge 2 should be denied behind the hold")
  equal(behindHold.blocked.remedy, "release_holds", "remedy")
  expectMonth(behindHold.balance, "6", "3", "1")
}

async function recordNeverDenies(): Promise<void> {
  const input = { amount: 20, idempotencyKey: "evt-1", occurredAt: recordedAt }
  const recorded = ok(await budget.record(input), "record")

  equal(recorded.crossed, ["month"], "crossed")
  expectMonth(recorded.balance, "26", "3", "-19")

  // A retry is the same event even when the caller stamps it with another time.
  const replay = ok(await budget.record({ ...input, occurredAt: recordedAt + 1 }), "record replay")
  equal([replay.replayed, replay.amount, replay.crossed], [true, "20", ["month"]], "replay")
  expectMonth(replay.balance, "26", "3", "-19")

  failsWith(await budget.record({ ...input, amount: 21 }), "CONFLICT", "same key, another amount")
}

async function rejectsBadRequests(): Promise<void> {
  failsWith(
    await unprice.budgets.settle({ key: KEY, holdId: "h_999", amount: "1" }),
    "NOT_FOUND",
    "unknown hold"
  )
  failsWith(
    await unprice.budgets.authorize({ key: KEY, amount: "1", ttlMs: 600_000, idempotencyKey: "t" }),
    "BAD_REQUEST",
    "ttl above maxTtlMs"
  )
  failsWith(await unprice.budgets.upsert({ ...definition, unit: "EUR" }), "CONFLICT", "unit change")
  failsWith(
    await unprice.budgets.record({
      key: KEY,
      amount: "1",
      idempotencyKey: "evt-old",
      occurredAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    }),
    "CONFLICT",
    "usage older than 24 hours"
  )
  failsWith(
    await unprice.budgets.charge({ key: KEY, amount: "0.000000001", idempotencyKey: "nine" }),
    "BAD_REQUEST",
    "nine decimals"
  )
  failsWith(await unprice.budgets.get({ key: `${KEY}/missing` }), "NOT_FOUND", "unknown budget")
}

async function closedBudgetStopsNewSpend(): Promise<void> {
  assert(openHold, "hardLimitDenies must leave a hold open")
  const { changes, budget: closed } = ok(
    await unprice.budgets.upsert({
      ...definition,
      closesAt: Date.now() - 1_000,
    }),
    "upsert closesAt"
  )
  equal(
    changes.map((change) => change.change),
    ["closesAt"],
    "changes"
  )
  equal([closed.version, closed.closed], [2, true], "version and closed")

  const denied = failsWith(
    await unprice.budgets.authorize({ key: KEY, amount: "1", idempotencyKey: "closed" }),
    "CONFLICT",
    "authorize after close"
  )
  equal(denied.code === "CONFLICT" && denied.details?.kind, "budget_closed", "closed details")

  // Usage above the hold is a provider failure to reconcile: 409, and the hold stays open.
  const above = failsWith(await openHold.settle({ amount: 4 }), "CONFLICT", "settle above the hold")
  equal(above.code === "CONFLICT" && above.details?.kind, "hold_amount_exceeded", "above details")

  const settled = ok(await openHold.settle({ amount: 2 }), "settle after close")
  expectMonth(settled.balance, "28", "0", "-18")

  const recorded = ok(
    await budget.record({ amount: 1, idempotencyKey: "evt-2", occurredAt: Date.now() }),
    "record after close"
  )
  expectMonth(recorded.balance, "29", "0", "-19")
}

async function main(): Promise<void> {
  console.info(`\n${colors.cyan("Budget E2E")} against ${colors.dim(UNPRICE_API_URL)}\n`)
  console.info(`  key: ${KEY}\n`)

  await step("upsert: creates the budget", createBudget)
  await step("upsert: the same definition changes nothing", upsertIsIdempotent)
  await step("get: returns the definition and history", getReturnsBudget)
  await step("authorize: holds the estimate and replays by key", authorizeHolds)
  await step("settle: consumes the actual, returns the rest, replays", settleReturnsTheRest)
  await step("release: returns the whole hold, replays", releaseReturnsTheHold)
  await step("charge: consumes once per idempotency key", chargeIsIdempotent)
  await step("charge: decimal amounts stay exact", decimalsStayExact)
  await step("spend: authorizes the estimate and settles the actual", spendSettlesTheActual)
  await step("soft limit: reports crossing without denying", softLimitOnlyReports)
  await step("hard limit: denies with the blocking limit and remedy", hardLimitDenies)
  await step("record: never denied, counted once per key and amount", recordNeverDenies)
  await step("errors: maps rejections to statuses", rejectsBadRequests)
  await step("closesAt: stops new spend, keeps settle and record", closedBudgetStopsNewSpend)

  console.info(`\n  ${colors.green(`${passed()} passed`)}\n`)
}

main().catch(() => {
  process.exit(1)
})
