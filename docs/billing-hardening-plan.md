# Billing Hardening Plan

> **Audience:** AI engineering agents picking up billing hardening work.
> **Workflow:** Each ticket has a `Status` checkbox. When you finish a ticket, flip `[ ]` → `[x]`, append a short `Resolution:` note (1 sentence), and update the dependent tickets it unblocks. Do not delete tickets — closed work is the audit trail.
> **Source:** Findings from the end-to-end audit of subscription create → ingestion → reservation → invoice → settlement on a paid-in-advance plan with arrears usage features (April 2026).
> **Scope rules:** Read `CLAUDE.md` and `docs/unprice-implementation-plan.md` first. Use-case rules are in CLAUDE.md and apply here. Do not introduce backwards-compatibility shims; this codebase is pre-GA.

---

## Architectural clarifications (applied to this plan)

These resolve audit findings without code changes. Treat as load-bearing invariants and do not violate them when implementing tickets below.

1. **Sandbox is the platform's test payment provider.** It is a first-class provider, not a stub. Webhooks against it must still be authenticated; sandbox-mode is no excuse for accepting forged events. Treat the sandbox the same as Stripe for security-relevant code (signature verification, idempotency, webhook state-machine).
2. **A customer cannot have two meters on the same feature slug — meters are collapsed by `featureSlug`.** This invalidates the audit's "double-count via stacked grants on one feature" finding. Fungibility is enforced at grant-resolution time. Tickets in this doc that reference per-stream double counting are dropped; do not reintroduce a code path that would allow two streams to consume from the same `(customerId, featureSlug)`.
3. **Plans are append-only after publish.** A published `planVersion` is immutable. New pricing = new `planVersion`. This invalidates the audit's "rating drift on retry" finding — re-running `bill-period` on the same `(subscription, period)` always rates against the same `planVersionId` it was provisioned with. Do not add a "version pin" column; the existing `planVersionId` reference on the period is the pin. Any ticket that smells like "snapshot the plan into the period" is wrong — instead, assert that all rating reads go through `planVersionId` and never through "current plan version of subscription."

---

## Severity legend

- **P0** — Money correctness, security, or stuck-state bug. Block release until fixed.
- **P1** — High user-visible failure mode but bounded by another control (idempotency, alarm-driven recovery). Fix soon.
- **P2** — Operational / reliability gap. Schedule.
- **P3** — Cleanup, observability, or hardening of an already-correct path.

---

## Tickets

### [x] HARD-001 — Sandbox webhook signature must always be verified (P0, security)

**Files:** `internal/services/src/payment-provider/sandbox.ts` (around the `verifyWebhook` impl, ~L233-258)

**Problem:** The sandbox `verifyWebhook` skips signature comparison when `webhookSecret` is falsy. An unauthenticated attacker can forge a `payment.succeeded` webhook with any `invoiceId` and trigger settlement (`settlePrepaidInvoiceToWallet`) → wallet receivable cleared without payment.

**Plan:**
1. Make `webhookSecret` required at sandbox provider configuration time. Migrate the provider config schema (`payment-provider/schema` or equivalent) so the column is `not null` and auto-generate a 32-byte secret on provider creation if missing.
2. In `verifyWebhook`, **always** compare signatures using a constant-time compare (`crypto.timingSafeEqual` over equal-length buffers — pad/encode first). Throw `InvalidWebhookSignatureError` on mismatch.
3. Add a unit test that asserts: (a) missing signature → reject, (b) wrong signature → reject, (c) correct signature → accept, (d) all comparisons use constant-time path.
4. Add an audit log line on every webhook reject (severity=warn) including `provider`, `projectId`, source IP if available.

**Acceptance:**
- Forged sandbox webhook against a project with a secret returns 401 and no DB writes occur.
- Existing sandbox tests still pass without exposing the secret in fixtures.

