import { type BudgetHandle, Unprice } from "@unprice/api"

// Latency probe for budget local mode (ADR-0006 B10), not a load test. One process times N
// authorize+settle pairs against one budget, first remote (one round trip per verb), then local
// (spent from a lease in memory), and reads the budget back to prove the lease added up.
//
//   BASE_URL=http://localhost:8787 UNPRICE_TOKEN=unprice_dev_xxx pnpm --filter @unprice/k6 budget-local
//
// The script builds @unprice/api first, so it measures the SDK in this checkout.
//
// An authorize "waited" when a lease or report answer arrived during it: the fast path never
// yields to the event loop, so no response can land inside a call that did not wait for one.

const baseUrl = new URL(requiredEnv("BASE_URL")).origin
const token = requiredEnv("UNPRICE_TOKEN")
const iterations = positiveInteger(process.env.ITERATIONS, 300)
const estimate = process.env.ESTIMATE ?? "0.001"
const actual = process.env.ACTUAL ?? "0.0007"
const leaseAmount = process.env.LEASE ?? "0.1"
const limit = process.env.LIMIT ?? "100"

type Exchange = { path: string; ms: number }
const exchanges: Exchange[] = []

const unprice = new Unprice({
  baseUrl,
  token,
  disableTelemetry: true,
  fetch: async (request) => {
    const startedAt = performance.now()
    const response = await fetch(request)
    exchanges.push({ path: new URL(request.url).pathname, ms: performance.now() - startedAt })
    return response
  },
})

async function main(): Promise<void> {
  const key = `k6:budget-local/${Date.now()}`
  const upserted = await unprice.budgets.upsert({
    key,
    unit: "units:k6",
    limits: [{ id: "lifetime", amount: limit, window: "never" }],
  })
  assertOk("budgets.upsert", upserted)
  console.info(`budget ${key}: ${iterations} pairs of authorize ${estimate} + settle ${actual}`)

  const remote = await timePairs(unprice.budget(key), "remote")

  const local = unprice.budget(key, {
    mode: "local",
    lease: { amount: leaseAmount, onError: (error) => console.warn("lease report failed", error) },
  })
  const exchangesBefore = exchanges.length
  const localRun = await timePairs(local, "local")
  const closed = await local.close()
  assertOk("close", closed)
  const leaseExchanges = exchanges.slice(exchangesBefore)
  const flushes = leaseExchanges.filter(({ path }) => path === "/v1/budgets/report")
  const grants = leaseExchanges.filter(({ path }) => path === "/v1/budgets/lease")

  const read = await unprice.budgets.get({ key })
  assertOk("budgets.get", read)
  const { balance } = read.result.budget
  const consumed = balance.limits.find(({ id }) => id === "lifetime")?.consumed ?? "missing"
  const expected = units(actual) * BigInt(iterations * 2)
  const ok = balance.held === "0" && consumed !== "missing" && units(consumed) === expected

  const rows: Array<[string, number[]]> = [
    ["remote authorize", remote.authorize],
    ["remote settle", remote.settle],
    ["local authorize", localRun.authorize],
    ["local settle", localRun.settle],
    ["local authorize, waited", localRun.waited],
    ["lease grant (HTTP)", grants.map(({ ms }) => ms)],
    ["lease report (HTTP)", flushes.map(({ ms }) => ms)],
  ]
  printTable(rows)

  const summary = {
    baseUrl,
    iterations,
    estimate,
    actual,
    lease: leaseAmount,
    local: {
      authorize: stats(localRun.authorize, ["p50", "p95", "p99", "max"]),
      waits: { count: localRun.waited.length, ...stats(localRun.waited, ["p50", "p95", "max"]) },
      flush: {
        count: flushes.length,
        ...stats(
          flushes.map(({ ms }) => ms),
          ["p50", "p95", "max"]
        ),
      },
      grants: grants.length,
    },
    remote: {
      authorize: stats(remote.authorize, ["p50", "p95"]),
      settle: stats(remote.settle, ["p50", "p95"]),
    },
    check: { held: balance.held, consumed, expected: `${expected} base units`, ok },
  }
  console.info(`LATENCY_SUMMARY_JSON=${JSON.stringify(summary)}`)

  if (!ok) {
    throw new Error(
      `after close, expected held 0 and ${expected} base units consumed; got held ${balance.held} and consumed ${consumed}`
    )
  }
}

async function timePairs(handle: BudgetHandle, label: string) {
  const authorize: number[] = []
  const settle: number[] = []
  const waited: number[] = []

  for (let i = 0; i < iterations; i++) {
    const answered = exchanges.length
    const startedAt = performance.now()
    const authorized = await handle.authorize({ amount: estimate, idempotencyKey: `${label}_${i}` })
    const authorizedAt = performance.now()
    assertOk(`${label} authorize ${i}`, authorized)
    if (!authorized.result.allowed) {
      throw new Error(
        `${label} authorize ${i} was denied: ${JSON.stringify(authorized.result.blocked)}`
      )
    }
    const settled = await authorized.result.hold.settle({ amount: actual })
    const settledAt = performance.now()
    assertOk(`${label} settle ${i}`, settled)

    authorize.push(authorizedAt - startedAt)
    settle.push(settledAt - authorizedAt)
    if (exchanges.length > answered) waited.push(authorizedAt - startedAt)
    // A real caller does I/O between calls; without a turn of the event loop, background reports
    // could never complete and every refill would look synchronous.
    await new Promise((resolve) => setImmediate(resolve))
  }

  return { authorize, settle, waited }
}

const COLUMNS = ["p50", "p90", "p95", "p99", "max"] as const
type Column = (typeof COLUMNS)[number]

function stats<C extends Column>(
  samples: number[],
  columns: readonly C[]
): Record<C, number | null> {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => {
    if (sorted.length === 0) return null
    const value = sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null
    return value === null ? null : Math.round(value * 1000) / 1000
  }
  const quantile: Record<Column, number> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99, max: 1 }
  return Object.fromEntries(columns.map((column) => [column, at(quantile[column])])) as Record<
    C,
    number | null
  >
}

function printTable(rows: Array<[string, number[]]>): void {
  const header = ["milliseconds".padEnd(26), "count", ...COLUMNS]
    .map((cell, index) => (index === 0 ? cell : cell.padStart(10)))
    .join("")
  const lines = ["", `BUDGET LOCAL MODE LATENCY: ${baseUrl}`, "", header, "-".repeat(header.length)]
  for (const [label, samples] of rows) {
    const values = stats(samples, COLUMNS)
    lines.push(
      [
        label.padEnd(26),
        String(samples.length).padStart(10),
        ...COLUMNS.map((column) => (values[column]?.toFixed(3) ?? "-").padStart(10)),
      ].join("")
    )
  }
  console.info([...lines, ""].join("\n"))
}

/** A decimal at the API's scale of 8, as base units, so sums compare exactly. */
function units(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text)
  if (!match) throw new Error(`${text} is not a decimal with at most 8 places`)
  const [, whole = "0", fraction = ""] = match
  return BigInt(whole) * BigInt(100_000_000) + BigInt(fraction.padEnd(8, "0"))
}

function assertOk<T>(
  operation: string,
  result: { result?: T; error?: { code?: string; message?: string; requestId?: string } }
): asserts result is { result: T; error?: undefined } {
  if (result.error) {
    throw new Error(
      `${operation} failed: ${result.error.code ?? "UNKNOWN"}: ${result.error.message ?? "No message"} (${result.error.requestId ?? "no request ID"})`
    )
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
