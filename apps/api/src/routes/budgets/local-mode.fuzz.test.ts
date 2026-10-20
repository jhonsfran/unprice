import { OpenAPIHono } from "@hono/zod-openapi"
import { type BudgetHold, type LocalBudgetHandle, Unprice } from "@unprice/budgets"
import {
  type BudgetRecord,
  type BudgetRejection,
  type Ledger,
  type Operation,
  type ReservationOperation,
  type WindowPeriod,
  alarmAt,
  dueAt,
  emptyLedger,
} from "@unprice/services/budgets"
import type { BudgetReply, BudgetRequest } from "@unprice/services/use-cases"
import * as fc from "fast-check"
import type { ExecutionContext } from "hono"
import { timing } from "hono/timing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { handleError, handleZodError } from "~/errors"
import type { HonoEnv } from "~/hono/env"
import type { BudgetStore, BudgetStoreTx, Sync } from "~/ingestion/budget/ports"
import { ALARM_CONTINUE_MS, BudgetProcessor } from "~/ingestion/budget/processor"
import { registerAuthorizeBudgetV1 } from "./authorizeBudgetV1"
import { registerChargeBudgetV1 } from "./chargeBudgetV1"
import { registerGetBudgetV1 } from "./getBudgetV1"
import { registerLeaseBudgetV1 } from "./leaseBudgetV1"
import { registerRecordBudgetV1 } from "./recordBudgetV1"
import { registerReleaseBudgetV1 } from "./releaseBudgetV1"
import { registerReportBudgetV1 } from "./reportBudgetV1"
import { registerSettleBudgetV1 } from "./settleBudgetV1"
import { registerUpsertBudgetV1 } from "./upsertBudgetV1"

/**
 * The SDK's local mode against the real budget: each client's requests go through the Hono routes,
 * the wire mapping, and the budget core over an in-memory store, through a network that loses,
 * repeats, and delays requests. Time is one fake clock for the SDK's timers, the server, and the
 * Durable Object alarm.
 */

const runs = Number.parseInt(process.env.FUZZ_RUNS ?? "200", 10)
const seed = process.env.FUZZ_SEED ? Number.parseInt(process.env.FUZZ_SEED, 10) : undefined
const timeoutMs = Math.max(120_000, runs * 50)

// A plain function, not vi.fn(): a mock would keep every request's context, and with it every run.
vi.mock("~/auth/key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/auth/key")>()),
  keyAuth: async () => ({ id: "key_1", projectId: "proj_fuzz", type: "config" }),
}))

const KEY = "customer:fuzz"
// A minute before an hour rolls, so the hourly limit resets inside many runs.
const START = Date.parse("2026-10-14T09:59:00.000Z")
const HOUR = 3_600_000
const ZERO = BigInt(0)
const ONE = BigInt(100_000_000)
const CENT = BigInt(1_000_000)

const cents = (n: number) => BigInt(n) * CENT
const decimal = (n: number) => (n / 100).toFixed(2)
const units = (text: string) => {
  const [whole = "0", fraction = ""] = text.split(".")
  return BigInt(whole) * ONE + BigInt(fraction.padEnd(8, "0"))
}
// workers-types gives a clone other `cf` generics; at runtime it is the same Request.
const copyOf = (request: Request) => request.clone() as Request
const sum = (amounts: bigint[]) => amounts.reduce((a, b) => a + b, ZERO)
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
// Every request, alarm, and SDK reaction is a promise chain without real I/O, so one macrotask
// boundary drains it; the extra turns are slack.
const quiesce = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * BudgetSqliteStore's contract in memory: rows are copied in and out like SQLite rows, and a
 * transaction that throws writes nothing. It also keeps what each lease had reported when the
 * alarm expired it.
 */
class MemoryBudgetStore implements BudgetStore {
  budget: BudgetRecord | null = null
  ledger: Ledger = emptyLedger
  rows = new Map<string, Operation>()
  history: WindowPeriod[] = []
  expired = new Map<string, { granted: bigint; reported: bigint }>()

