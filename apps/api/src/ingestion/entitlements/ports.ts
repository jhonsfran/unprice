import type { Logger } from "@unprice/logs"
import type { GrantConsumptionState } from "@unprice/services/entitlements"
import type { WalletService } from "@unprice/services/wallet"
import type {
  ActiveGrantInput,
  ApplyResult,
  BatchIdempotencyEntry,
  WalletReservationSnapshot,
} from "./contracts"
import type { MeterStateDraft } from "./meter-state-adapter"

// ---------------------------------------------------------------------------
// Backend-neutral ports for one entitlement window.
//
// The EntitlementWindowProcessor owns all entitlement business orchestration
// and talks to the host platform only through these ports. Today the only
// production implementation is Cloudflare Durable Object + SQLite
// (EntitlementWindowStore + EntitlementWindowDO wiring). A Redis-backed
// implementation replaces the store/scheduler/runtime adapters — not the
// processor.
//
// ## Key ownership (one window = one processor instance)
//
// A window is addressed by `buildIngestionWindowName(appEnv, projectId,
// customerId, customerEntitlementId)`. All state below belongs exclusively to
// that window; no other window may read or write it:
//
//   - meter state: raw aggregation value per meterKey (usage, updatedAt)
//   - entitlement period usage: compact grant consumption states per periodKey
//   - idempotency entries: apply results keyed by event idempotency key
//   - wallet reservation: a SINGLETON row mirroring the open ledger
//     reservation (allocation/consumed/flushed amounts, pending flush intent)
//
// A Redis implementation should namespace all keys for a window under one
// hash tag (e.g. `{window:<name>}:meter`, `{window:<name>}:wallet`, ...) so
// multi-key atomic scripts stay in a single slot.
//
// ## Concurrency model (single writer)
//
// Durable Objects serialize all requests for a window on one thread; the
// processor's read-stage-commit flows (optimized batch drafts, wallet spend
// planning, alarm close decisions) rely on that: state read at the start of a
// command cannot be changed by another writer before the command commits. A
// Redis implementation MUST reproduce single-writer semantics per window —
// e.g. run every processor command under a per-window lock/lease, or route
// all mutations through per-window Lua scripts executed one at a time.
//
// ## Atomicity
//
// `atomically(fn)` is the transactional command boundary: every store write
// issued through the callback's ops commits or rolls back as one unit, and
// the callback MUST be synchronous (no awaits — external I/O never happens
// inside the boundary). SQLite maps this to a DO transaction; Redis can use a
// single Lua script or MULTI under the per-window lock. Ops called directly
// on the store (outside `atomically`) are single atomic commands.
//
// Invariants the processor relies on:
//   - Idempotency entries and the local accounting they seal (meter state,
//     grant consumption, wallet consumed amounts) commit in the SAME atomic
//     unit. A replay seal without its accounting (or vice versa) corrupts
//     usage or double-applies events.
//   - Wallet pending-flush intent (`pendingFlushSeq`, `pendingFlushAmount`,
//     `pendingFlushQuantity`, `pendingRefillAmount`, `refillInFlight`,
//     `pendingFlushFinal`) is persisted BEFORE any external wallet I/O for
//     that seq, and is never recomputed for an existing seq.
//
// ## flushSeq monotonicity
//
// `flushSeq` / `pendingFlushSeq` order wallet ledger work. The ledger dedupes
// on `flush:{reservationId}:{flushSeq}` (and capture/extend variants), so:
//   - `pendingFlushSeq` is always `flushSeq + 1` when opened (or a persisted
//     pending seq being retried),
//   - `flushSeq` only ever advances to a completed `pendingFlushSeq`,
//   - a backend must never regress either value (e.g. Redis failover to a
//     stale replica would violate ledger idempotency).
//
// ## Idempotency retention
//
// Entries must be retained for at least DO_IDEMPOTENCY_TTL_MS (ingestion max
// event age + safety margin) so a retried event inside the accepted-age
// window always replays its sealed result. Cleanup is time-bounded and
// batch-bounded (`cleanupStaleIdempotencyKeys`); Redis may instead lean on
// key TTLs >= DO_IDEMPOTENCY_TTL_MS.
//
// ## Recovery semantics for pending wallet flushes
//
// On window wake (`EntitlementWindowProcessor.initialize`), a persisted
// `pendingFlushSeq > flushSeq` means the host crashed mid-flush. The
// processor re-issues the SAME seq with the persisted amounts (final pending
// flushes re-enter the reservation close path). Any store implementation must
// therefore make the pending intent durable before external wallet calls and
// keep it until the seq completes or an operator intervenes
// (`recoveryRequired`).
// ---------------------------------------------------------------------------

/**
 * Partial update of the singleton wallet reservation row. Keys mirror
 * WalletReservationSnapshot; absent keys are left untouched.
 */
export type WalletReservationPatch = Partial<NonNullable<WalletReservationSnapshot>>

export type EnsureWalletReservationParams = {
  projectId: string
  customerId: string
  currency: string
  reservationEndAt: number
  billingPeriodId?: string | null
  cycleEndAt?: number | null
  cycleStartAt?: number | null
  featurePlanVersionItemId?: string | null
  featureSlug?: string | null
  statementKey?: string | null
}

/**
 * Domain state operations for one entitlement window. Available both directly
 * on the store (auto-commit single commands) and inside `atomically`
 * (grouped into one transaction). All methods are synchronous: the DO backend
 * is an in-memory SQLite handle, and a Redis backend is expected to execute a
 * whole `atomically` block as one server-side script rather than awaiting
 * per-op round trips.
 */
