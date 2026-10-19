import {
  type AmountInput,
  type AuthorizeBudgetInput,
  type BudgetAuthorization,
  type BudgetBalance,
  type BudgetCharge,
  type BudgetDenial,
  type BudgetHandle,
  type BudgetHold,
  type SpendSettlement,
  createSpend,
  toDenial,
} from "./budgets"
import type { ApiError } from "./errors"
import type { GeneratedSdkResources } from "./generated/sdk-resources"
import {
  type FrozenReport,
  type LeaseGrant,
  LeaseLedger,
  type LocalHold,
  type LocalRejection,
  type SpendDecision,
  type Units,
  fromUnits,
  toUnits,
} from "./lease-ledger"
import type { OperationInput, OperationResponse } from "./operation-types"
import type { ApiResult } from "./result"

const ZERO = BigInt(0)
const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
const DEFAULT_IDLE_MS = 10_000

export type LeaseRequest = OperationInput<"budgets.lease">
export type LeaseReportRequest = OperationInput<"budgets.report">
export type LeaseResponse = OperationResponse<"budgets.lease">
export type LeaseReportResponse = OperationResponse<"budgets.report">

/** Why an extension came back short. The capture in the same report still applied. */
export type ExtensionDenial = NonNullable<LeaseReportResponse["extension"]["denied"]>

/** The two routes a local handle speaks: `unprice.budgets` provides them, and tests fake them. */
export type LeaseTransport = Pick<GeneratedSdkResources["budgets"], "lease" | "report">

export type LocalLeaseOptions = {
  /** Capacity to lease per grant, and the level a refill tops local capacity back up to. */
  amount: AmountInput
  /** Refill in the background below this. Defaults to a quarter of `amount`. */
  lowWater?: AmountInput
  /**
   * The lease's TTL, renewed while the process reports. Must exceed three flush intervals.
   * Defaults to 60 s.
   */
  ttlMs?: number
  /**
   * How often consumption is reported while it changes, and how long a key whose grant was refused
   * answers with that denial before it asks again. Defaults to 1 s.
   */
  flushIntervalMs?: number
  /**
   * Returns the lease after this long without a local authorize, charge, settle, or release, once
   * no hold is open. The next call takes a new lease. Defaults to 10 s; `Infinity` keeps it.
   */
  idleMs?: number
  /** Background report failures. Spending continues within the lease until its deadline. */
  onError?: (error: ApiError) => void
}

export type LocalBudgetOptions = { mode: "local"; lease: LocalLeaseOptions }

/**
 * The BudgetHandle contract, answered from a lease held in this process (ADR-0006 B10). Every
 * handle for a key on one client spends from the same lease.
 */
export type LocalBudgetHandle = BudgetHandle & {
  readonly mode: "local"
  /** Reports consumption now. Null when nothing was unreported or no lease is open. */
  flush(): Promise<ApiResult<LeaseReportResponse | null>>
  /**
   * Final report: open holds count at their full amount and the unused lease returns. A lease the
   * process never closes expires and counts in full. A later call opens a new lease.
   */
  close(): Promise<ApiResult<LeaseReportResponse | null>>
}

/** The client's local leases: at most one per key, and nothing kept for a key without one. */
export type LocalLeases = {
  budget(remote: BudgetHandle, key: string, options: LocalLeaseOptions): LocalBudgetHandle
  /** Final-reports every open lease. Resolves with the keys whose lease was not returned. */
  close(): Promise<Array<{ key: string; error: ApiError }>>
}

type LeaseSettings = Readonly<{
  amount: Units
  lowWater: Units
  ttlMs: number
  flushIntervalMs: number
  idleMs: number
}>

type Shell = Pick<LocalBudgetHandle, "authorize" | "charge" | "flush" | "close"> & {
  readonly settings: LeaseSettings
}

type Lease = {
  readonly ledger: LeaseLedger
  balance: BudgetBalance
  /** The last extension's denial. Refills below low water then wait for a request that needs one. */
  denied: ExtensionDenial | null
  /** The one report in flight, which is also the one refill in flight. */
  inFlight: Promise<ApiResult<LeaseReportResponse>> | null
}

type Epoch =
  /** `replay`: a grant whose answer was lost. It may have committed, so it is resent first. */
  | { phase: "idle"; replay: LeaseRequest | null }
  | { phase: "granting"; granted: Promise<ApiResult<Lease>> }
  | { phase: "open"; lease: Lease }

