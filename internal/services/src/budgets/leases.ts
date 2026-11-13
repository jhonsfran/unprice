/** Budget leases rules. */

import { Ok, type Result } from "@unprice/error"
import { type Funded, amountLimitsOf, balanceOf, blockingLimit, crossings, roomOf } from "./balance"
import { isClosed } from "./config"
import { type Change, invalidTtl, unchanged } from "./decide"
import { consume } from "./ledger"
import type {
  BudgetCommand,
  ExtensionDenial,
  LeaseOperation,
  LeaseReportRequest,
  Operation,
} from "./model"
import { type UnPriceBudgetError, reject } from "./rejections"
import { NO_USAGE, amountUsage, subtractUsage } from "./usage"

const ZERO = BigInt(0)

/**
 * Debits first, against every hard amount limit, like an authorize, and grants what fits: near a
 * limit less than asked for. Nothing fitting is written as a refused lease: a lease key's first
 * answer is final, so a late copy of a refused request cannot take capacity no process holds. The
 * same key, amount, and TTL replay the grant or the refusal.
 */
export function decideLease(
  command: Extract<BudgetCommand, { type: "lease" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { leaseKey, amount, ttlMs } = command
  if (target) {
    const lease = leaseOf(target, leaseKey)
    if (lease.requested === amount && lease.ttlMs === ttlMs) return Ok(unchanged(lease))
    return reject({ code: "IDEMPOTENCY_CONFLICT", idempotencyKey: leaseKey })
  }
  const { config } = state.budget
  // A lease spends an amount in the caller's memory, which no statement would ever see.
  if (config.pricing) return reject({ code: "EVENT_REQUIRED" })
  const invalid = invalidTtl(ttlMs, config.holds.maxTtlMs)
  if (invalid) return invalid
  if (config.closesAt !== null && isClosed(config, now)) {
    return reject({ code: "BUDGET_CLOSED", closedAt: config.closesAt })
  }
  const balance = balanceOf(state, now)
  const room = roomOf(balance)
  const granted = room === null || room >= amount ? amount : room
  const blocked =
    granted === ZERO ? blockingLimit(amountLimitsOf(balance), amountUsage(amount)) : null
  const lease: LeaseOperation = {
    kind: "lease",
    id: `l:${leaseKey}`,
    leaseKey,
    requested: amount,
    ttlMs,
    createdAt: now,
    granted,
    captured: ZERO,
    last: null,
    expiresAt: now + ttlMs,
    state: blocked ? { status: "refused", closedAt: now, blocked } : { status: "open" },
  }
  return Ok({ rows: [lease], row: lease, held: amountUsage(granted), consumed: NO_USAGE })
}

function sameReport(a: LeaseReportRequest, b: LeaseReportRequest): boolean {
  if (a.captured !== b.captured) return false
  return a.final || b.final ? a.final === b.final : a.extend === b.extend
}

/**
 * One report, one transaction. It moves the capture delta from held to consumed, then either
 * extends by what fits (a short extension is an outcome, so the capture always lands) and renews
 * once less than half the TTL remains, or, when final, returns the unused grant. Past `expiresAt`
 * only a final report is accepted, like a late settle (B3).
 */
export function decideReport(
  command: Extract<BudgetCommand, { type: "report" }>,
  state: Funded,
  target: Operation | null,
  now: number
): Result<Change, UnPriceBudgetError> {
  const { leaseKey, seq, request } = command
  const lease = target && leaseOf(target, leaseKey)
  // A refused lease was never granted, so it has nothing to report on.
  if (!lease || lease.state.status === "refused") {
    return reject({ code: "LEASE_NOT_FOUND", leaseKey })
  }
  const { last, state: leaseState } = lease
  if (last && last.seq === seq && sameReport(last.request, request)) return Ok(unchanged(lease))
  if (leaseState.status !== "open") {
    return reject({ code: "LEASE_CLOSED", leaseKey, status: leaseState.status })
  }
  const applied = last?.seq ?? 0
  if (seq !== applied + 1) {
    return reject({ code: "LEASE_SEQ_CONFLICT", leaseKey, seq: applied, requested: seq })
  }
  const { captured } = request
  if (captured < lease.captured || captured > lease.granted) {
    return reject({
      code: "LEASE_CAPTURE_OUT_OF_RANGE",
      leaseKey,
      minimum: lease.captured,
      maximum: lease.granted,
      captured,
    })
  }
  if (!request.final && now >= lease.expiresAt) {
    return reject({ code: "LEASE_CLOSED", leaseKey, status: "expired" })
  }

  const balance = balanceOf(state, now)
  const delta = amountUsage(captured - lease.captured)
  const crossed = crossings(balance, delta)
  if (request.final) {
    const row: LeaseOperation = {
      ...lease,
      captured,
      last: { seq, request, extended: ZERO, denied: null, crossed },
      state: { status: "closed", closedAt: now },
    }
    const held = amountUsage(lease.captured - lease.granted)
    return Ok({ rows: [row], row, held, consumed: delta })
  }

  // The extension is judged after the capture it travels with.
  const { ledger } = state
  const afterCapture = amountLimitsOf(
    balanceOf(
      {
        ...state,
        ledger: {
          ...ledger,
          held: subtractUsage(ledger.held, delta),
          usage: consume(ledger.usage, delta),
        },
      },
      now
    )
  )
  const { config } = state.budget
  const closedAt = config.closesAt !== null && isClosed(config, now) ? config.closesAt : null
  const room = closedAt === null ? roomOf(afterCapture) : ZERO
  const extended = room === null || room >= request.extend ? request.extend : room
  let denied: ExtensionDenial | null = null
  if (extended < request.extend && closedAt !== null) {
    denied = { code: "BUDGET_CLOSED", closedAt }
  } else if (extended < request.extend) {
    const blocked = blockingLimit(afterCapture, amountUsage(request.extend))
    if (!blocked) throw new Error(`lease ${leaseKey} extended short with no blocking limit`)
    denied = { code: "LIMIT_EXCEEDED", blocked }
  }
  const renew = 2 * (lease.expiresAt - now) < lease.ttlMs
  const row: LeaseOperation = {
    ...lease,
    granted: lease.granted + extended,
    captured,
    last: { seq, request, extended, denied, crossed },
    expiresAt: renew ? now + lease.ttlMs : lease.expiresAt,
  }
  return Ok({
    rows: [row],
    row,
    held: subtractUsage(amountUsage(extended), delta),
    consumed: delta,
  })
}

/** The lease a lease or report addresses; the store found it by the command's lease key. */
function leaseOf(target: Operation, leaseKey: string): LeaseOperation {
  if (target.kind !== "lease" || target.leaseKey !== leaseKey) {
    throw new Error(`target ${target.id} is not the lease ${leaseKey}`)
  }
  return target
}
