import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import {
  type LeaseReportRequest,
  type LeaseReportResponse,
  type LeaseRequest,
  type LeaseResponse,
  type LeaseTransport,
  type LocalBudgetHandle,
  type LocalLeaseOptions,
  createLocalLeases,
} from "./budget-local"
import { type BudgetHandle, type SpendSettlement, createBudgetHandle } from "./budgets"
import { Unprice } from "./client"
import type { ApiError } from "./errors"
import type { GeneratedSdkResources } from "./generated/sdk-resources"
import { fromUnits, toUnits } from "./lease-ledger"
import type { ApiResult } from "./result"

const ZERO = BigInt(0)
const units = (text: string) => {
  const parsed = toUnits(text)
  if (parsed === null) throw new Error(`bad amount ${text}`)
  return parsed
}
const smaller = (a: bigint, b: bigint) => (a < b ? a : b)

const unreachable: ApiError = {
  code: "FETCH_ERROR",
  message: "fetch failed",
  docs: "https://developer.mozilla.org/en-US/docs/Web/API/fetch",
  requestId: "N/A",
}
const terms = { holds: { defaultTtlMs: 900_000, maxTtlMs: 86_400_000 }, closesAt: null }

type ServerLease = {
  granted: bigint
  captured: bigint
  seq: number
  ttlMs: number
  expiresAt: number
  status: "open" | "closed" | "expired"
  grant?: LeaseResponse
  last: { request: LeaseReportRequest; response: LeaseReportResponse } | null
}

/**
 * A lease server with `room` capacity under one hard limit, on the fake clock. A refused grant
 * replays its 402 under the same lease key. `lose` applies the next request and drops its answer;
 * `down` refuses every request; `block` parks reports.
 */