type Spent<T> = Readonly<{ lease: Lease; value: T }> | ApiResult<BudgetDenial>

// Survives wall-clock steps, so a deadline cannot move later while the process runs.
const monotonicNow = () => performance.timeOrigin + performance.now()

export const createLocalLeases = ({
  transport,
  settlement,
  now = monotonicNow,
}: {
  transport: LeaseTransport
  settlement?: SpendSettlement
  now?: () => number
}): LocalLeases => {
  const shells = new Map<string, Shell>()

  const live = (key: string, settings: LeaseSettings) => {
    const shell = shells.get(key)
    if (shell && !sameSettings(shell.settings, settings)) {
      throw new RangeError(`Budget ${key} already has an open local lease with other options`)
    }
    return shell
  }

  const budget: LocalLeases["budget"] = (remote, key, options) => {
    const settings = leaseSettings(options)
    live(key, settings)
    // Resolved per call, so a handle kept past its lease's end shares the key's next lease.
    const shell = () => {
      const open = live(key, settings)
      if (open) return open
      const created = createShell({
        transport,
        key,
        settings,
        onError: options.onError,
        now,
        forget: () => {
          if (shells.get(key) === created) shells.delete(key)
        },
      })
      shells.set(key, created)
      return created
    }
    const authorize: BudgetHandle["authorize"] = async (input) => shell().authorize(input)

    return {
      key,
      mode: "local",
      authorize,
      charge: async (input) => shell().charge(input),
      record: remote.record,
      get: remote.get,
      spend: createSpend(authorize, settlement),
      flush: async () => shells.get(key)?.flush() ?? { result: null },
      close: async () => shells.get(key)?.close() ?? { result: null },
    }
  }

  const close: LocalLeases["close"] = async () => {
    const closed = await Promise.all(
      Array.from(shells, async ([key, shell]) => ({ key, closed: await shell.close() }))
    )
    return closed.flatMap(({ key, closed: { error } }) => (error ? [{ key, error }] : []))
  }

  return { budget, close }
}