  atomically<T>(fn: (tx: BudgetStoreTx) => Sync<T>): T {
    const { budget, ledger, history } = this
    const rows = new Map(this.rows)
    const expired = new Map(this.expired)
    try {
      return fn(this.tx)
    } catch (error) {
      Object.assign(this, { budget, ledger, rows, history, expired })
      throw error
    }
  }

  leases() {
    return [...this.rows.values()].flatMap((row) => (row.kind === "lease" ? [row] : []))
  }

  private readonly tx: BudgetStoreTx = {
    readBudget: () => structuredClone(this.budget),
    readLedger: () => structuredClone(this.ledger),
    readOperation: (id) => structuredClone(this.rows.get(id) ?? null),
    readOperationByKey: (key) =>
      structuredClone(
        [...this.rows.values()].find((row) => row.kind !== "lease" && row.idempotencyKey === key) ??
          null
      ),
    readLease: (leaseKey) => {
      const row = this.rows.get(`l:${leaseKey}`)
      return row?.kind === "lease" ? structuredClone(row) : null
    },
    readHistory: (windowIds, limit) =>
      windowIds.flatMap((id) =>
        this.history
          .filter((period) => period.windowId === id)
          .sort((a, b) => b.start - a.start)
          .slice(0, limit)
      ),
    readExpired: (now, limit) =>
      [...this.rows.values()]
        .filter(
          (row): row is ReservationOperation =>
            (row.kind === "hold" || row.kind === "lease") &&
            row.state.status === "open" &&
            row.expiresAt <= now
        )
        .sort(
          (a, b) => a.expiresAt - b.expiresAt || a.id.length - b.id.length || (a.id < b.id ? -1 : 1)
        )
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    commit: ({ budget, ledger, purged, operations, periods, retiredWindows }) => {
      if (budget) this.budget = structuredClone(budget)
      this.ledger = structuredClone(ledger)
      this.history = [
        ...periods,
        ...this.history.filter((period) => !retiredWindows.includes(period.windowId)),
      ]
      for (const row of purged) this.rows.delete(row.id)
      for (const row of operations) {
        const prior = this.rows.get(row.id)
        if (row.kind === "lease" && row.state.status === "expired" && prior?.kind === "lease") {
          this.expired.set(row.leaseKey, { granted: row.granted, reported: prior.captured })
        }
        this.rows.set(row.id, structuredClone(row))
      }
    },
    purgeOperations: (now, limit) => {
      const due = [...this.rows.values()]
        .map((row) => ({ row, at: dueAt(row) }))
        .filter(({ at }) => at !== null && at <= now)
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
        .slice(0, limit)
      for (const { row } of due) this.rows.delete(row.id)
    },
    nextDueAt: () => {
      const due = [...this.rows.values()].map(alarmAt)
      return due.length === 0 ? null : Math.min(...due)
    },
  }
}

/** Who sent a request, and whether it is a stray copy whose answer nobody reads. */
type Delivery = { actor: number | null; copy: boolean }

/** The budget's Durable Object: the real processor, with RPC copies and alarms on the fake clock. */
function createBudgetObject(
  onReply: (reply: BudgetReply, delivery: Delivery, request: BudgetRequest) => void
) {
  const store = new MemoryBudgetStore()
  const failures: string[] = []
  let alarm: { at: number; timer: ReturnType<typeof setTimeout> } | null = null
  const processor: BudgetProcessor = new BudgetProcessor({
    clock: { now: () => Date.now() },
    logger: { error: (message, fields) => failures.push(`${message}: ${String(fields.error)}`) },
    runtime: {
      destroy: async () => {
        failures.push("the budget deleted itself")
      },
    },
    scheduler: {
      getAlarm: async () => alarm?.at ?? null,
      setAlarm: async (at) => {
        if (alarm) clearTimeout(alarm.timer)
        const timer = setTimeout(
          () => {
            alarm = null
            processor.alarm().catch((error) => failures.push(`alarm threw: ${messageOf(error)}`))
          },
          Math.max(0, at - Date.now())
        )
        alarm = { at, timer }
      },
    },
    store,
  })

  const execute = async (request: BudgetRequest, delivery: Delivery): Promise<BudgetReply> => {
    try {
      const reply = structuredClone(await processor.execute(structuredClone(request)))
      onReply(reply, delivery, request)
      return reply
    } catch (error) {
      failures.push(`${request.type} threw: ${messageOf(error)}`)
      throw error
    }
  }
  return { store, failures, execute }
}