function createServer(room: string) {
  const state = {
    room: units(room),
    leases: new Map<string, ServerLease>(),
    refusals: new Map<string, ApiError>(),
    lose: 0,
    down: false,
    parked: [] as Array<() => void>,
    block: false,
  }
  const requests: Array<["lease", LeaseRequest] | ["report", LeaseReportRequest]> = []

  const balance = () => {
    let held = ZERO
    for (const lease of state.leases.values()) {
      if (lease.status === "open") held += lease.granted - lease.captured
    }
    return { remaining: fromUnits(state.room), held: fromUnits(held), limits: [], asOf: Date.now() }
  }
  const view = (leaseKey: string, lease: ServerLease) => ({
    leaseKey,
    seq: lease.seq,
    granted: fromUnits(lease.granted),
    captured: fromUnits(lease.captured),
    expiresAt: lease.expiresAt,
    status: lease.status,
  })
  const exceeded = (requested: bigint) => ({
    kind: "budget_exceeded" as const,
    blocked: {
      limitId: "month",
      window: "month" as const,
      remaining: fromUnits(state.room),
      held: balance().held,
      resetsAt: 1_793_491_200_000,
      remedy: "wait_for_reset" as const,
    },
    balance: { ...balance(), remaining: fromUnits(state.room - requested) },
  })
  const conflict = (message: string): ApiError => ({
    code: "CONFLICT",
    message,
    docs: "https://docs.unprice.dev/api-reference/errors/code/CONFLICT",
    requestId: "req_conflict",
  })
  const answer = async <T>(apply: () => ApiResult<T>): Promise<ApiResult<T>> => {
    if (state.down) return { error: unreachable }
    const result = apply()
    if (state.lose > 0) {
      state.lose -= 1
      return { error: unreachable }
    }
    return result
  }

  const transport: LeaseTransport = {
    lease: (request) => {
      requests.push(["lease", request])
      return answer(() => {
        const known = state.leases.get(request.leaseKey)
        if (known?.grant) return { result: { ...known.grant, replayed: true } }
        const refusal = state.refusals.get(request.leaseKey)
        if (refusal) return { error: refusal }
        const granted = smaller(units(request.amount), state.room)
        if (granted === ZERO) {
          const error: ApiError = {
            code: "BUDGET_EXCEEDED",
            message: "Limit month has 0 remaining",
            docs: "https://docs.unprice.dev/api-reference/errors/code/BUDGET_EXCEEDED",
            requestId: "req_402",
            details: exceeded(units(request.amount)),
          }
          state.refusals.set(request.leaseKey, error)
          return { error }
        }
        state.room -= granted
        const lease: ServerLease = {
          granted,
          captured: ZERO,
          seq: 0,
          ttlMs: request.ttlMs,
          expiresAt: Date.now() + request.ttlMs,
          status: "open",
          last: null,
        }
        state.leases.set(request.leaseKey, lease)
        lease.grant = {
          lease: view(request.leaseKey, lease),
          terms,
          replayed: false,
          created: false,
          balance: balance(),
        }
        return { result: lease.grant }
      })
    },
    report: async (request) => {
      requests.push(["report", request])
      if (state.block) await new Promise<void>((resolve) => state.parked.push(resolve))
      return answer((): ApiResult<LeaseReportResponse> => {
        const lease = state.leases.get(request.leaseKey)
        if (!lease) {
          return {
            error: {
              code: "NOT_FOUND",
              message: "Lease does not exist",
              docs: "https://docs.unprice.dev/api-reference/errors/code/NOT_FOUND",
              requestId: "req_404",
            },
          }
        }
        if (lease.last && request.seq === lease.last.request.seq) {
          expect(request).toEqual(lease.last.request)
          return { result: { ...lease.last.response, replayed: true } }
        }
        if (lease.status !== "open") return { error: conflict(`Lease is already ${lease.status}`) }
        if (request.seq !== lease.seq + 1) return { error: conflict("Lease seq conflict") }
        const captured = units(request.captured)
        expect(captured >= lease.captured && captured <= lease.granted).toBe(true)
        const now = Date.now()
        lease.captured = captured
        lease.seq = request.seq
        let requested = ZERO
        let extended = ZERO
        let released = ZERO
        if (request.final) {
          released = lease.granted - captured
          state.room += released
          lease.status = "closed"
        } else {
          requested = units(request.extend)
          extended = smaller(requested, state.room)
          state.room -= extended
          lease.granted += extended
          if (lease.expiresAt - now < lease.ttlMs / 2) lease.expiresAt = now + lease.ttlMs
        }
        const response: LeaseReportResponse = {
          lease: view(request.leaseKey, lease),
          terms,
          extension: {
            requested: fromUnits(requested),
            granted: fromUnits(extended),
            ...(extended < requested ? { denied: exceeded(requested) } : {}),
          },
          released: fromUnits(released),
          crossed: [],
          replayed: false,
          balance: balance(),
        }
        lease.last = { request, response }
        return { result: response }
      })
    },
  }

  const release = () => {
    state.block = false
    for (const resume of state.parked.splice(0)) resume()
  }
  const reports = () =>
    requests.flatMap(([path, body]) => (path === "report" ? [body as LeaseReportRequest] : []))
  return { state, requests, reports, transport, release }
}

const remote = createBudgetHandle({} as GeneratedSdkResources["budgets"], "customer:acme")

const createHandle = (
  server: ReturnType<typeof createServer>,
  lease: LocalLeaseOptions,
  settlement: SpendSettlement = {}
) =>
  createLocalLeases({ transport: server.transport, settlement, now: () => Date.now() }).budget(
    remote,
    "customer:acme",
    lease
  )

const statusOf: Partial<Record<ApiError["code"], number>> = {
  BAD_REQUEST: 400,
  BUDGET_EXCEEDED: 402,
  NOT_FOUND: 404,
  CONFLICT: 409,
}