export type EntitlementWindowStateOps = {
  // ----- meter aggregation state (per meterKey, no cadence reset) -----
  /** Insert-if-absent so a later usage update always has a row to hit. */
  ensureMeterState(params: { meterKey: string; createdAt: number }): void
  readMeterStateDraft(meterKey: string, createdAt: number): MeterStateDraft
  /** ensure + write of usage/updatedAt; pairs with MeterStateDraft staging. */
  writeMeterState(params: {
    meterKey: string
    createdAt: number
    usage: number
    updatedAt: number | null
  }): void

  // ----- grant consumption state (compact rows per periodKey) -----
  readGrantStatesForActiveGrants(
    grants: ActiveGrantInput[],
    timestamp: number
  ): GrantConsumptionState[]
  readGrantStatesForBatch(grants: ActiveGrantInput[], timestamps: number[]): GrantConsumptionState[]
  /** Merge-write; returns the number of period rows touched. */
  writeGrantConsumptions(states: Iterable<GrantConsumptionState>): number

  // ----- idempotency (replay seals per event idempotency key) -----
  lookupCachedIdempotencyResult(eventId: string): ApplyResult | null
  lookupCachedIdempotencyResults(eventIds: string[]): Map<string, BatchIdempotencyEntry>
  writeBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void

  // ----- wallet reservation (singleton) -----
  readWalletReservation(): WalletReservationSnapshot
  /** Upsert of the singleton row's identity/invoice-context columns. */
  ensureWalletReservation(params: EnsureWalletReservationParams): void
  updateWalletReservation(patch: WalletReservationPatch): void
}

/**
 * Storage port for one entitlement window. See the module header for the
 * atomicity, ordering, and retention guarantees an implementation must honor.
 */
export interface EntitlementWindowStateStore extends EntitlementWindowStateOps {
  /**
   * Atomic command boundary: all ops issued through `tx` commit or roll back
   * together. `fn` MUST be synchronous and free of external side effects so a
   * backend may re-execute it on contention (e.g. Redis WATCH/MULTI).
   */
  atomically<T>(fn: (tx: EntitlementWindowStateOps) => T): T

  /**
   * Record entries in the store's read-through result cache after their
   * durable write committed. Never a durable write by itself.
   */
  recordBatchIdempotencyResults(entries: BatchIdempotencyEntry[]): void

  /** Bounded cleanup of entries older than DO_IDEMPOTENCY_TTL_MS; returns count removed. */
  cleanupStaleIdempotencyKeys(now: number): number

  /**
   * Latest lifecycle deadline for this window: max(period usage end,
   * reservation end). Drives the retention self-destruct alarm.
   */
  readLifecycleEndAt(): number | null
}

/**
 * Wake-up scheduling. Cloudflare DO alarms today; a Redis implementation
 * needs an at-least-once delayed wake-up (delayed job queue, keyspace
 * notifications + sweeper, ...) that re-runs `processor.alarm()` for the
 * window at (or after) the requested time.
 */
export type EntitlementWindowScheduler = {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/** Host runtime facilities for one window. */
export type EntitlementWindowRuntime = {
  /** Stable identifier for this window instance (DO id today); used in logs and ledger metadata. */
  instanceId: string
  /**
   * Keep a background promise alive after the current request returns
   * (ctx.waitUntil today). Post-commit wallet flushes and reservation closes
   * depend on this outliving the request.
   */
  waitUntil(promise: Promise<unknown>): void
  /**
   * Destroy ALL state for this window including any scheduled wake-up. Only
   * called after cleanup is verifiably complete (no open reservation, no
   * pending flush, no recovery flag).
   */
  destroyWindow(): Promise<void>
}

export type EntitlementWindowClock = {
  now(): number
}

/** Wallet ledger side effects the processor performs (external I/O, never inside `atomically`). */
export type EntitlementWindowWalletOps = Pick<
  WalletService,
  "captureReservationUsage" | "createReservation" | "extendReservation" | "releaseReservation"
>

/**
 * Lazy wallet access: `get()` may construct the underlying service on first
 * use so a window that never opens a reservation never opens a DB connection.
 */
export type EntitlementWindowWalletProvider = {
  get(): EntitlementWindowWalletOps
}

/**
 * Observability wrapper for one logical operation ("apply", "alarm",
 * "flush_refill", ...). The host owns drains/wide-event plumbing.
 */
export type EntitlementWindowInstrumentation = <T>(
  operation: string,
  fn: () => Promise<T>,
  baseFields?: Record<string, unknown>
) => Promise<T>

/** Environment-derived cadences (see utils.ts for the per-env values). */
export type EntitlementWindowTimingConfig = {
  /** Inactivity window after which a live reservation is closed out. */
  inactivityThresholdMs: number
  /** Max age of consumed-but-unflushed usage before a ledger-freshness flush. */
  maxFlushIntervalMs: number
}

export type EntitlementWindowProcessorDeps = {
  clock: EntitlementWindowClock
  instrument: EntitlementWindowInstrumentation
  logger: Logger
  runtime: EntitlementWindowRuntime
  scheduler: EntitlementWindowScheduler
  store: EntitlementWindowStateStore
  timing: EntitlementWindowTimingConfig
  wallet: EntitlementWindowWalletProvider
}