function createApp() {
  const app = new OpenAPIHono<HonoEnv>({ defaultHook: handleZodError })
  app.onError(handleError)
  app.use(timing())
  app.use("*", async (c, next) => {
    c.set("requestId", "req_fuzz")
    c.set("logger", { set: () => undefined } as unknown as HonoEnv["Variables"]["logger"])
    c.set("services", {
      budgetCatalog: { record: async () => undefined },
    } as unknown as HonoEnv["Variables"]["services"])
    c.set("waitUntil", () => undefined)
    await next()
  })
  for (const register of [
    registerUpsertBudgetV1,
    registerAuthorizeBudgetV1,
    registerSettleBudgetV1,
    registerReleaseBudgetV1,
    registerChargeBudgetV1,
    registerRecordBudgetV1,
    registerGetBudgetV1,
    registerLeaseBudgetV1,
    registerReportBudgetV1,
  ]) {
    register(app)
  }
  return app
}

const executionContext = {
  passThroughOnException: () => {},
  waitUntil: () => {},
} as unknown as ExecutionContext

/**
 * `lose`: the request never reaches the server. `drop`: the server applies it and the answer is
 * lost. `twice`: the server gets it twice in a row and the client reads the second answer.
 * `delay`: it reaches the server, and its answer the client, that many steps later. `echo`: it is
 * delivered, and a copy reaches the server that many steps later.
 */
type Fault = "lose" | "drop" | "twice" | { delay: number } | { echo: number }

type Command =
  | { kind: "authorize"; actor: number; cents: number; ttlMs: number | undefined }
  | { kind: "settle"; actor: number; pick: number; percent: number }
  | { kind: "release"; actor: number; pick: number }
  | { kind: "charge"; actor: number; cents: number }
  | { kind: "flush"; actor: number }
  | { kind: "close"; actor: number }
  | { kind: "crash"; actor: number }
  | { kind: "advance"; ms: number }

type LeaseOptions = {
  amount: number
  lowWater: number | undefined
  ttlMs: number
  flushIntervalMs: number
  idleMs: number
}

type Scenario = {
  limits: { never: number; hour: number | undefined }
  leases: LeaseOptions[]
  mayCrash: boolean
  steps: Array<{ command: Command; faults: Fault[] }>
}

/** `disturbed` is the client's count when the authorize was called, or -1 while a close ran. */
type ModelHold = { hold: BudgetHold; cents: number; disturbed: number }

type Client = {
  readonly id: number
  crashed: boolean
  /** Bumped when the client closes or the server refuses its lease: open holds may close in full. */
  disturbed: number
  /** Closes in flight. */
  closing: number
  /** Allowed holds the test has not settled or released yet. */
  holds: ModelHold[]
  calls: number
  pending: Set<Promise<void>>
}

type Actor = Client & { unprice: Unprice; handle: LocalBudgetHandle }

type Parked = {
  request: Request
  actor: Client
  at: number
  answer: ((r: Response) => void) | null
}