/** A client whose budget routes are answered by the fake server. */
const clientFor = (server: ReturnType<typeof createServer>) =>
  new Unprice({
    token: "test-token",
    baseUrl: "https://example.com",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: async (request) => {
      const body: unknown = await request.json()
      const answer = request.url.endsWith("/lease")
        ? await server.transport.lease(body as LeaseRequest)
        : await server.transport.report(body as LeaseReportRequest)
      if (answer.error?.code === "FETCH_ERROR") throw new TypeError(answer.error.message)
      return new Response(JSON.stringify(answer.error ? { error: answer.error } : answer.result), {
        status: answer.error ? (statusOf[answer.error.code] ?? 500) : 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

const progress = (server: ReturnType<typeof createServer>) =>
  server.reports().map(({ seq, captured, final }) => [seq, captured, final])

const allowedHold = async (handle: BudgetHandle, amount: string, idempotencyKey: string) => {
  const authorized = await handle.authorize({ amount, idempotencyKey })
  if (!authorized.result?.allowed) throw new Error(`expected ${idempotencyKey} to be allowed`)
  return authorized.result.hold
}

describe("local budget handle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_792_000_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("exposes current local capacity after a denied extension without changing global balances", async () => {
    const server = createServer("1")
    const local = createHandle(server, {
      amount: "1",
      lowWater: "0",
      idleMs: Number.POSITIVE_INFINITY,
    })
    expect(local.spendableAmount).toBeUndefined()
    const hold = await allowedHold(local, "0.8", "warm")
    expect(local.spendableAmount).toBe("0.2")
    await hold.settle({ amount: "0.6" })
    expect(local.spendableAmount).toBe("0.4")
    const denied = await local.authorize({ amount: "0.5", idempotencyKey: "large" })
    expect(denied.result?.allowed).toBe(false)
    expect(denied.result?.balance?.remaining).toBe("-0.6")
    expect(local.spendableAmount).toBe("0.4")
    expect((await allowedHold(local, "0.3", "small")).amount).toBe("0.3")
    expect(local.spendableAmount).toBe("0.1")
    await local.close()
    expect(local.spendableAmount).toBeUndefined()
  })

  it("authorizes and settles from memory once the lease is granted", async () => {
    const server = createServer("100")
    const local = createHandle(server, { amount: "10" })
    await allowedHold(local, "0.01", "warm").then((hold) => hold.settle({ amount: "0.01" }))
    server.state.block = true

    for (let i = 0; i < 50; i++) {
      const hold = await allowedHold(local, "0.05", `step_${i}`)
      expect(await hold.settle({ amount: "0.02" })).toMatchObject({
        result: {
          holdId: hold.id,
          actual: "0.02",
          released: "0.03",
          expired: false,
          replayed: false,
        },
      })
    }

    expect(server.requests.map(([path]) => path)).toEqual(["lease"])
    expect(server.requests[0]?.[1]).toEqual({
      key: "customer:acme",
      leaseKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      amount: "10",
      ttlMs: 60_000,
    })
  })

  it("refills in the background below low water without waiting", async () => {
    const server = createServer("100")
    const local = createHandle(server, { amount: "1", lowWater: "0.25" })
    server.state.block = true

    const hold = await allowedHold(local, "0.8", "big")

    expect(hold.amount).toBe("0.8")
    expect(server.reports()).toEqual([
      {
        key: "customer:acme",
        leaseKey: expect.any(String),
        seq: 1,
        captured: "0",
        final: false,
        extend: "0.8",
      },
    ])
    server.release()
    const charged = await local.charge({ amount: "0.7", idempotencyKey: "after_refill" })
    expect(charged).toMatchObject({ result: { allowed: true, amount: "0.7", replayed: false } })
    expect(server.requests.map(([path]) => path)).toEqual(["lease", "report"])
  })

  it("refills synchronously when a request does not fit, then denies when the budget is out", async () => {
    const server = createServer("1.5")
    const local = createHandle(server, { amount: "1", lowWater: "0" })
    await allowedHold(local, "0.9", "first")

    const second = await local.authorize({ amount: "0.5", idempotencyKey: "second" })
    expect(second.result).toMatchObject({ allowed: true, hold: { amount: "0.5" } })
    expect(server.reports()).toEqual([
      {
        key: "customer:acme",
        leaseKey: expect.any(String),
        seq: 1,
        captured: "0",
        final: false,
        extend: "0.9",
      },
    ])

    const third = await local.authorize({ amount: "0.3", idempotencyKey: "third" })
    expect(third).toEqual({
      result: {
        allowed: false,
        degraded: false,
        blocked: {
          reason: "limit",
          limitId: "month",
          window: "month",
          remaining: "0",
          held: "1.5",
          resetsAt: 1_793_491_200_000,
          remedy: "wait_for_reset",
        },
        balance: expect.objectContaining({ held: "1.5" }),
      },
    })
    expect(
      server.reports().map(({ seq, extend }: { seq: number; extend?: string }) => [seq, extend])
    ).toEqual([
      [1, "0.9"],
      [2, "0.9"],
    ])
  })

  it("closes with open holds counted in full and returns the rest", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })
    const open = await allowedHold(local, "0.3", "open")
    const settled = await allowedHold(local, "0.2", "settled")
    await settled.settle({ amount: "0.05" })
    await local.charge({ amount: "0.1", idempotencyKey: "charge" })

    const closed = await local.close()

    expect(server.reports()).toEqual([
      { key: "customer:acme", leaseKey: expect.any(String), seq: 1, captured: "0.45", final: true },
    ])
    expect(closed.result).toMatchObject({
      released: "0.55",
      lease: { status: "closed", captured: "0.45" },
    })
    expect(server.state.room).toBe(units("9.55"))
    expect(await open.settle({ amount: "0.1" })).toMatchObject({
      error: {
        code: "CONFLICT",
        message: `Hold ${open.id} expired and was settled at its full amount`,
      },
    })
    expect(await open.settle({ amount: "0.3" })).toMatchObject({
      result: { actual: "0.3", expired: true, replayed: true },
    })
    expect(await local.close()).toEqual({ result: null })

    await allowedHold(local, "0.1", "next")
    const leaseKeys = server.requests.flatMap(([path, body]) =>
      path === "lease" ? [body.leaseKey] : []
    )
    expect(new Set(leaseKeys).size).toBe(2)
  })

  it("resends a report whose answer was lost exactly as frozen", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })
    await local.charge({ amount: "0.2", idempotencyKey: "c1" })
    server.state.lose = 1

    expect(await local.flush()).toEqual({ error: unreachable })
    await local.charge({ amount: "0.3", idempotencyKey: "c2" })
    const retried = await local.flush()
    const next = await local.flush()

    expect(retried.result).toMatchObject({ replayed: true, lease: { seq: 1, captured: "0.2" } })
    expect(next.result).toMatchObject({ replayed: false, lease: { seq: 2, captured: "0.5" } })
    expect(server.reports().map(({ seq, captured }) => [seq, captured])).toEqual([
      [1, "0.2"],
      [1, "0.2"],
      [2, "0.5"],
    ])
  })

  it("denies as degraded past the local deadline without an answer", async () => {
    const server = createServer("10")
    const onError = vi.fn()
    const local = createHandle(server, { amount: "1", onError })
    await allowedHold(local, "0.1", "before")
    server.state.down = true

    await vi.advanceTimersByTimeAsync(60_000)
    const late = await local.authorize({ amount: "0.1", idempotencyKey: "after" })

    expect(late).toEqual({
      result: {
        allowed: false,
        degraded: true,
        blocked: { reason: "unavailable", remedy: "retry", error: unreachable },
        balance: null,
      },
    })
    expect(onError).toHaveBeenCalledWith(unreachable)
    server.state.down = false
    expect(await local.authorize({ amount: "0.1", idempotencyKey: "after" })).toMatchObject({
      result: { allowed: true },
    })
  })

  it("replays a grant whose answer was lost under the same lease key", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })
    server.state.lose = 1

    const lost = await local.authorize({ amount: "0.1", idempotencyKey: "a" })
    const retried = await local.authorize({ amount: "0.1", idempotencyKey: "a" })

    expect(lost.result).toMatchObject({ allowed: false, degraded: true })
    expect(retried.result).toMatchObject({ allowed: true, replayed: false })
    const [first, second] = server.requests
    expect(second).toEqual(first)
    expect(server.state.leases.size).toBe(1)
  })

  it("answers a refused key's calls from memory for a flush interval, then asks again", async () => {
    const server = createServer("0")
    const local = createHandle(server, { amount: "1" })

    const denied = await local.authorize({ amount: "0.1", idempotencyKey: "a" })
    expect(denied.result).toMatchObject({ allowed: false, blocked: { reason: "limit" } })
    server.state.room = units("10")
    await vi.advanceTimersByTimeAsync(999)
    expect(await local.charge({ amount: "0.1", idempotencyKey: "b" })).toEqual(denied)
    expect(server.requests).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(await local.authorize({ amount: "0.1", idempotencyKey: "a" })).toMatchObject({
      result: { allowed: true },
    })
    const leaseKeys = server.requests.map(([, body]) => body.leaseKey)
    expect(new Set(leaseKeys).size).toBe(2)
  })

  it("closes a refused key without asking the server again", async () => {
    const server = createServer("0")
    const local = createHandle(server, { amount: "1" })

    await local.authorize({ amount: "0.1", idempotencyKey: "a" })

    expect(await local.close()).toEqual({ result: null })
    expect(server.requests).toHaveLength(1)
  })

  it("keeps a refusal whose answer was lost, even once room returns", async () => {
    const server = createServer("0")
    const local = createHandle(server, { amount: "1" })
    server.state.lose = 1

    const lost = await local.authorize({ amount: "0.1", idempotencyKey: "a" })
    server.state.room = units("10")
    const replayed = await local.authorize({ amount: "0.1", idempotencyKey: "a" })
    await vi.advanceTimersByTimeAsync(1_000)
    const fresh = await local.authorize({ amount: "0.1", idempotencyKey: "a" })

    expect(lost.result).toMatchObject({ allowed: false, degraded: true })
    expect(replayed.result).toMatchObject({ allowed: false, degraded: false })
    expect(fresh.result).toMatchObject({ allowed: true })
    const [first, second, third] = server.requests
    expect(second).toEqual(first)
    expect(third?.[1].leaseKey).not.toBe(first?.[1].leaseKey)
  })

  it("refuses a ttlMs of three flush intervals or less, and renews one just over at the third tick", async () => {
    const server = createServer("10")

    expect(() =>
      createHandle(server, { amount: "1", ttlMs: 1_001, flushIntervalMs: 2_000 })
    ).toThrow(
      new RangeError(
        "lease.ttlMs must exceed 3 × lease.flushIntervalMs, received ttlMs 1001 and flushIntervalMs 2000"
      )
    )
    expect(() => createHandle(server, { amount: "1", ttlMs: 3_000 })).toThrow(
      new RangeError(
        "lease.ttlMs must exceed 3 × lease.flushIntervalMs, received ttlMs 3000 and flushIntervalMs 1000"
      )
    )
    const local = createHandle(server, { amount: "1", ttlMs: 3_001 })
    await allowedHold(local, "0.1", "running")
    const grantedAt = Date.now()

    await vi.advanceTimersByTimeAsync(3_000)
    const [lease] = server.state.leases.values()
    expect(lease?.expiresAt).toBe(grantedAt + 3_000 + 3_001)
  })

  it("reports changed consumption each flush interval and renews before the last third", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1", idleMs: Number.POSITIVE_INFINITY })
    await local.charge({ amount: "0.1", idempotencyKey: "c1" })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.reports().map(({ seq, captured }) => [seq, captured])).toEqual([[1, "0.1"]])

    await vi.advanceTimersByTimeAsync(39_000)
    expect(server.reports()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(server.reports().map(({ seq, captured }) => [seq, captured])).toEqual([
      [1, "0.1"],
      [2, "0.1"],
    ])
    const [lease] = server.state.leases.values()
    expect(lease?.expiresAt).toBe(Date.now() - 1_000 + 60_000)
  })

  it("returns an idle lease, and the next call takes a new one", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })
    await local.spend({ estimate: "0.2" }, async () => ({ value: "done", actual: "0.15" }))

    await vi.advanceTimersByTimeAsync(9_000)
    expect(progress(server)).toEqual([[1, "0.15", false]])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(progress(server)).toEqual([
      [1, "0.15", false],
      [2, "0.15", true],
    ])
    expect(server.state.room).toBe(units("9.85"))

    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.reports()).toHaveLength(2)
    await allowedHold(local, "0.1", "next")
    expect(server.requests.map(([path]) => path)).toEqual(["lease", "report", "report", "lease"])
  })

  it("keeps a lease with an open hold however long it idles", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })
    const hold = await allowedHold(local, "0.2", "running")

    await vi.advanceTimersByTimeAsync(30_000)
    expect(server.reports()).toEqual([])

    await hold.settle({ amount: "0.1" })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(progress(server)).toEqual([
      [1, "0.1", false],
      [2, "0.1", true],
    ])
  })

  it("resends an idle lease's final report whose answer was lost", async () => {
    const server = createServer("10")
    const onError = vi.fn()
    const local = createHandle(server, { amount: "1", onError })
    await local.charge({ amount: "0.3", idempotencyKey: "c1" })
    await vi.advanceTimersByTimeAsync(1_000)
    server.state.lose = 1

    await vi.advanceTimersByTimeAsync(9_000)
    expect(onError).toHaveBeenCalledWith(unreachable)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(progress(server)).toEqual([
      [1, "0.3", false],
      [2, "0.3", true],
      [2, "0.3", true],
    ])
    expect(server.state.room).toBe(units("9.7"))
  })

  it("refuses an idleMs that is not positive", () => {
    const server = createServer("10")

    expect(() => createHandle(server, { amount: "1", idleMs: 0 })).toThrow(
      new RangeError("lease.idleMs must be positive, received 0")
    )
    expect(() => createHandle(server, { amount: "1", idleMs: Number.NaN })).toThrow(
      new RangeError("lease.idleMs must be positive, received NaN")
    )
  })

  it("opens a new lease after the server refuses a report", async () => {
    const server = createServer("10")
    const onError = vi.fn()
    const local = createHandle(server, { amount: "1", onError })
    const hold = await allowedHold(local, "0.2", "a")
    for (const lease of server.state.leases.values()) lease.status = "expired"

    expect(await local.flush()).toEqual({ result: null })
    await local.charge({ amount: "0.1", idempotencyKey: "c" })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "CONFLICT" }))

    expect(await local.authorize({ amount: "0.1", idempotencyKey: "b" })).toMatchObject({
      result: { allowed: true },
    })
    expect(await hold.settle({ amount: "0.1" })).toMatchObject({ error: { code: "CONFLICT" } })
    expect(server.requests.map(([path]) => path)).toEqual(["lease", "report", "lease"])
  })

  it("runs spend against the lease and shares the remote contract", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })

    const value = await local.spend({ estimate: "0.2" }, async (hold) => ({
      value: `ran under ${hold.amount}`,
      actual: "0.15",
    }))
    await local.close()

    expect(value).toBe("ran under 0.2")
    expect(server.reports().map(({ captured, final }) => [captured, final])).toEqual([
      ["0.15", true],
    ])
  })

  it("settles spend in memory through the client's waitUntil", async () => {
    const server = createServer("10")
    const background: Array<Promise<unknown>> = []
    const local = createHandle(
      server,
      { amount: "1" },
      { waitUntil: (promise) => void background.push(promise) }
    )

    const value = await local.spend({ estimate: "0.2" }, async () => ({
      value: "done",
      actual: "0.15",
    }))

    expect(value).toBe("done")
    await expect(Promise.all(background)).resolves.toEqual([undefined])
    await local.close()
    expect(progress(server)).toEqual([[1, "0.15", true]])
  })

  it("refuses a malformed amount the way the API does", async () => {
    const server = createServer("10")
    const local = createHandle(server, { amount: "1" })

    expect(await local.charge({ amount: "0.123456789", idempotencyKey: "x" })).toMatchObject({
      error: { code: "BAD_REQUEST" },
    })
    expect(server.requests).toEqual([])
  })
})