const createShell = ({
  transport,
  key,
  settings,
  onError,
  now,
  forget,
}: {
  transport: LeaseTransport
  key: string
  settings: LeaseSettings
  onError: LocalLeaseOptions["onError"]
  now: () => number
  /** Drops this shell from the registry. */
  forget: () => void
}): Shell => {
  const { amount, lowWater, ttlMs, flushIntervalMs, idleMs } = settings

  let epoch: Epoch = { phase: "idle", replay: null }
  let timer: ReturnType<typeof setInterval> | null = null
  let calls = 0
  let activeAt = now()
  // The server writes a row for each refused grant, so for one flush interval after a 402 the
  // key's calls get that denial from memory instead of a refused grant each.
  let refused: ApiError | null = null

  // Only between calls, so no call goes on to open a lease from a shell the registry dropped.
  const forgetIfDone = () => {
    if (calls === 0 && epoch.phase === "idle" && epoch.replay === null && refused === null) {
      forget()
    }
  }

  const refuse = (error: ApiError) => {
    refused = error
    const lapse = setTimeout(() => {
      refused = null
      forgetIfDone()
    }, flushIntervalMs)
    if (typeof lapse === "object") lapse.unref()
  }

  const tracked =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls += 1
      try {
        return await call(...args)
      } finally {
        calls -= 1
        forgetIfDone()
      }
    }

  const topUp = (ledger: LeaseLedger): Units => {
    const available = ledger.available()
    return available < lowWater && available < amount ? amount - available : ZERO
  }

  const end = (lease: Lease) => {
    if (lease.ledger.phase !== "ended") lease.ledger.retire()
    if (epoch.phase === "open" && epoch.lease === lease) {
      epoch = { phase: "idle", replay: null }
      if (timer) clearInterval(timer)
      timer = null
      forgetIfDone()
    }
  }

  const grant = (need: Units): Promise<ApiResult<Lease>> => {
    if (epoch.phase === "granting") return epoch.granted
    if (epoch.phase === "open") return Promise.resolve({ result: epoch.lease })
    if (refused) return Promise.resolve({ error: refused })
    const request = epoch.replay ?? {
      key,
      leaseKey: globalThis.crypto.randomUUID(),
      amount: fromUnits(need > amount ? need : amount),
      ttlMs,
    }
    const sentAt = now()
    const granted = transport.lease(request).then((response): ApiResult<Lease> => {
      if (response.error) {
        epoch = { phase: "idle", replay: retryable(response.error) ? request : null }
        if (response.error.code === "BUDGET_EXCEEDED") refuse(response.error)
        return { error: response.error }
      }
      const { result } = response
      const lease: Lease = {
        ledger: new LeaseLedger(toGrant(result), sentAt),
        balance: result.balance,
        denied: null,
        inFlight: null,
      }
      epoch = { phase: "open", lease }
      timer = setInterval(() => {
        if (epoch.phase === "open") reportInBackground(epoch.lease, true)
      }, flushIntervalMs)
      if (typeof timer === "object") timer.unref()
      return { result: lease }
    })
    epoch = { phase: "granting", granted }
    return granted
  }

  const send = (
    lease: Lease,
    params: { final: boolean; extend: Units }
  ): Promise<ApiResult<LeaseReportResponse>> => {
    if (lease.inFlight) return lease.inFlight
    const report = lease.ledger.freeze(params, now())
    const sentAt = now()
    lease.inFlight = transport
      .report(toReportRequest(key, lease.ledger.leaseKey, report))
      .then((response) => {
        lease.inFlight = null
        if (response.error) {
          if (!retryable(response.error)) end(lease)
          return response
        }
        lease.ledger.acknowledge(report, toGrant(response.result), sentAt)
        lease.balance = response.result.balance
        lease.denied = response.result.extension.denied ?? null
        if (report.final) end(lease)
        return response
      })
    return lease.inFlight
  }

  // After a call, only a refill below low water starts. The timer also retries a lost report,
  // reports changed consumption, renews the lease before its last third, and returns it when idle.
  const reportInBackground = (lease: Lease, periodic: boolean) => {
    const { ledger } = lease
    if (lease.inFlight || ledger.phase === "ended") return
    const at = now()
    ledger.expire(at)
    // A final report counts open holds in full, so a lease under running work is never idle.
    const final = periodic && at - activeAt >= idleMs && ledger.totals().held === ZERO
    const low = lease.denied === null && ledger.available() < lowWater
    const due =
      final ||
      (periodic
        ? low || ledger.pending !== null || ledger.dirty() || ledger.deadline - at < ttlMs / 3
        : low && ledger.pending === null)
    if (!due) return
    void send(lease, { final, extend: topUp(ledger) }).then((sent) => {
      if (sent.error) onError?.(sent.error)
    })
  }

  // The ledger checks and debits in one synchronous call. Only a missing lease, a request the
  // lease cannot cover, or a passed deadline waits on the network.
  const spendLocally = async <T>(
    need: Units,
    attempt: (ledger: LeaseLedger, at: number) => SpendDecision<T>
  ): Promise<Spent<T>> => {
    for (;;) {
      let lease: Lease
      if (epoch.phase === "open") {
        lease = epoch.lease
      } else {
        const granted = await grant(need)
        if (granted.error) return failed(granted.error)
        lease = granted.result
      }

      activeAt = now()
      const decision = attempt(lease.ledger, activeAt)
      if (decision.kind === "ok") {
        reportInBackground(lease, false)
        return { lease, value: decision.value }
      }
      if (decision.kind === "rejected") return { error: localError(decision.rejection) }
      if (lease.inFlight) {
        await lease.inFlight
        continue
      }

      const final = decision.kind === "ended"
      const extend =
        decision.kind === "short"
          ? (need > amount ? need : amount) - lease.ledger.available()
          : topUp(lease.ledger)
      const sent = await send(lease, { final, extend })
      if (sent.error) {
        if (lease.ledger.phase === "ended") continue
        return failed(sent.error)
      }
      const { denied } = sent.result.extension
      if (decision.kind === "short" && denied && need > lease.ledger.available()) {
        return denialOf(denied)
      }
    }
  }

  const localHold = (lease: Lease, hold: LocalHold): BudgetHold => ({
    id: hold.id,
    key,
    amount: fromUnits(hold.amount),
    expiresAt: hold.expiresAt,
    settle: async ({ amount: input }) => {
      const actual = toUnits(input)
      if (actual === null) return { error: invalidAmount(input) }
      activeAt = now()
      const decision = lease.ledger.settle(hold.id, actual, activeAt)
      if (decision.kind === "rejected") return { error: localError(decision.rejection) }
      const { value } = decision
      return {
        result: {
          holdId: hold.id,
          actual: fromUnits(value.actual),
          released: fromUnits(value.released),
          expired: value.expired,
          crossed: [],
          replayed: value.replayed,
          balance: lease.balance,
        },
      }
    },
    release: async () => {
      activeAt = now()
      const decision = lease.ledger.release(hold.id, activeAt)
      if (decision.kind === "rejected") return { error: localError(decision.rejection) }
      const { value } = decision
      return {
        result: {
          holdId: hold.id,
          released: fromUnits(value.released),
          replayed: value.replayed,
          balance: lease.balance,
        },
      }
    },
  })

  const authorize = async ({
    amount: input,
    idempotencyKey,
    ttlMs: holdTtlMs,
  }: AuthorizeBudgetInput): Promise<ApiResult<BudgetAuthorization>> => {
    const need = toUnits(input)
    if (need === null) return { error: invalidAmount(input) }
    const spent = await spendLocally(need, (ledger, at) =>
      ledger.authorize({ amount: need, idempotencyKey, ttlMs: holdTtlMs }, at)
    )
    if (!("lease" in spent)) return spent
    const { lease, value } = spent
    return {
      result: {
        allowed: true,
        degraded: false,
        hold: localHold(lease, value.hold),
        balance: lease.balance,
        replayed: value.replayed,
      },
    }
  }

  const charge: BudgetHandle["charge"] = async ({ amount: input, idempotencyKey }) => {
    const need = toUnits(input)
    if (need === null) return { error: invalidAmount(input) }
    const spent = await spendLocally(need, (ledger, at) =>
      ledger.charge({ amount: need, idempotencyKey }, at)
    )
    if (!("lease" in spent)) return spent
    const { lease, value } = spent
    const charged: BudgetCharge = {
      allowed: true,
      degraded: false,
      amount: fromUnits(value.amount),
      crossed: [],
      replayed: value.replayed,
      balance: lease.balance,
    }
    return { result: charged }
  }

  const flush = async (): Promise<ApiResult<LeaseReportResponse | null>> => {
    if (epoch.phase !== "open") return { result: null }
    const { lease } = epoch
    if (lease.inFlight) await lease.inFlight
    const { ledger } = lease
    if (ledger.phase !== "open" || (ledger.pending === null && !ledger.dirty())) {
      return { result: null }
    }
    return send(lease, { final: false, extend: topUp(ledger) })
  }

  const close = async (): Promise<ApiResult<LeaseReportResponse | null>> => {
    for (;;) {
      if (epoch.phase === "granting") {
        await epoch.granted
        continue
      }
      if (epoch.phase === "idle") {
        if (!epoch.replay) return { result: null }
        // The lost grant may have committed: replay it so its capacity can be returned.
        const granted = await grant(ZERO)
        if (granted.error) return { error: granted.error }
        continue
      }
      const { lease } = epoch
      if (lease.inFlight) {
        await lease.inFlight
        continue
      }
      const sent = await send(lease, { final: true, extend: ZERO })
      if (sent.error || lease.ledger.phase === "ended") return sent
    }
  }

  return {
    settings,
    authorize: tracked(authorize),
    charge: tracked(charge),
    flush,
    close: tracked(close),
  }
}