async function runScenario(scenario: Scenario) {
  const failures: string[] = []
  let faults: Fault[] = []
  let step = 0
  const parked: Parked[] = []
  const actors: Actor[] = []
  /** Settled actuals and allowed charges, as the clients reported them. */
  let confirmed = ZERO
  /** Holds the clients report closed at their full amount: expired, or open when a lease ended. */
  let full = ZERO
  /** Which client asked for each lease key, and the keys whose lease reached that client. */
  const owners = new Map<string, number>()
  const heard = new Set<string>()

  const object = createBudgetObject((reply, { actor, copy }, request) => {
    if (request.type === "lease" && actor !== null) owners.set(request.leaseKey, actor)
    if (reply.ok) return
    const { rejection } = reply
    if (rejection.code === "LEASE_CLOSED" && actor !== null) {
      const sender = actors[actor]
      if (sender) sender.disturbed += 1
    }
    // A live client is only ever refused for a full budget or a lease that expired.
    if (!copy && !expectedRefusal(rejection)) failures.push(`refused: ${JSON.stringify(rejection)}`)
  })
  const app = createApp()

  const deliver = async (request: Request, delivery: Delivery) => {
    const path = new URL(request.url).pathname
    const response = await app.fetch(
      request,
      {
        APP_ENV: "development",
        budget: {
          getByName: () => ({
            execute: (command: BudgetRequest) => object.execute(command, delivery),
          }),
        },
      },
      executionContext
    )
    if (response.status === 400) failures.push(`${path} 400: ${await response.clone().text()}`)
    return response
  }

  /** An answer that reaches its client: a lease in it is one the client holds. */
  const hear = async (response: Response) => {
    if (response.ok) {
      const body = (await response.clone().json()) as { lease?: { leaseKey: string } }
      if (body.lease) heard.add(body.lease.leaseKey)
    }
    return response
  }

  const send = async (actor: Client, request: Request): Promise<Response> => {
    // A crashed process never hears back.
    if (actor.crashed) return new Promise<Response>(() => {})
    const delivery = { actor: actor.id, copy: false }
    const fault = faults.shift()
    if (fault === undefined) return hear(await deliver(request, delivery))
    if (fault === "lose") throw new TypeError("fetch failed")
    if (fault === "drop") {
      await deliver(request, delivery)
      throw new TypeError("fetch failed")
    }
    if (fault === "twice") {
      const copy = copyOf(request)
      await deliver(request, delivery)
      return hear(await deliver(copy, delivery))
    }
    if ("delay" in fault) {
      return new Promise<Response>((answer) => {
        parked.push({ request, actor, at: step + fault.delay, answer })
      })
    }
    parked.push({ request: copyOf(request), actor, at: step + fault.echo, answer: null })
    return hear(await deliver(request, delivery))
  }

  const releaseParked = async (all: boolean) => {
    const due = parked.filter((item) => all || item.at <= step)
    for (const item of due) {
      parked.splice(parked.indexOf(item), 1)
      const response = await deliver(item.request, { actor: item.actor.id, copy: !item.answer })
      if (item.answer && !item.actor.crashed) item.answer(await hear(response))
    }
    await quiesce()
  }

  // A fake timer at the target, so every SDK interval and alarm before it fires at its own time.
  const advance = async (ms: number) => {
    let reached = false
    setTimeout(() => {
      reached = true
    }, ms)
    while (!reached) {
      vi.advanceTimersToNextTimer()
      await quiesce()
    }
  }

  const run = (actor: Client, work: () => Promise<void>) => {
    const done = work().catch((error) => {
      failures.push(`client ${actor.id}: ${messageOf(error)}`)
    })
    actor.pending.add(done)
    void done.finally(() => actor.pending.delete(done))
  }

  /** The client says the hold closed at its full amount: only its TTL, a close, or a lost lease can. */
  const closedInFull = (actor: Client, held: ModelHold) => {
    if (Date.now() < held.hold.expiresAt && actor.disturbed === held.disturbed) {
      failures.push(`hold ${held.hold.id} closed in full under its live client`)
    }
    full += cents(held.cents)
  }

  const pickHold = (actor: Actor, pick: number) =>
    actor.holds.length === 0 ? undefined : actor.holds.splice(pick % actor.holds.length, 1)[0]

  /** Hard limits whose consumed + held passed their amount, read from the server's ledger. */
  const overLimit = () => {
    const { usage, held } = object.store.ledger
    const now = Date.now()
    const hour = usage.hour.start === now - (now % HOUR) ? usage.hour.consumed : ZERO
    const over: string[] = []
    if (usage.never.consumed + held > cents(scenario.limits.never)) {
      over.push(`never: ${usage.never.consumed} consumed, ${held} held`)
    }
    if (scenario.limits.hour !== undefined && hour + held > cents(scenario.limits.hour)) {
      over.push(`hour: ${hour} consumed, ${held} held`)
    }
    return over
  }

  const execute = async (command: Command) => {
    if (command.kind === "advance") return advance(command.ms)
    const actor = actors[command.actor % actors.length]
    if (!actor || actor.crashed) return
    switch (command.kind) {
      case "authorize": {
        const { ttlMs } = command
        const idempotencyKey = `${actor.id}:${++actor.calls}`
        const disturbed = actor.closing > 0 ? -1 : actor.disturbed
        return run(actor, async () => {
          const authorized = await actor.handle.authorize({
            amount: decimal(command.cents),
            idempotencyKey,
            ...(ttlMs === undefined ? {} : { ttlMs }),
          })
          if (actor.crashed) return
          if (authorized.error) {
            failures.push(`authorize ${idempotencyKey}: ${authorized.error.code}`)
            return
          }
          if (!authorized.result.allowed) return
          const { hold, replayed } = authorized.result
          expect([units(hold.amount), replayed]).toEqual([cents(command.cents), false])
          actor.holds.push({ hold, cents: command.cents, disturbed })
        })
      }
      case "charge": {
        const idempotencyKey = `${actor.id}:${++actor.calls}`
        return run(actor, async () => {
          const charged = await actor.handle.charge({
            amount: decimal(command.cents),
            idempotencyKey,
          })
          if (actor.crashed) return
          if (charged.error) {
            failures.push(`charge ${idempotencyKey}: ${charged.error.code}`)
            return
          }
          if (!charged.result.allowed) return
          expect([units(charged.result.amount), charged.result.replayed]).toEqual([
            cents(command.cents),
            false,
          ])
          confirmed += cents(command.cents)
        })
      }
      case "settle": {
        const held = pickHold(actor, command.pick)
        if (!held) return
        const actual = Math.floor((held.cents * command.percent) / 100)
        return run(actor, async () => {
          const settled = await held.hold.settle({ amount: decimal(actual) })
          if (settled.error) {
            expect(settled.error.code).toBe("CONFLICT")
            return closedInFull(actor, held)
          }
          if (settled.result.expired) return closedInFull(actor, held)
          expect(units(settled.result.actual)).toBe(cents(actual))
          confirmed += cents(actual)
        })
      }
      case "release": {
        const held = pickHold(actor, command.pick)
        if (!held) return
        return run(actor, async () => {
          const released = await held.hold.release()
          if (released.error) {
            expect(released.error.code).toBe("CONFLICT")
            return closedInFull(actor, held)
          }
          expect(units(released.result.released)).toBe(cents(held.cents))
        })
      }
      case "flush":
        return run(actor, async () => {
          await actor.handle.flush()
        })
      case "close":
        actor.disturbed += 1
        actor.closing += 1
        return run(actor, async () => {
          await actor.unprice.close()
          actor.closing -= 1
        })
      case "crash":
        if (scenario.mayCrash) actor.crashed = true
        return
    }
  }

  const admin = new Unprice({
    token: "unprice_dev_fuzz",
    baseUrl: "https://api.unprice.test",
    disableTelemetry: true,
    retry: { attempts: 0 },
    fetch: (request) => deliver(request, { actor: null, copy: false }),
  })
  const upserted = await admin.budgets.upsert({
    key: KEY,
    unit: "USD",
    limits: [
      { amount: decimal(scenario.limits.never), window: "never" },
      ...(scenario.limits.hour === undefined
        ? []
        : [{ amount: decimal(scenario.limits.hour), window: "hour" as const }]),
    ],
  })
  expect(upserted.error).toBeUndefined()

  for (const [id, lease] of scenario.leases.entries()) {
    const client: Client = {
      id,
      crashed: false,
      disturbed: 0,
      closing: 0,
      holds: [],
      calls: 0,
      pending: new Set(),
    }
    const unprice = new Unprice({
      token: "unprice_dev_fuzz",
      baseUrl: "https://api.unprice.test",
      disableTelemetry: true,
      // The lease protocol retries on its own; a transport retry is the `twice` fault.
      retry: { attempts: 0 },
      fetch: (request) => send(client, request),
    })
    const handle = unprice.budget(KEY, {
      mode: "local",
      lease: {
        amount: decimal(lease.amount),
        ...(lease.lowWater === undefined ? {} : { lowWater: decimal(lease.lowWater) }),
        ttlMs: lease.ttlMs,
        flushIntervalMs: lease.flushIntervalMs,
        idleMs: lease.idleMs,
      },
    })
    actors.push(Object.assign(client, { unprice, handle }))
  }

  for (const { command, faults: planned } of scenario.steps) {
    step += 1
    await releaseParked(false)
    faults = [...planned]
    await execute(command)
    await quiesce()
    faults = []
    expect(object.failures).toEqual([])
    expect(failures).toEqual([])
    expect(overLimit()).toEqual([])
  }

  // Faults stop: everything in flight lands, every live client closes, every other lease expires.
  await releaseParked(true)
  const live = actors.filter((actor) => !actor.crashed)
  for (const actor of live) {
    let failed: Awaited<ReturnType<Unprice["close"]>> = []
    for (let attempt = 0; attempt < 4; attempt++) {
      actor.disturbed += 1
      failed = await actor.unprice.close()
      await quiesce()
      if (failed.length === 0) break
    }
    expect(failed).toEqual([])
    expect(actor.pending.size).toBe(0)
  }
  for (let wakes = 0; wakes < 8; wakes++) {
    const open = object.store.leases().filter((lease) => lease.state.status === "open")
    if (open.length === 0) break
    const last = Math.max(...open.map((lease) => lease.expiresAt))
    await advance(Math.max(last - Date.now(), 0) + ALARM_CONTINUE_MS)
  }
  expect(object.failures).toEqual([])
  expect(failures).toEqual([])
  expect(overLimit()).toEqual([])

  const { store } = object
  const consumed = store.ledger.usage.never.consumed
  const spent = confirmed + full + sum(actors.flatMap((a) => a.holds.map((h) => cents(h.cents))))
  // What the server may count beyond the clients: the unreported rest of every lease that expired.
  const unreported = sum([...store.expired.values()].map((l) => l.granted - l.reported))

  expect(
    store.leases().flatMap((lease) => (lease.state.status === "open" ? [lease.leaseKey] : []))
  ).toEqual([])
  // Every lease the server granted reached the client that asked for it, unless that client
  // crashed first. A lease no client holds, such as one a stray copy of a refused request took,
  // would count its whole grant at expiry for nothing.
  const orphans = store.leases().filter((lease) => {
    if (lease.state.status === "refused" || heard.has(lease.leaseKey)) return false
    const owner = owners.get(lease.leaseKey)
    return owner === undefined || !actors[owner]?.crashed
  })
  expect(orphans.map((lease) => lease.leaseKey)).toEqual([])
  expect(store.ledger.held).toBe(ZERO)
  expect(consumed).toBeGreaterThanOrEqual(spent)
  expect(consumed).toBeLessThanOrEqual(spent + unreported)
  // With no lease expired, every lease ended in a final report, so the count is exact.
  if (store.expired.size === 0) expect(consumed).toBe(spent)
}