describe("Unprice.budget local mode", () => {
  it("posts the lease and its final report to the API", async () => {
    const bodies: Array<[string, unknown]> = []
    const view = (leaseKey: string, captured: string, status: "open" | "closed") => ({
      leaseKey,
      seq: status === "open" ? 0 : 1,
      granted: "1",
      captured,
      expiresAt: 1_792_000_060_000,
      status,
    })
    const balance = { remaining: "9", held: "1", limits: [], asOf: 1_792_000_000_000 }
    const client = new Unprice({
      token: "test-token",
      baseUrl: "https://example.com",
      disableTelemetry: true,
      retry: { attempts: 0 },
      fetch: async (request) => {
        const body = (await request.json()) as { leaseKey: string; captured?: string }
        bodies.push([request.url, body])
        const answer: LeaseResponse | LeaseReportResponse = request.url.endsWith("/lease")
          ? {
              lease: view(body.leaseKey, "0", "open"),
              terms,
              replayed: false,
              created: false,
              balance,
            }
          : {
              lease: view(body.leaseKey, body.captured ?? "0", "closed"),
              terms,
              extension: { requested: "0", granted: "0" },
              released: "0.95",
              crossed: [],
              replayed: false,
              balance,
            }
        return new Response(JSON.stringify(answer), {
          headers: { "content-type": "application/json" },
        })
      },
    })
    const local = client.budget("customer:acme", { mode: "local", lease: { amount: "1" } })

    const authorized = await local.authorize({ amount: "0.05", idempotencyKey: "msg_1" })
    const closed = await local.close()

    expectTypeOf(client.budget("customer:acme")).toEqualTypeOf<BudgetHandle>()
    expectTypeOf(local).toEqualTypeOf<LocalBudgetHandle>()
    expect(local.mode).toBe("local")
    expect(authorized.result).toMatchObject({ allowed: true, hold: { amount: "0.05" } })
    expect(closed.result).toMatchObject({ released: "0.95" })
    expect(bodies).toEqual([
      [
        "https://example.com/v1/budgets/lease",
        { key: "customer:acme", leaseKey: expect.any(String), amount: "1", ttlMs: 60_000 },
      ],
      [
        "https://example.com/v1/budgets/report",
        {
          key: "customer:acme",
          leaseKey: expect.any(String),
          seq: 1,
          captured: "0.05",
          final: true,
        },
      ],
    ])
  })
})