function leaseSettings(options: LocalLeaseOptions): LeaseSettings {
  const amount = optionUnits(options.amount, "lease.amount")
  if (amount === ZERO) throw new RangeError("lease.amount must be positive")
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
  if (!(idleMs > 0)) throw new RangeError(`lease.idleMs must be positive, received ${idleMs}`)
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  // Renewal is checked on flush ticks once less than a third of the TTL is left; with a third no
  // longer than a tick, the lease can expire between two ticks on a perfect network.
  if (!(ttlMs > 3 * flushIntervalMs)) {
    throw new RangeError(
      `lease.ttlMs must exceed 3 × lease.flushIntervalMs, received ttlMs ${ttlMs} and flushIntervalMs ${flushIntervalMs}`
    )
  }
  return {
    amount,
    lowWater:
      options.lowWater === undefined
        ? amount / BigInt(4)
        : optionUnits(options.lowWater, "lease.lowWater"),
    ttlMs,
    flushIntervalMs,
    idleMs,
  }
}

const sameSettings = (a: LeaseSettings, b: LeaseSettings) =>
  a.amount === b.amount &&
  a.lowWater === b.lowWater &&
  a.ttlMs === b.ttlMs &&
  a.flushIntervalMs === b.flushIntervalMs &&
  a.idleMs === b.idleMs