const expectedRefusal = (rejection: BudgetRejection) =>
  rejection.code === "LIMIT_EXCEEDED" ||
  (rejection.code === "LEASE_CLOSED" && rejection.status === "expired")

// Stray copies weigh most: a copy of a refused grant can take capacity only if room returns
// before it lands, so the scenario needs a refusal, its copy, and a close or idle return in between.
const faultArb: fc.Arbitrary<Fault> = fc.oneof(
  fc.constant("lose"),
  fc.constant("drop"),
  fc.constant("twice"),
  fc.record({ delay: fc.integer({ min: 1, max: 3 }) }),
  { weight: 3, arbitrary: fc.record({ echo: fc.integer({ min: 1, max: 6 }) }) }
)

const actorArb = fc.nat(2)

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("authorize"),
      actor: actorArb,
      cents: fc.integer({ min: 1, max: 150 }),
      ttlMs: fc.option(fc.integer({ min: 1_000, max: 30_000 }), { nil: undefined }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("settle"),
      actor: actorArb,
      pick: fc.nat(),
      percent: fc.integer({ min: 0, max: 100 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("release"), actor: actorArb, pick: fc.nat() }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("charge"),
      actor: actorArb,
      cents: fc.integer({ min: 1, max: 150 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("flush"), actor: actorArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("close"), actor: actorArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("crash"), actor: actorArb }) },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("advance"),
      ms: fc.oneof(
        { weight: 4, arbitrary: fc.integer({ min: 1, max: 2_000 }) },
        { weight: 2, arbitrary: fc.integer({ min: 2_000, max: 20_000 }) },
        { weight: 1, arbitrary: fc.integer({ min: 20_000, max: 90_000 }) }
      ),
    }),
  }
)