describe("Unprice local leases", () => {
  const local = { mode: "local", lease: { amount: "5" } } as const

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_792_000_000_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens one lease per key however many handles spend from it", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)

    const authorized = await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        unprice
          .budget("customer:acme", local)
          .authorize({ amount: "0.001", idempotencyKey: `req_${i}` })
      )
    )

    expect(authorized.filter(({ result }) => result?.allowed)).toHaveLength(1_000)
    expect(server.requests.map(([path]) => path)).toEqual(["lease"])
  })

  it("refuses other lease options while the key's lease is open", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)
    await unprice.budget("customer:acme", local).charge({ amount: "0.5", idempotencyKey: "c1" })

    expect(() =>
      unprice.budget("customer:acme", { mode: "local", lease: { amount: "10" } })
    ).toThrow(
      new RangeError("Budget customer:acme already has an open local lease with other options")
    )
    expect(
      unprice.budget("customer:acme", { mode: "local", lease: { amount: "5", idleMs: 10_000 } }).key
    ).toBe("customer:acme")
  })

  it("forgets a key once its lease is returned", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)
    await unprice.budget("customer:acme", local).charge({ amount: "0.5", idempotencyKey: "c1" })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(progress(server)).toEqual([
      [1, "0.5", false],
      [2, "0.5", true],
    ])
    const larger = unprice.budget("customer:acme", { mode: "local", lease: { amount: "10" } })
    await larger.charge({ amount: "0.1", idempotencyKey: "c2" })

    const amounts = server.requests.flatMap(([path, body]) =>
      path === "lease" ? [(body as LeaseRequest).amount] : []
    )
    expect(amounts).toEqual(["5", "10"])
  })

  it("lets a kept handle open the key's next lease, shared with new handles", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)
    const kept = unprice.budget("customer:acme", local)
    await kept.charge({ amount: "0.5", idempotencyKey: "c1" })
    await vi.advanceTimersByTimeAsync(10_000)

    const charged = await Promise.all([
      kept.charge({ amount: "0.1", idempotencyKey: "c2" }),
      unprice.budget("customer:acme", local).charge({ amount: "0.1", idempotencyKey: "c3" }),
    ])

    expect(charged.map(({ result }) => result?.allowed)).toEqual([true, true])
    expect(server.requests.map(([path]) => path)).toEqual(["lease", "report", "report", "lease"])
  })

  it("closes every open lease with one final report per key", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)
    const keys = ["customer:acme", "customer:globex", "run:r_42"]
    for (const key of keys) {
      await unprice.budget(key, local).charge({ amount: "0.25", idempotencyKey: `c_${key}` })
    }

    expect(await unprice.close()).toEqual([])

    const finals = server
      .reports()
      .map(({ key, captured, final }) => [key, captured, final])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
    expect(finals).toEqual([
      ["customer:acme", "0.25", true],
      ["customer:globex", "0.25", true],
      ["run:r_42", "0.25", true],
    ])
    expect(server.state.room).toBe(units("99.25"))
    expect(unprice.budget("run:r_42", { mode: "local", lease: { amount: "1" } }).key).toBe(
      "run:r_42"
    )
  })

  it("resolves close with the keys whose lease was not returned", async () => {
    const server = createServer("100")
    const unprice = clientFor(server)
    await unprice.budget("customer:acme", local).charge({ amount: "0.25", idempotencyKey: "c1" })
    server.state.down = true

    expect(await unprice.close()).toEqual([{ key: "customer:acme", error: unreachable }])
  })
})