function optionUnits(amount: AmountInput, name: string): Units {
  const units = toUnits(amount)
  if (units === null)
    throw new RangeError(`${name} must be a non-negative decimal, received ${amount}`)
  return units
}

function serverUnits(text: string): Units {
  const units = toUnits(text)
  if (units === null) throw new Error(`The lease API returned an invalid amount: ${text}`)
  return units
}

const toGrant = ({ lease, terms, balance }: LeaseResponse): LeaseGrant => ({
  leaseKey: lease.leaseKey,
  seq: lease.seq,
  granted: serverUnits(lease.granted),
  captured: serverUnits(lease.captured),
  expiresAt: lease.expiresAt,
  asOf: balance.asOf,
  terms,
})

const toReportRequest = (
  key: string,
  leaseKey: string,
  report: FrozenReport
): LeaseReportRequest => {
  const { seq } = report
  const captured = fromUnits(report.captured)
  return report.final
    ? { key, leaseKey, seq, captured, final: true }
    : { key, leaseKey, seq, captured, final: false, extend: fromUnits(report.extend) }
}

// The answer of a lost or refused request may still have committed; resending it is safe.
const retryable = (error: ApiError) =>
  error.code === "FETCH_ERROR" ||
  error.code === "INTERNAL_SERVER_ERROR" ||
  error.code === "TOO_MANY_REQUESTS"

const failed = (error: ApiError): ApiResult<BudgetDenial> => {
  const denial = toDenial(error)
  return denial ? { result: denial } : { error }
}

const denialOf = (denied: ExtensionDenial): ApiResult<BudgetDenial> => {
  if (denied.kind === "budget_closed") {
    return { error: localError({ code: "BUDGET_CLOSED", closedAt: denied.closedAt }) }
  }
  return {
    result: {
      allowed: false,
      degraded: false,
      blocked: { reason: "limit", ...denied.blocked },
      balance: denied.balance,
    },
  }
}

const docs = (code: string) => `https://docs.unprice.dev/api-reference/errors/code/${code}`

const invalidAmount = (amount: AmountInput): ApiError => ({
  code: "BAD_REQUEST",
  message: `Budget amounts must be non-negative decimals with at most 8 decimal places, received ${amount}`,
  docs: docs("BAD_REQUEST"),
  requestId: "local",
})

/** The error the API returns for the same rejection. */
function localError(rejection: LocalRejection): ApiError {
  const conflict = (
    message: string,
    details?: Extract<ApiError, { code: "CONFLICT" }>["details"]
  ): ApiError => ({
    code: "CONFLICT",
    message,
    docs: docs("CONFLICT"),
    requestId: "local",
    ...(details ? { details } : {}),
  })
  switch (rejection.code) {
    case "IDEMPOTENCY_CONFLICT":
      return conflict(
        `Idempotency key ${rejection.idempotencyKey} was used with a different request`
      )
    case "HOLD_CLOSED":
      return conflict(
        rejection.status === "expired"
          ? `Hold ${rejection.holdId} expired and was settled at its full amount`
          : `Hold ${rejection.holdId} is already ${rejection.status}`
      )
    case "HOLD_RETIRED":
      return conflict(
        `Hold ${rejection.holdId} closed past its retention and can no longer be settled or released`
      )
    case "BUDGET_CLOSED":
      return conflict(`Budget closed at ${new Date(rejection.closedAt).toISOString()}`, {
        kind: "budget_closed",
        closedAt: rejection.closedAt,
      })
    case "HOLD_AMOUNT_EXCEEDED": {
      const maximum = fromUnits(rejection.maximum)
      const actual = fromUnits(rejection.actual)
      return conflict(`Hold ${rejection.holdId} permits ${maximum}, not ${actual}`, {
        kind: "hold_amount_exceeded",
        holdId: rejection.holdId,
        maximum,
        actual,
      })
    }
    case "INVALID_TTL":
      return {
        code: "BAD_REQUEST",
        message: `Hold TTL must be between ${rejection.minTtlMs} and ${rejection.maxTtlMs} ms, got ${rejection.ttlMs}`,
        docs: docs("BAD_REQUEST"),
        requestId: "local",
      }
  }
}