const leaseArb: fc.Arbitrary<LeaseOptions> = fc
  .record({
    amount: fc.integer({ min: 20, max: 300 }),
    lowWater: fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }),
    flushIntervalMs: fc.constantFrom(500, 1_000, 2_000),
    ttlAfterThreeTicks: fc.integer({ min: 1, max: 20_000 }),
    idleMs: fc.option(fc.integer({ min: 500, max: 20_000 }), { nil: Number.POSITIVE_INFINITY }),
  })
  // The SDK renews before the last third of the TTL, at its flush ticks, so it refuses a TTL of
  // three ticks or less, which would lapse between them (budget-local.test.ts covers that).
  .map(({ ttlAfterThreeTicks, ...lease }) => ({
    ...lease,
    ttlMs: 3 * lease.flushIntervalMs + ttlAfterThreeTicks,
  }))

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  limits: fc.record({
    never: fc.integer({ min: 100, max: 1_500 }),
    hour: fc.option(fc.integer({ min: 50, max: 1_500 }), { nil: undefined }),
  }),
  leases: fc.array(leaseArb, { minLength: 1, maxLength: 3 }),
  mayCrash: fc.boolean(),
  steps: fc.array(
    fc.record({
      command: commandArb,
      faults: fc.oneof(
        { weight: 1, arbitrary: fc.constant<Fault[]>([]) },
        { weight: 1, arbitrary: fc.array(faultArb, { minLength: 1, maxLength: 3 }) }
      ),
    }),
    { minLength: 1, maxLength: 60, size: "medium" }
  ),
})

describe("budget local mode against the real budget", () => {
  let leaseKeys = 0

  beforeEach(() => {
    // Deterministic lease keys, so a seed replays the same run.
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(++leaseKeys).padStart(12, "0")}`
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it(
    "never lets clients spend past a hard limit or the server miscount their spend",
    { timeout: timeoutMs },
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          leaseKeys = 0
          // setImmediate stays real: `quiesce` yields with it.
          vi.useFakeTimers({
            now: START,
            toFake: [
              "setTimeout",
              "clearTimeout",
              "setInterval",
              "clearInterval",
              "Date",
              "performance",
            ],
          })
          try {
            await runScenario(scenario)
          } finally {
            vi.useRealTimers()
          }
        }),
        { numRuns: runs, seed }
      )
    }
  )
})