**Resolution:** Sandbox webhook authentication is now per-project, operator-configured, and always verified. (1) Removed the shared `SANDBOX_WEBHOOK_SECRET` constant and the `resolveSandbox` special-case in `PaymentProviderResolver`; sandbox now flows through the same `paymentProviderConfig` lookup as Stripe, so the operator-set webhook secret from the existing `saveConfig` UI is what authenticates webhooks. Cross-tenant forgery is closed because each project resolves to its own DB-encrypted secret. (2) `SandboxPaymentProvider.verifyWebhook` now rejects when the secret is unset, the signature is missing, or the signature mismatches; comparison uses `node:crypto.timingSafeEqual`. (3) Reject paths log a warn-level audit line. (4) New tests cover: missing-secret-not-configured, missing-signature, wrong-signature, length-mismatch, header-vs-arg signature, and per-project isolation (project A's secret cannot authenticate a project B webhook and vice versa). The schema column `webhookSecret` stays nullable (existing Stripe behavior); enforcement happens at verify time, which is when the security boundary actually matters.

---

### [x] HARD-002 — Concurrent webhook re-delivery race in `applyWebhookEvent` (P0, money correctness)

**Files:** `internal/services/src/use-cases/payment-provider/process-webhook-event.ts` (the dedup gate, ~L450-514, and `applyWebhookEvent` callsite ~L509-514)

**Problem:** The dedup gate accepts a re-entry when `status='processing'` (intentional, to allow retries after a worker crash). Two simultaneously-delivered identical webhooks can both pass that gate and both call `applyWebhookEvent`. Ledger settlement is idempotent (good), but `reconcilePaymentOutcome` and the invoice-status `update` are not guarded → state-machine race.

**Plan:**
1. Promote the dedup gate to a `SELECT ... FOR UPDATE` row-lock on the `webhook_events` row scoped to `(projectId, provider, providerEventId)`. The second concurrent caller blocks; when it acquires the lock, the first has already moved status to `processed` or `failed` and the second exits as `duplicate`.
2. Wrap the *entire* `applyWebhookEvent` body — not just the SELECT — in the same transaction that holds the row lock. If the work is too long for one tx, instead use `pg_advisory_xact_lock(hashtext('webhook:' + projectId + ':' + provider + ':' + eventId))` at the top of `applyWebhookEvent` and let the lock release at tx commit.
3. Guard the invoice update with a state-machine assertion: `UPDATE invoices SET status='paid' WHERE id=? AND status IN ('finalized','past_due')`. Reject (and log) if zero rows updated. Same pattern for dispute reversal.
4. Add a concurrency test: spawn two simultaneous `applyWebhookEvent` calls for the same eventId and assert exactly one performs the side effects.

**Acceptance:** Two concurrent identical webhooks → one applies, one returns `duplicate`, no double state transition.

**Resolution:** Wrapped the entire dedup gate + `applyWebhookEvent` body in a single `deps.db.transaction(...)` and serialized concurrent re-deliveries with `pg_try_advisory_xact_lock(hashtext('webhook:projectId:provider:providerEventId'))` at the top of the tx (`process-webhook-event.ts`). Two simultaneous deliveries now race only at the lock: one acquires and runs end-to-end, the other returns `duplicate` immediately with **zero** DB writes (no INSERT into `webhook_events`, no invoice update, no `settleReceivable`, no `reconcilePaymentOutcome`). Re-deliveries arriving after the original commits hit the same lock, then see `status='processed'` inside the tx and bail. Replaced unguarded `updateInvoice` calls with a new repo method `updateInvoiceIfStatus(allowedFromStatuses)` that filters by current status: `payment.succeeded` only transitions from `{draft, waiting, unpaid, failed}`, `payment.dispute_reversed` from `{unpaid, failed}`, `payment.failed` from `{draft, waiting, unpaid, failed}`, `payment.reversed` from `{paid}`. When the conditional update returns 0 rows (invoice already in target state or in a disallowed state), the handler logs a `warn` and skips downstream side effects; both `settleReceivable` and `reconcilePaymentOutcome` are already idempotent, but skipping is cleaner and gives operators a clear "late delivery" signal. The retry-after-failure path (status='failed' on the existing row) is preserved through the same lock — only one retry can claim it at a time. Tests: existing 7 scenarios kept, plus 2 new — concurrent-lock-rejection asserts no writes occur for the loser; state-machine-guard asserts that a `payment.succeeded` for an already-`paid` invoice neither calls `settleReceivable` nor `reconcilePaymentOutcome`. All 255 services tests pass.

---

### [ ] HARD-003 — `bill-period` invoice INSERT/SELECT is non-atomic (P0, money correctness)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (invoice creation block ~L279-321), `internal/services/src/billing/repository.drizzle.ts` (`createInvoice` / `findInvoiceByStatementKey`)

**Problem:** The flow is `INSERT ... ON CONFLICT DO NOTHING` (returns `null` on conflict) → if `null` then `SELECT` by statement key. There's a window where the existing row could be missing (e.g., concurrent finalize/delete in another path), in which case the function silently returns and leaves periods in `pending` state. Re-runs may create duplicates.

**Plan:**
1. Replace the two-step pattern with a single `INSERT ... ON CONFLICT (projectId, subscriptionId, customerId, statementKey) DO UPDATE SET updated_at = now() RETURNING *`. The `DO UPDATE` is a no-op-ish update that guarantees `RETURNING` always returns the row (existing or new).
2. Move the entire bill-period section that posts ledger entries → creates invoice → marks periods `invoiced` into a single Postgres transaction with `pg_advisory_xact_lock(hashtext('bill:' + statementKey))` at the top. This both serializes re-runs and guarantees atomicity. Note: this is a larger change than #1; #1 is the minimum fix.
3. Add a test: run two `billPeriod` calls concurrently for the same `(subscription, statementKey)` → exactly one invoice row exists, all periods marked `invoiced`, ledger entries posted exactly once.
4. Add a sweeper alert (P3, separate ticket): if any `billing_periods` row is `pending` and `cycleEndAt < now - 24h`, page on-call.

**Acceptance:** No code path can return early-success after the INSERT step without having a confirmed invoice row in hand.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-004 — `bill-period` ledger source ID idempotency must be verified (P0, money correctness)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (ledger transfer at ~L176-190), `internal/services/src/ledger/` (gateway)

**Problem:** Ledger transfer source ID is constructed from `period.id`. If `bill-period` re-runs after a partial failure (ledger posted, invoice creation crashed), the same period rows are picked up again. We *believe* the ledger gateway dedupes on source ID, but it's not covered by a test — and HARD-003's atomicity fix doesn't strictly close the window without HARD-004 being verified.

**Plan:**
1. Read `internal/services/src/ledger/gateway.ts` (or equivalent) and confirm the dedup semantics: it should be `(sourceType, sourceId)` unique. Document in a code comment near the gateway's `createTransfer` what the dedup contract is.
2. Add a unit test in `internal/services/src/billing/service.rating.test.ts` (or a sibling) that calls `billPeriod` twice for the same period and asserts ledger entries posted exactly once.
3. If dedup is not on `(sourceType, sourceId)`, add it. The current source ID format must include the `statement_key` so that two separate periods with the same `period.id` (shouldn't happen, but defensive) don't collide.
4. Once verified, mark this ticket complete; HARD-003 can land safely without it but HARD-004 is the proof.

**Acceptance:** Test demonstrates double-`billPeriod` produces single ledger entry per period.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-005 — Wire `finalizeInvoice` between draft creation and settlement (P0, money collection)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (post-invoice-creation), `internal/services/src/payment-provider/service.ts` (existing `finalizeInvoice` method ~L169-173)

**Problem:** The audit found no caller for `paymentProviderService.finalizeInvoice`. For Stripe, an invoice in `draft` is invisible to the customer and never collected. If this is genuinely missing, the system is silently failing to charge for arrears periods.

**Plan:**
1. **Verify first.** Grep for `finalizeInvoice` callers across `apps/`, `internal/jobs/`, and `internal/services/`. If a caller exists in a job or webhook path and only the bill-period inline call is missing, document the existing flow at the top of this ticket and adjust the plan.
2. If not wired: add a `finalizeInvoice` step to `bill-period.ts` after the invoice row is created and before returning. Use the same provider context as the rest of the use case. Failure of finalize should mark the invoice `finalize_failed` (new status) and emit a job for a retry sweeper.
3. For sandbox, `finalizeInvoice` is a no-op (returns `{status: 'finalized'}` synchronously).
4. Add a sweeper job at `internal/jobs/src/trigger/schedules/finalize-invoices.ts` that finds invoices in `draft` state older than 1h and retries finalize with exponential backoff (max 5 attempts, then page).
5. Test: full path from `billPeriod` → finalize → settle on sandbox. Invoice ends in `paid`, all states transitioned through.

**Acceptance:** No invoice can sit in `draft` past 1h without either being finalized or surfacing in an alert.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-006 — Settlement failure after `invoice.status='paid'` has no retry (P0, money correctness)

**Files:** `internal/services/src/use-cases/payment-provider/process-webhook-event.ts` (~L229-280), `internal/services/src/use-cases/billing/settle-invoice.ts`

**Problem:** Webhook flow: update invoice to `paid` → call `settlePrepaidInvoiceToWallet`. If the wallet ledger transfer fails (gateway down, lock contention), the webhook is logged failed and **never retried**. The invoice is `paid`, the customer's receivable is unsettled, the next period's billing starts from a wrong wallet state. Manual replay only.

**Plan:**
1. Reorder: do the wallet `settleReceivable` ledger transfer **first** (in the webhook tx), then update `invoice.status='paid'` in the same tx. Both ops are idempotent already; doing them in this order means a partial failure leaves invoice in `finalized` (so the webhook retry path picks it up cleanly) instead of "paid but unreconciled."
2. Replace "log and exit" on settlement failure with throwing an error that the webhook framework will retry. Confirm the webhook handler's outer harness retries `failed` rows (it should — read `apps/api/src/routes/paymentProvider/providerWebhookV1.ts`). If not, add a sweeper job in `internal/jobs/src/trigger/schedules/` that polls `webhook_events WHERE status='failed' AND attempts < N` and re-enqueues.
3. Add a state-machine assertion (mirrors HARD-002): `reconcilePaymentOutcome` must be a no-op if the subscription is already in the target state. Idempotency by inspection.
4. Test: inject a wallet ledger failure mid-webhook, assert the webhook is left retryable and invoice stays `finalized` (not `paid`).

**Acceptance:** No code path produces "invoice=paid AND receivable unsettled" as a terminal state.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-007 — `activateWallet` failure leaves paid plan in broken active state (P0, customer impact)

**Files:** `internal/services/src/use-cases/subscription/create.ts` (~L89-114), `internal/services/src/use-cases/billing/provision-period.ts` (catch block ~L164-181)

**Problem:** `createSubscription` runs `activateWallet` after the create transaction commits. Failure is logged but non-fatal. For a paid plan, this leaves `status='active'` with no grants issued — the customer's first event is denied with `WALLET_EMPTY` and they have no path to recover without operator intervention. Also, `provision-period.ts`'s catch only handles `ActivationAbortError`; generic infra exceptions escape uncaught, leaving subscription persisted but inconsistent.

**Plan:**
1. In `provision-period.ts`, broaden the catch to `catch (err)` (any error). Wrap non-`ActivationAbortError` instances in a new `ActivationFailedError`. The transaction should already roll back; ensure no DDL/connection state leaks.
2. In `create.ts`, treat `activateWallet` failure for paid plans as fatal: roll back the subscription create (or, if already committed, mark `status='activation_failed'` and emit a job to retry). For free plans (no grants needed) keep it non-fatal.
3. Decide between rollback-on-failure vs activation-retry job. Recommendation: retry job. Reasons: (a) the subscription record is useful for support visibility, (b) the user may already have a Stripe customer mapping that we don't want to throw away, (c) retries are bounded and observable.
4. Add a new state `pending_activation` to the subscription state machine. Block all event ingestion while in this state (return a typed error to the customer's API client). The retry job promotes to `active` on success.
5. Test: simulate `walletService.adjust` failure on grant #2 of 3 → subscription left in `pending_activation` with no grants posted, retry job picks it up, all 3 grants posted on retry.

**Acceptance:** No code path produces "subscription=active with paid plan AND no grants."

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-008 — Tinybird flush has no retry, no DLQ, and 30-day SQLite TTL drops data (P1, analytics correctness)

**Files:** `apps/.../EntitlementWindowDO.ts` (`flushToTinybird` ~L1565-1600, alarm logic ~L743-967, outbox table ~L545-550)

**Problem:** When `analytics.ingestEntitlementMeterFacts` fails, the function returns `false`, the alarm logs and exits, and the outbox rows stay in SQLite. There is no exponential backoff, no escalation, no metric. After 30 days post-period the DO can `deleteAll()` itself with rows still unflushed. Tinybird outage > 30 days → permanent data loss for analytics (note: not money — the ledger is independent).

**Plan:**

1. **Add structured retry state to the DO.** New SQLite columns/keys on a `flush_state` row: `consecutiveFailures INT`, `lastErrorAt TIMESTAMP`, `nextRetryAt TIMESTAMP`, `lastErrorMessage TEXT`.
2. **Exponential backoff with jitter.** Compute next alarm: `min(30m, 30s * 2^min(failures, 6)) + random(0, 30s)`. On success, reset `consecutiveFailures=0`. The normal alarm cadence (30s/5m) only applies when there is no active backoff.
3. **Self-protect against the 30-day deletion.** In the deletion path (~L917-923), refuse to delete if `outbox` is non-empty *or* `consecutiveFailures > 0`. Instead, schedule an alarm 1h out and surface a metric.
4. **Surface health.** Emit a wide-event log line on every flush: `{customerId, projectId, streamId, periodKey, batchSize, durationMs, success, consecutiveFailures, errorMessage?}`. Wire a Tinybird/Grafana alert on `consecutiveFailures > 5`.
5. **Operator escape hatch.** Add an admin RPC `forceFlushDO(streamKey)` that takes a single DO and flushes its outbox synchronously, returning the result. Useful for incident recovery.
6. **Long-tail backstop.** Add a worker that scans `entitlement_reservations WHERE period_end_at < now - 7d AND reconciled_at IS NULL` and pings the corresponding DO to flush. This catches DOs that went quiet after a flush failure and aren't being driven by ingestion.
7. **Decision needed (escalate, do not silently choose):** if Tinybird is down for the entire backoff window (e.g., 24h), do we (a) accept the analytics gap and continue, or (b) fail closed and stop accepting events? Default: (a). Document the decision in this ticket before flipping the box.

**Acceptance:**
- Inject a Tinybird outage of 1h → all facts eventually arrive after recovery.
- Outage of 30d+ → no data loss; outbox preserved; alert fires.
- Test exists for the backoff schedule and the deletion-refusal logic.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-009 — Mid-cycle subscription cancellation strategy: ping all DOs (P0, money correctness)

**Files:** `internal/services/src/use-cases/subscription/cancel.ts` (create if missing), `internal/services/src/wallet/service.ts` (`flushReservation` final path), DO `EntitlementWindowDO.ts` (`finiteFlush`/`closeReservation`), `internal/db/src/schema/entitlementReservations.ts`

**Problem:** Today, when a subscription is cancelled mid-cycle, reserved funds sit in the `reserved` ledger account until the DO's 24h-inactivity alarm fires its final flush. This is up to 24h of cash in customer-visible limbo, with the subscription appearing "cancelled" in the UI but the wallet still showing the hold. There is no explicit "cancellation → flush now" hook.

**Strategy.** The reservations table is already the index of truth for which DOs are open per customer. Use it.

**Plan:**

1. **State machine.** Add a `cancelling` status to the subscription state machine, between `active` and `cancelled`. While in `cancelling`:
   - Ingestion adapter rejects new events for that subscription with a typed `SUBSCRIPTION_CANCELLING` error (non-retryable).
   - The cancel use case is responsible for transitioning to `cancelled` only after all reservations are reconciled.

2. **Find the open reservations.**
   ```sql
   SELECT id, project_id, entitlement_id, period_start_at
   FROM entitlement_reservations
   WHERE customer_id = $1
     AND project_id = $2
     AND reconciled_at IS NULL
   ```
   This is the existing `entitlement_reservations_customer_idx` plus the active partial index. No new index needed.

3. **Derive DO IDs and dispatch close.** The DO routing key is `(projectId, customerId, entitlementId, periodStartAt)` — same fields the reservation row holds. For each row, derive the DO stub and call a new RPC `closeReservation(reason: 'subscription_cancelled')` on the DO.
   - The DO must:
     a. Set internal state to `closing` so concurrent `apply()` calls fast-reject with `SUBSCRIPTION_CANCELLING`.
     b. Call `finiteFlush(final=true)` — flush all outstanding consumption to ledger, refund remainder via `wallet.flushReservation(final=true)`, mark `reservation.reconciledAt = now`.
     c. Return `{ ok: true, refunded, finalConsumed }`.

4. **Use-case orchestration.** New use case `internal/services/src/use-cases/subscription/cancel.ts`:
   ```
   cancelSubscription(deps, { subscriptionId, projectId, reason })
     1. Tx: subscription.status = 'cancelling'
     2. Read open reservations (above query)
     3. For each: dispatch closeReservation RPC. Collect results.
     4. If all ok → subscription.status = 'cancelled', cancelledAt = now
     5. If any fail → subscription stays 'cancelling', failures emit a row in
        `cancellation_retries(subscriptionId, reservationId, lastError, attempts)`
   ```
   Concurrency: run RPCs in parallel with bounded fan-out (e.g., `pLimit(10)`). Cancellation latency for a customer with 10s of streams should be sub-second.

5. **Failure recovery — the sweeper.** New cron job `internal/jobs/src/trigger/schedules/cancellation-sweeper.ts`, runs every 5 minutes:
   ```
   For each subscription in 'cancelling' for > 5 minutes:
     For each reservation still open:
       Re-dispatch closeReservation
     If success on all → flip to 'cancelled'
   ```
   Bounded retry attempts (e.g., 20 attempts over ~24h); after exhaustion, page on-call. Reservations with persistent close failures need human inspection (likely a stuck DO).

6. **Race with in-flight events.** When `closeReservation` RPC arrives at the DO mid-`apply()`:
   - The DO is single-threaded per instance — the RPC queues behind the apply. Good.
   - If the apply triggered a refill that's now mid-flight (`waitUntil`), `closeReservation` must wait for it. Add an `await` on the in-flight refill promise before final flush.

7. **Tests.**
   - Cancel mid-period with 3 open streams → all 3 reconciled, wallet refund posted, subscription `cancelled` within seconds.
   - Cancel while one DO is unreachable → subscription stuck in `cancelling`, sweeper retries, succeeds when DO recovers.
   - Cancel while events are arriving → events post-cancel are rejected with the typed error.
   - Cancel during in-flight refill → final flush waits, no double-spend.

**Acceptance:** Mid-cycle cancellation completes within seconds for healthy DOs; no reserved funds linger past sweeper SLA (15 min).

**Open questions for human review:**
- Should cancellation be refundable in real time (immediate ledger refund) or only at next billing cycle close? Default proposed: real-time refund.
- Should `closeReservation` be exposed beyond the cancel path (e.g., for plan downgrades)? Likely yes; design the RPC for reuse.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-010 — Reservation sizing strategy for large single-event costs (P1, customer impact)

**Files:** `internal/services/src/wallet/reservation-sizing.ts`, `apps/.../EntitlementWindowDO.ts` (`bootstrapReservation`, `computeMarginalPriceMinor` ~L1328-1454), `internal/services/src/wallet/local-reservation.ts`

**Problem:** A single event whose marginal cost exceeds `refillChunkAmount` is denied with `WALLET_EMPTY` even though the wallet has plenty of balance. Common trigger: tier boundaries with flat fees (e.g., $1 onboarding fee on first unit), price spikes, multi-unit events. Today's sizing assumes uniform pricing.

**Strategy — pick (b) as the primary fix, with (a) as a defense-in-depth probe.**

**(a) Probe worst-case event price at sizing time.** Cheap, deterministic, but only catches what the pricing model declares.
1. At reservation bootstrap, `reservation-sizing.ts` already knows the priceConfig. Walk the tier list: for each tier transition within the period's expected usage range, compute the per-unit cost at the boundary (including any flat fees). Take the max.
2. Set `refillChunkAmount = max(baseChunk, 2 * worstCaseEventCost)`. The 2× headroom absorbs two consecutive worst-case events without round-trips.
3. This is bounded and runs once per period — no perf cost.

**(b) Adaptive bump on denial.** Closes the gap when the event cost exceeds even the probed worst case (e.g., volume discounts that flip sign, batch events).
1. In `LocalReservation.applyUsage`, if `cost > remaining + refillChunkAmount` (i.e., one refill won't cover it), don't deny outright. Instead emit a `BUMP_REQUIRED` decision with `requestedChunk = ceil(cost * 1.5 / chunkUnit) * chunkUnit`.
2. The DO triggers an immediate refill with the bumped chunk size, persists `refillChunkAmount = bumped` to the reservation row (monotonic increase only — never shrink mid-period), then re-applies the event in the same `apply()` call.
3. Bound the bump: cap at e.g., `min(walletBalance, 100 * baseChunk)`. If still insufficient, fall through to denial.
4. Idempotency: the re-apply uses the same `idempotencyKey`. The first call's `BUMP_REQUIRED` outcome is *not* persisted to the idempotency table — only the final `accepted`/`denied` is.

**(c) Pre-fund tier flat fees at activation.** Specific case: onboarding fees, first-unit charges. Treat these as advance fees baked into the activation invoice rather than runtime usage. Out of scope for this ticket; track separately if the team decides to support it.

**Plan:**
1. Implement (a) in `reservation-sizing.ts`. Add a `worstCaseEventCost` field to the sizing result for observability.
2. Implement (b) in `LocalReservation` and the DO. New decision type, new code path in `EntitlementWindowDO.apply()`.
3. Tests:
   - Event cost = 0.5× chunk → accepted normally.
   - Event cost = 2× chunk → bump triggered, accepted, chunk size grows.
   - Event cost = 1000× wallet balance → denied with clear `INSUFFICIENT_FUNDS` error.
4. Remove the TODO at `EntitlementWindowDO.ts` ~L663-664; this ticket resolves it.
5. Surface the bump in the audit log and in customer-facing usage telemetry (so operators can see "this customer's events trigger frequent bumps — the plan's chunk sizing is wrong").

**Acceptance:** No event with cost ≤ wallet balance is denied due to chunk sizing.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-011 — 30-day idempotency window vs. DLQ retention: tighten ingestion-side cap (P1, money correctness)

**Files:** `apps/.../EntitlementWindowDO.ts` (`MAX_EVENT_AGE_MS` ~L788-808), `internal/services/src/ingestion/service.ts` (event acceptance), `internal/services/src/ingestion/message.ts`

**Detailed explanation of the issue (per request):**

Each event carries an `idempotencyKey` (typically `eventId` or a hash). Two layers cache it:

1. **Batch-level dedup** in `ingestion/message.ts` — short-lived, per-batch only.
2. **Audit DO and EntitlementWindowDO SQLite** — persist `(idempotencyKey → outcome)` rows so that retries replay deterministically.

The DO sweeps SQLite idempotency rows when their event timestamp is older than `MAX_EVENT_AGE_MS = 30 days`. The reasoning is straightforward: SQLite would grow unbounded, and "events" are bounded by billing periods so 30 days is a generous safety margin past any realistic in-flight window.

**The hole:**

- Cloudflare Queues retain failed messages for up to 14 days (current limits; check at fix time).
- A trigger.dev DLQ can retain longer (configurable; could be 30+ days).
- Operators replaying a DLQ after a long incident, or backfill jobs sending events with old timestamps, can submit an event whose `idempotencyKey` was already processed but has been swept from the DO.
- The DO sees a "fresh" event, processes it, prices it, posts to ledger → **double-charge for the same event**.

**Realism:** Medium. Triggered by:
- Operator running a manual replay after a multi-week outage (rare but plausible).
- A backfill tool submitting historical events for a new customer migration.
- A bug in the producer that defers events (e.g., batch upload of months-old IoT data).

**Strategy.** The cleanest fix is to make the *acceptance* contract narrower than the *idempotency* window, so the dedup table is always wide enough to catch any event we'd accept.

**Plan:**

1. **Hard-cap event acceptance at ingestion.** In `ingestion/service.ts`, reject any event whose `timestamp < now - 25 days` (ingestion-cap, a margin under the DO's 30-day idempotency window). Return a typed `EVENT_TOO_OLD` error that is **non-retryable** so it doesn't bounce in queues. Make the cap a config knob `INGESTION_MAX_EVENT_AGE_MS` defaulting to 25 days.
2. **Asymmetry by design.** Document the invariant: `INGESTION_MAX_EVENT_AGE_MS < DO_IDEMPOTENCY_TTL_MS`. Add an assertion at service init that fails fast if these are misconfigured.
3. **Backfill escape hatch.** Add an admin-only ingestion endpoint `ingestHistorical` that accepts old events but routes them to a separate processing path (no DO, direct insert to Tinybird, no billing impact). Customers explicitly opt in for migrations; events ingested through this path are flagged `historical=true` and never billed.
4. **Operator runbook.** Document the policy: DLQ replays older than the cap must be either (a) discarded with explicit operator sign-off, or (b) routed through the historical endpoint after billing-impact review.
5. **Telemetry.** Log every `EVENT_TOO_OLD` rejection with rich context (`projectId`, `customerId`, `eventTimestamp`, `now`). Operators need to see when this triggers — it's a strong signal of a DLQ drain or producer bug.
6. **Tests.**
   - Event with timestamp in window → accepted.
   - Event with timestamp 26d old → rejected with `EVENT_TOO_OLD`, no DO touched.
   - Replay of already-processed event within window → idempotency hit, no double-process.

**Acceptance:** No event accepted by ingestion can ever fall outside the DO's idempotency window. The asymmetry is asserted at startup.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-012 — DB connection per DO mitigation (P2, scalability)

**Files:** `apps/.../EntitlementWindowDO.ts` (`getWalletService` ~L1488-1507), `internal/services/src/wallet/service.ts`, possibly new `apps/api/src/routes/internal/wallet.ts`

**Problem:** `getWalletService()` opens a fresh `pg`/`postgres-js` connection on first use per DO instance. With many concurrent DOs (think: thousands of customers ingesting at once), this is N connections to Postgres regardless of pool config — Postgres's `max_connections` becomes the platform's effective concurrency cap.

**Strategies (ordered by recommended adoption).**

**(1) Cloudflare Hyperdrive — primary mitigation.** [recommended]
- Hyperdrive sits between Cloudflare Workers/DOs and Postgres, pooling connections regionally. From the DO's perspective it's still "open a connection," but Hyperdrive multiplexes onto a small backend pool.
- Effort: low. Provision Hyperdrive, swap the connection string. The driver stays the same.
- Tradeoff: requires Cloudflare; ties this layer to Hyperdrive's availability.

**(2) Front Postgres with PgBouncer (transaction-mode) or Supabase pooler.** [fallback if Hyperdrive isn't viable]
- Each DO opens a TCP socket to PgBouncer; PgBouncer checks out a backend connection per *transaction* (not per session).
- Works with any Postgres driver. Some prepared-statement / `LISTEN`/`NOTIFY` features break — verify drizzle is compatible (it generally is in transaction mode).
- Effort: medium. Self-host or use managed.

**(3) Move wallet writes off the DO hot path.** [structural; longer-term]
- DO calls a Worker (or use case directly via HTTP) → Worker holds a single shared pool → posts to Postgres.
- Adds one network hop per refill but collapses N DOs to 1 pool.
- Worth it once Hyperdrive/PgBouncer are saturated, not before.
- Effort: high. Touches the reservation flow.

**(4) Batched flushes via Cloudflare Queues.** [structural, defers writes]
- Instead of DO writing to wallet on refill, DO emits a queue message; a single consumer worker batches writes.
- Tradeoff: refill becomes async, which conflicts with the in-tx refill check the DO does today (line ~499). Would require redesigning the DO's reservation contract.
- Probably overkill before the first three are exhausted.

**(5) Connection cap / semaphore.** [bandage]
- Add a global semaphore (Durable Object as a counter) that gates concurrent DO→Postgres connections to N. Excess DOs wait or fail-fast.
- Buys time but doesn't fix the root cause.

**Recommendation: (1) now, (2) as backup, (3) when growth demands it. Do NOT do (4) or (5) without explicit team buy-in.**

**Plan:**
1. Provision Hyperdrive in staging. Swap the wallet service's connection string. Run a load test of 1000 concurrent DOs each performing one refill; confirm Postgres backend connection count stays bounded (~50 instead of ~1000).
2. Document the connection topology in `docs/billing-pipeline.md` or a new `docs/connection-topology.md`.
3. Add a metric `pg_backend_connections_active` to the platform dashboards.
4. Add a runbook entry: "If Hyperdrive is degraded, fall back to direct Postgres with rate-limited DO ingestion."
5. (3) is a separate ticket; do not implement here.

**Acceptance:** 1000-DO load test shows Postgres backend connections stay below 100; DO-side latency for refill is within 50ms p99 of pre-Hyperdrive baseline.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-013 — Provider-agnostic, webhook-independent payment state machine (P1, reliability)

**Files:** new `internal/services/src/payment-provider/state-machine.ts` (or extend existing), `internal/jobs/src/trigger/schedules/invoice-reconciler.ts` (new), `internal/services/src/use-cases/payment-provider/process-webhook-event.ts`, `internal/services/src/payment-provider/service.ts`

**Question (per request):** Is there a meta-flow for handling the payment flow independent from the payment provider and webhook based?

**Answer (current state):** Partially. The `PaymentProviderInterface` is provider-agnostic (15 normalized methods). But the invoice's *progression* (draft → finalized → paid) is driven entirely by webhooks today. If a webhook is dropped, the invoice is stuck. There is no pull-based reconciler.

**The fix is to make the invoice state machine the source of truth and let multiple drivers advance it.** This is a known-good pattern from production billing systems (Stripe Sigma's reconciler, Lago's polling fallback).

**Design:**

```
                    +---------+
                    |  draft  |
                    +----+----+
                         | finalize() — push or pull
                         v
                  +-------+-------+
                  |  finalized    |
                  +---+--------+--+
       webhook payment.succeeded  |  reconciler poll says paid
       (push, fast path)    |     |     (pull, safety net)
                            v     v
                     +--------+--------+
                     |      paid       |
                     +--------+--------+
                              |
                              v
                       +-------+-------+
                       |   settled     |  (wallet receivable cleared)
                       +---------------+

  Same applies for failure → past_due → cancelled.
```

**Drivers (any of which can advance state, all idempotent):**
1. **Webhook (push)** — `process-webhook-event.ts`. Fast path. Today's primary.
2. **Reconciler (pull)** — new cron, every 10 minutes for invoices `finalized` for > 5 minutes. Calls `paymentProviderService.getInvoice(providerInvoiceId)`, applies the resulting state transition.
3. **Manual (operator)** — admin endpoint to force a state transition (with audit log). Used for stuck invoices.
4. **Sandbox (synchronous)** — for sandbox provider, the "webhook" is fired inline by `collectPayment`. No async layer.

**Plan:**

1. **Lift the state machine into a typed module.** New file `internal/services/src/payment-provider/invoice-state-machine.ts`:
   - `InvoiceStatus` enum.
   - `transition(current, event) → next | error`.
   - Transition table is the only source of legal moves; both webhook and reconciler call this same function.
2. **Extend `PaymentProviderInterface` with `getInvoice(providerInvoiceId)`** if not present. It returns the normalized status + payment state. This is the pull primitive.
3. **Reconciler cron.** New file `internal/jobs/src/trigger/schedules/invoice-reconciler.ts`. Runs every 10 minutes:
   ```
   For each invoice WHERE status IN ('finalized', 'past_due') AND last_state_check < now - 5min:
     status = paymentProviderService.getInvoice(invoice.providerInvoiceId)
     event  = mapProviderStatusToInvoiceEvent(status)
     transition(invoice, event)  -- idempotent
     update invoice.last_state_check = now
   ```
4. **Refactor webhook handler** to call the same `transition` function instead of mutating `invoice.status` directly. The state-machine assertion replaces the ad-hoc guards proposed in HARD-002 and HARD-006.
5. **Sandbox-specific path.** Sandbox `collectPayment` inline-fires the equivalent of the webhook via the same state machine. No async layer, no race.
6. **Observability.** Wide event log line on every transition: `{invoiceId, from, to, driver: 'webhook'|'reconciler'|'manual', providerEventId?}`. Easy to answer "which driver advanced this invoice" in incident review.
7. **Tests.**
   - Unit: state-machine table — every legal transition, every illegal transition rejected.
   - Integration: drop a webhook, reconciler picks up the change within 10 min.
   - Integration: webhook + reconciler arrive simultaneously, state remains consistent.

**Acceptance:** Invoices cannot be stuck waiting on a webhook. The reconciler picks up missed transitions within SLA. State changes are auditable to a single driver per transition.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-014 — Audit DO commit is fire-and-forget after message ack (P2, audit correctness)

**Files:** `internal/services/src/ingestion/service.ts` (`commitToAuditAsync` ~L715-719, `commitOutcomesToAudit` ~L609-617)

**Problem:** Ingestion processes a message, decides outcomes, then queues the audit DO write via `waitUntil`. The queue message is ack'd before the audit DO row exists. If the audit write fails after ack, the audit shard never reflects the event but billing already ran. Audit DO is supposed to be the cross-period correctness boundary; it shouldn't be racy with ack.

**Plan:**
1. Make `commitOutcomesToAudit` synchronous: await it before acking the queue message. Move it inside the message handler's main path.
2. If the audit DO write fails, throw — let the queue retry the whole message. Outcomes computed in the previous attempt will be re-computed (idempotency at the DO and ledger layers makes this safe).
3. Test: inject audit DO failure → message is retried; on second attempt audit row is created, no double-billing observed.
4. Measure: this adds one DO round-trip to the hot path. Confirm latency budget. If too slow, fall back to a "two-phase commit" pattern: write a pending-commit row to Postgres synchronously, then async-confirm to audit DO. But default to the simpler synchronous approach first.

**Acceptance:** No queue ack occurs without a confirmed audit row.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-015 — Late-arriving events for closed periods are silently dropped (P1, money correctness)

**Files:** `internal/jobs/src/trigger/schedules/invoicing.ts` (~L36), `internal/services/src/use-cases/billing/bill-period.ts`, ingestion path

**Problem:** Period closes on `cycleEndAt <= now` and is rated immediately. An event with timestamp inside the closed period that arrives after close (network delay, retry, queue lag) is not aggregated — the DO has flushed and reconciled, ingestion still routes the event to a DO for the now-closed period, and either it errors out or it lands in a freshly bootstrapped reservation for the wrong period.

**Plan:**

1. **Grace window.** Delay period close by a configurable `LATE_EVENT_GRACE_MS` (default: 1h). Change the invoicing cron query to `cycleEndAt <= now - LATE_EVENT_GRACE_MS`. This catches the long tail of slow producers.
2. **Late-event policy.** Document and enforce: events arriving after close + grace are routed to the *next* open period for the same `(customer, feature)`. Never mutate a closed period. Implementation: ingestion adapter compares `event.timestamp` to the subscription's `currentCycleStartAt/EndAt`; if the event is for a closed window, it's logged with `late_event=true` and routed to the current period (or rejected via HARD-011's policy if too old).
3. **Telemetry.** Log every late-event routing: `{eventId, originalPeriod, routedToPeriod, lagMs}`. Operators need to see whether late events are a one-off or systemic.
4. **Edge case:** customer cancels mid-period, event arrives after cancellation. With HARD-009 in place, the subscription is `cancelled`; route the event to a `cancelled_subscription_late_events` table (or just reject) — discuss with product.
5. Tests:
   - Event arriving 30min after close, grace = 1h → captured in the closing period.
   - Event arriving 2h after close, grace = 1h → routed to next period.
   - Event arriving for cancelled subscription → rejected/quarantined per policy.

**Acceptance:** Producers up to `LATE_EVENT_GRACE_MS` lagged are billed correctly without operator intervention.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-016 — `pastDueAt` computed but never enforced; no dunning (P1, money collection)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (~L271-277), `internal/services/src/subscriptions/machine.ts` (`PAYMENT_FAILURE` ~L684-712), new `internal/jobs/src/trigger/schedules/dunning.ts`

**Problem:** Failed payment transitions the subscription to `past_due` but no follow-up is wired. The customer is neither retried automatically nor cancelled at grace expiry. Revenue stuck.

**Plan:**

1. **Decision needed first:** What's the dunning policy? Common defaults:
   - Day 1, 3, 7 retry charges; cancel on day 14.
   - Email customer on each retry.
   - Move subscription to `cancelled` (or `paused`) at expiry.
   Document the policy in this ticket before writing code.
2. **Schedule cron.** New `dunning.ts` runs hourly. For each subscription `past_due`:
   - Compute days since `pastDueAt`.
   - If today is a retry day, call `paymentProviderService.collectPayment` (idempotent on invoice ID).
   - If past grace expiry, transition to terminal state (`cancelled` or `paused`).
3. **Email integration.** Out of scope here; track in a separate ticket. For now, emit an event to the audit log.
4. **Customer reactivation.** Document the path: after failed dunning, customer pays out-of-band → operator runs `reactivateSubscription` → status flips back to `active`, new period begins.
5. Tests for each transition.

**Acceptance:** No invoice in `past_due` for longer than the policy without an automated state transition.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-017 — Multi-phase grant derivation reads first phase without ordering (P2, correctness)

**Files:** `internal/services/src/use-cases/billing/derive-provision-inputs.ts` (~L89)

**Problem:** Grant derivation queries phases with `limit:1` and no `orderBy`. Newly-created subscriptions today only have one phase, but multi-phase subs (plan changes, scheduled upgrades) will be a real case.

**Plan:**
1. Change the phase fetch to: filter by phase active at `now` (`startAt <= now AND (endAt IS NULL OR endAt > now)`), order by `startAt DESC`, limit 1.
2. Add a code comment near the query stating the active-phase contract.
3. Add a test with a subscription that has a past phase and an active phase; assert the active one is used.

**Acceptance:** Derivation never reads a non-active phase.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-018 — Subscription create idempotency (P2, reliability)

**Files:** `internal/services/src/use-cases/subscription/create.ts`

**Problem:** No idempotency key on the create-subscription input. Duplicate POST creates two subscriptions for the same customer.

**Plan:**
1. Add optional `idempotencyKey: string` to the create-subscription input type. Adapter (tRPC/Hono) passes through any client-supplied `Idempotency-Key` header.
2. Persist into a `subscription_idempotency(idempotencyKey, projectId, subscriptionId)` table with unique index on `(projectId, idempotencyKey)`.
3. On create: insert into idempotency table first; on conflict, look up and return the existing subscription.
4. Test: two parallel creates with same key → one subscription created, both calls return it.

**Acceptance:** Replays of subscription create are safe.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-019 — Voided periods on transient ledger read are unrecoverable (P2)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (~L220-233)

**Problem:** If `getEntriesByStatementKey` returns empty (could be transient ledger gateway failure, not actual zero-amount), all periods are marked `voided`. Permanent.

**Plan:**
1. Distinguish "ledger query failed" from "ledger query returned empty." The former should throw (transaction rolls back, retried). Only the latter should void.
2. Even for genuine zero-amount periods, prefer status `invoiced` with `totalAmount=0` instead of `voided`. Voiding is for operator action; zero-amount is normal.
3. Test the two paths explicitly.

**Acceptance:** No transient infra failure can produce a `voided` period.

**Resolution:** _(fill in when fixed)_

---

## Tickets resolved by architectural clarification (do not implement)

These were in the audit but are not real issues given the project's invariants:

- **Double-counting via stacked grants on same feature** — resolved by clarification #2 (one meter per feature slug).
- **Pricing drift on `bill-period` retry / no version pin to period** — resolved by clarification #3 (plans append-only). Verify via HARD-004's test that re-runs of `billPeriod` rate against the same `planVersionId`.

---

## Open questions for human review

Before any AI agent picks these up, surface to the team:

1. **HARD-008 escalation policy** — Tinybird outage > backoff window: accept gap or fail-closed? Default proposed: accept gap.
2. **HARD-009 cancellation refund timing** — real-time vs next-cycle close? Default: real-time.
3. **HARD-013 reconciler cadence** — 10 min default; faster for higher-volume customers?
4. **HARD-016 dunning policy** — retry schedule and grace expiry behavior.
5. **HARD-015 cancelled-subscription late event** — reject or quarantine?

---

## Working agreement for AI agents

- Pick the lowest-numbered unchecked ticket of the highest severity you can fully complete.
- Read the full ticket, all referenced files, and run the existing tests before writing code.
- When done: flip the checkbox, append `Resolution: <one sentence>`, and update any cross-referenced tickets.
- If a ticket is blocked by another, leave it; pick the next one.
- If the plan in a ticket is wrong (you found a better approach during implementation), leave the box unchecked, append `Plan revision needed:` with your reasoning, and stop. A human will review.
- Don't add new sections to this doc. New issues go in new tickets at the bottom.
- After finsihing each point wait for a human to review and commit.
- **Do not pick up `BACKLOG-*` tickets** as part of this plan. They are scheduled to be revisited only after every `HARD-*` ticket is closed.

---

## Backlog (NOT part of this plan — pick up after every HARD-* is closed)

These tickets capture follow-up work surfaced during plan review. They are intentionally **deferred** until the active plan is fully resolved. AI agents working through `HARD-*` tickets must skip these — they are listed here only to avoid losing the context that produced them.

### [ ] BACKLOG-001 — Ack-then-process webhook redesign (P3, scalability/reliability)

**Status:** Backlog. Do not implement until all `HARD-*` tickets are closed. Captured 2026-04-26 during HARD-002 review.

**Context for future pickup:** Today the entire webhook pipeline (verify → advisory lock → INSERT webhook_events → invoice update → wallet settle → subscription state machine → mark processed → COMMIT) runs **synchronously inside the provider's HTTP request**. With HARD-002 in place this is correct under concurrency, and Neon's connection pooler mitigates the per-request connection cost, so this is not a current operational pain point. The reasons it is worth revisiting later:

1. **Provider HTTP timeout is the processing-time ceiling.** Stripe's webhook timeout is ~30s. Healthy paths today are well under that, but the current design has no headroom — a slow ledger gateway, a cold subscription machine, or a momentary DB stall can push a webhook past the limit. When that happens the provider considers the delivery failed and retries even though our processing committed; the duplicate is caught by HARD-002's idempotency layers but is wasted work.
2. **The current retry story relies entirely on the provider re-delivering.** If processing throws, `webhook_events.status='failed'` and we return 500. The next attempt only happens if/when Stripe re-delivers (up to 3 days). After that the event is dead. HARD-006 plans an internal sweeper that partially closes this gap, and HARD-013 plans a pull-based reconciler — together they cover the *missed/lost* case. But neither addresses the *slow-but-eventually-succeeds* case where the provider gives up before our handler returns.
3. **Connection-pool sensitivity at scale.** Holding a tx + advisory lock for the full pipeline ties up a Postgres connection per in-flight webhook. Neon's pooler covers us today; if webhook volume grows by 10×–100× this becomes a saturation risk independent of HARD-012's Hyperdrive plan.

**Strategy when picked up:**

The standard pattern from production billing systems (Stripe Sigma, Lago, Adyen): **persist the raw event synchronously, ack 200 OK, process asynchronously**.

1. **Sync portion (target <100ms):** verify signature, INSERT into `webhook_events` with `status='pending'`, return 200 OK to the provider. No invoice update, no ledger work, no subscription transitions in the request handler.
2. **Async worker (queue-driven):** a job (Cloudflare Queue, Trigger.dev — already in use elsewhere in this repo) drains `webhook_events WHERE status='pending'` and runs the current `applyWebhookEvent` body. The advisory lock + state-machine guards from HARD-002 stay as-is — they just execute in the worker rather than in the HTTP handler.
3. **Worker retry policy:** the worker owns the retry policy (exponential backoff, max attempts, eventual escalation). Decouples our processing time from the provider's timeout entirely. This subsumes HARD-006's sweeper for `status='failed'` because the worker IS the retry mechanism.
4. **Reconciler stays.** HARD-013's pull-based reconciler is still required as a backstop for events the provider never delivered (or delivered before signature config rotated). It is independent of this redesign.

**Cross-references at pickup time:**
- HARD-006 (settlement retry) becomes redundant — fold into the worker retry policy. Re-evaluate whether HARD-006's resolution is still needed once this lands.
- HARD-013 (reconciler) is complementary — both should ship.
- HARD-014 (audit DO commit synchronicity) interacts: the worker-side path needs to preserve audit-DO commit ordering. Re-read both tickets together.
- HARD-012 (Hyperdrive) is reduced in urgency once the sync handler stops holding long DB transactions, but is not eliminated.

**Trigger to pull this off the backlog:** any of (a) repeated reports of provider-retried webhooks where our log shows the original succeeded, (b) p99 webhook handler latency above ~3s, (c) post-mortem with "stuck in `failed` and provider stopped retrying" as a contributing factor.

**Resolution:** _(fill in if/when picked up)_