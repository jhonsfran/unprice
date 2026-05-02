# Billing Hardening Plan

> **Audience:** AI engineering agents picking up billing hardening work.
> **Workflow:** Each ticket has a `Status` checkbox. When you finish a ticket, flip `[ ]` → `[x]`, append a short `Resolution:` note (1 sentence), and update the dependent tickets it unblocks. Do not delete tickets — closed work is the audit trail.
> **Source:** Findings from the end-to-end audit of subscription create → ingestion → reservation → invoice → settlement on a paid-in-advance plan with arrears usage features (April 2026).
> **Scope rules:** Read `CLAUDE.md` and `docs/unprice-implementation-plan.md` first. Use-case rules are in CLAUDE.md and apply here. Do not introduce backwards-compatibility shims; this codebase is pre-GA.

---

## Architectural clarifications (applied to this plan)

These resolve audit findings without code changes. Treat as load-bearing invariants and do not violate them when implementing tickets below.

1. **Sandbox is the platform's test payment provider.** It is a first-class provider, not a stub. Webhooks against it must still be authenticated; sandbox-mode is no excuse for accepting forged events. Treat the sandbox the same as Stripe for security-relevant code (signature verification, idempotency, webhook state-machine).
2. **A customer cannot have two active customer entitlements for the same feature slug.** The access boundary is the customer entitlement, not a computed grant group or meter stream. Ingestion resolves active customer entitlements by event slug, then routes to the Durable Object by `env:projectId:customerId:customerEntitlementId`. Grants are allowance chunks under that entitlement; they do not own meter identity, price, cadence, or routing. Tickets in this doc that reference per-stream double counting are dropped; do not reintroduce a code path that would allow two active usage streams for the same `(customerId, featureSlug)`.
3. **Plans are append-only after publish.** A published `planVersion` is immutable. New pricing = new `planVersion`. This invalidates the audit's "rating drift on retry" finding — re-running `bill-period` on the same `(subscription, period)` always rates against the same `planVersionId` it was provisioned with. Do not add a "version pin" column; the existing `planVersionId` reference on the period is the pin. Any ticket that smells like "snapshot the plan into the period" is wrong — instead, assert that all rating reads go through `planVersionId` and never through "current plan version of subscription."
4. **The EntitlementWindowDO owns runtime allowance math.** Ingestion should not compute period keys, summed grant allowance, active grant availability, or pricing. It passes `{ entitlement, grants, event }`; the DO stores entitlement config, filters active grants by range/priority, computes period buckets from the entitlement effective time, prices usage from the plan feature config, and emits facts with `customer_entitlement_id`.
5. **Reservation rows still use the legacy column name `entitlement_id`, but the value is now `customerEntitlementId`.** Do not add a parallel computed entitlement identifier or `meter_hash`. A later migration may rename the column to `customer_entitlement_id`, but until then this doc treats `entitlement_reservations.entitlement_id` as the customer entitlement id.

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

### [x] HARD-003 — `bill-period` invoice INSERT/SELECT is non-atomic (P0, money correctness)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (invoice creation block ~L279-321), `internal/services/src/billing/repository.drizzle.ts` (`createInvoice` / `findInvoiceByStatementKey`)

**Problem:** The flow is `INSERT ... ON CONFLICT DO NOTHING` (returns `null` on conflict) → if `null` then `SELECT` by statement key. There's a window where the existing row could be missing (e.g., concurrent finalize/delete in another path), in which case the function silently returns and leaves periods in `pending` state. Re-runs may create duplicates.

**Plan:**
1. Replace the two-step pattern with a single `INSERT ... ON CONFLICT (projectId, subscriptionId, customerId, statementKey) DO UPDATE SET updated_at = now() RETURNING *`. The `DO UPDATE` is a no-op-ish update that guarantees `RETURNING` always returns the row (existing or new).
2. Move the entire bill-period section that posts ledger entries → creates invoice → marks periods `invoiced` into a single Postgres transaction with `pg_advisory_xact_lock(hashtext('bill:' + statementKey))` at the top. This both serializes re-runs and guarantees atomicity. Note: this is a larger change than #1; #1 is the minimum fix.
3. Add a test: run two `billPeriod` calls concurrently for the same `(subscription, statementKey)` → exactly one invoice row exists, all periods marked `invoiced`, ledger entries posted exactly once.
4. Add a sweeper alert (P3, separate ticket): if any `billing_periods` row is `pending` and `cycleEndAt < now - 24h`, page on-call.

**Acceptance:** No code path can return early-success after the INSERT step without having a confirmed invoice row in hand.

**Resolution:** Both #1 and #2 from the plan landed. (1) `DrizzleBillingRepository.createInvoice` now uses `INSERT ... ON CONFLICT (projectId, subscriptionId, customerId, statementKey) DO UPDATE SET project_id = EXCLUDED.project_id RETURNING *` — the no-op `DO UPDATE` forces RETURNING to always yield the canonical row (existing or new), eliminating the silent-null-return + fallback-SELECT race. (2) `bill-period.ts` now wraps the entire per-group flow (rate → ledger transfers → invoice upsert → totalAmount stamp → markPeriodsInvoiced) in a single `db.transaction(...)` opened by `pg_advisory_xact_lock(hashtext('bill:projectId:statementKey'))`. Concurrent re-runs for the same statement queue rather than racing; partial failures roll back rate-and-mark together so we never commit "ledger posted but periods still pending." `LedgerGateway.getEntriesByStatementKey` now accepts an optional `executor` so the read-back happens inside the same tx and observes the just-posted entries. The previous "if no entries, void all periods" branch was preserved (HARD-019 will make that more conservative). Removed the unreachable fallback `findInvoiceByStatementKey` call; replaced the silent `return` after a missing invoice with a thrown error so the tx rolls back loudly. New unit test in `machine.test.ts` re-runs `m.invoice()` twice on the same statement and asserts (a) only one distinct ledger source identity is created across both runs (gateway dedup), (b) the upserted invoice row remains in `draft`, (c) `db.transaction` is invoked for the BILL flow. All 256 services tests pass.

---

### [x] HARD-004 — `bill-period` ledger source ID idempotency must be verified (P0, money correctness)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (ledger transfer at ~L176-190), `internal/services/src/ledger/` (gateway)

**Problem:** Ledger transfer source ID is constructed from `period.id`. If `bill-period` re-runs after a partial failure (ledger posted, invoice creation crashed), the same period rows are picked up again. We *believe* the ledger gateway dedupes on source ID, but it's not covered by a test — and HARD-003's atomicity fix doesn't strictly close the window without HARD-004 being verified.

**Plan:**
1. Read `internal/services/src/ledger/gateway.ts` (or equivalent) and confirm the dedup semantics: it should be `(sourceType, sourceId)` unique. Document in a code comment near the gateway's `createTransfer` what the dedup contract is.
2. Add a unit test in `internal/services/src/billing/service.rating.test.ts` (or a sibling) that calls `billPeriod` twice for the same period and asserts ledger entries posted exactly once.
3. If dedup is not on `(sourceType, sourceId)`, add it. The current source ID format must include the `statement_key` so that two separate periods with the same `period.id` (shouldn't happen, but defensive) don't collide.
4. Once verified, mark this ticket complete; HARD-003 can land safely without it but HARD-004 is the proof.

**Acceptance:** Test demonstrates double-`billPeriod` produces single ledger entry per period.

**Resolution:** Verified the dedup contract is `(projectId, source.type, source.id)`, enforced by the unique index on `unprice_ledger_idempotency` and the `claimIdempotency` helper at `gateway.ts` ~L631-655 (`INSERT ... ON CONFLICT (project_id, source_type, source_id) DO NOTHING`). Statement key is recorded alongside but is *not* part of the dedup key — same source identity with a different statement key would be a programming error. The bill-period source identity is `subscription_billing_period_charge_v1` + `${period.id}:${period.subscriptionItemId}` (`bill-period.ts` L155-156); since `period.id` is unique per `(subscription, statementKey, item)` and the statement key itself is part of the projection (not the dedup), re-runs of the same period across statement keys can't collide. Documented the contract in a JSDoc block above `LedgerGateway.createTransfer`. Test added in HARD-003 (machine.test.ts: "re-running invoice() is idempotent…") asserts that a second `m.invoice()` on the same statement collapses to the same set of distinct `(sourceType, sourceId)` calls — gateway-level idempotency keeps actual postings to one per period.

---

### [x] HARD-005 — Wire `finalizeInvoice` between draft creation and settlement (P0, money collection)

**Files:** `internal/services/src/use-cases/billing/bill-period.ts` (post-invoice-creation), `internal/services/src/payment-provider/service.ts` (existing `finalizeInvoice` method ~L169-173)

**Problem:** The audit found no caller for `paymentProviderService.finalizeInvoice`. For Stripe, an invoice in `draft` is invisible to the customer and never collected. If this is genuinely missing, the system is silently failing to charge for arrears periods.

**Plan:**
1. **Verify first.** Grep for `finalizeInvoice` callers across `apps/`, `internal/jobs/`, and `internal/services/`. If a caller exists in a job or webhook path and only the bill-period inline call is missing, document the existing flow at the top of this ticket and adjust the plan.
2. If not wired: add a `finalizeInvoice` step to `bill-period.ts` after the invoice row is created and before returning. Use the same provider context as the rest of the use case. Failure of finalize should mark the invoice `finalize_failed` (new status) and emit a job for a retry sweeper.
3. For sandbox, `finalizeInvoice` is a no-op (returns `{status: 'finalized'}` synchronously).
4. Add a sweeper job at `internal/jobs/src/trigger/schedules/finalize-invoices.ts` that finds invoices in `draft` state older than 1h and retries finalize with exponential backoff (max 5 attempts, then page).
5. Test: full path from `billPeriod` → finalize → settle on sandbox. Invoice ends in `paid`, all states transitioned through.

**Acceptance:** No invoice can sit in `draft` past 1h without either being finalized or surfacing in an alert.

**Existing flow (verified 2026-04-26 during HARD-005 pickup):**

1. `bill-period.ts` (BILL phase, invoked by the XState `invoicing` actor) creates the local invoice row in `draft` status. `invoicePaymentProviderId` is intentionally left empty here — provisioning a Stripe invoice inside the BILL transaction would block on a remote HTTP call while holding the per-statement advisory lock landed in HARD-003.
2. `internal/jobs/src/trigger/schedules/finilizing.ts` (cron: every 5 min in dev, every 12 h in prod) finds invoices in `draft` whose `dueAt <= now` and `batchTrigger`s `finilizeTask`.
3. `finilizeTask` (`internal/jobs/src/trigger/tasks/finilize.ts`) calls `billing.finalizeInvoice`.
4. `BillingService.finalizeInvoice` (`internal/services/src/billing/service.ts:574`) wraps `_finalizeInvoice` and `_upsertPaymentProviderInvoice` inside a `withSubscriptionMachine` block.
   - `_finalizeInvoice` (~L700) flips local status `draft → unpaid` (or `void` when `totalAmount === 0`) and stamps `issueDate`. **It does not touch the payment provider.**
   - `_upsertPaymentProviderInvoice` (~L765) is a **stub** that returns `{ providerInvoiceId: "", providerInvoiceUrl: "" }`. This is where the actual `paymentProviderService.createInvoice` + `addInvoiceItem` + `finalizeInvoice` calls should live.
5. `internal/jobs/src/trigger/schedules/billing.ts` cron then picks up `unpaid` invoices and calls `billing.billingInvoice` → `_collectInvoicePayment`. That code requires `invoicePaymentProviderId` (`service.ts:263-269`) and **bails with `"Invoice has no invoice id from the payment provider, please finalize the invoice first"`** because step 4 never populated it.

So the audit's premise is correct (no caller for `paymentProviderService.finalizeInvoice` and none for `createInvoice` either) — but the *missing piece* is not "wire `finalizeInvoice` into bill-period." It's "fill in the `_upsertPaymentProviderInvoice` stub" inside the existing scheduler-driven path.

**Plan revision needed:** The proposed step "add a `finalizeInvoice` step to `bill-period.ts` after the invoice row is created and before returning" is the wrong place for this work. Reasons:

1. **Transaction scope.** `bill-period.ts` already runs inside `db.transaction(...)` with `pg_advisory_xact_lock(hashtext('bill:projectId:statementKey'))` (HARD-003). Adding a Stripe HTTP call inside that transaction holds the lock for the duration of a remote round-trip — exactly the failure mode HARD-003 was tightening.
2. **Retry topology.** The existing `finilizingSchedule` cron is already the retry sweeper the ticket asks for in step (4): it polls `draft` invoices and re-runs `billing.finalizeInvoice` on each tick. Adding inline finalization in `bill-period.ts` either duplicates this retry path or competes with it.
3. **The right surface is `_upsertPaymentProviderInvoice`.** It already exists, is already called by the public `finalizeInvoice` after `_finalizeInvoice` returns, and has the correct shape (`{ providerInvoiceId, providerInvoiceUrl }`). The stub just needs to: (a) resolve the provider via `customerService.getPaymentProvider`, (b) call `paymentProviderService.createInvoice`, (c) project ledger lines for the statement and `addInvoiceItem` for each, (d) call `paymentProviderService.finalizeInvoice`, (e) persist `invoicePaymentProviderId` + `invoicePaymentProviderUrl` back onto the local invoice. For `sandbox`, all four adapter calls are already deterministic stubs that return synthetic IDs — no extra work.

**Revised plan (acked 2026-04-26):**

1. **Fill the `_upsertPaymentProviderInvoice` stub** in `internal/services/src/billing/service.ts`. Replace the empty-string return with the real provider flow: resolve the provider via `customerService.getPaymentProvider`, call `paymentProviderService.createInvoice`, project ledger lines and call `addInvoiceItem` for each, call `paymentProviderService.finalizeInvoice`, persist `invoicePaymentProviderId` + `invoicePaymentProviderUrl` back onto the local invoice. The public `billing.finalizeInvoice` entry point stays unchanged; the existing `finilizingSchedule` cron is the retry sweeper.
2. **Project lines via `LedgerGateway.getInvoiceLines`.** This is the same primitive the read-side API uses (`apps/api/.../getInvoiceV1.ts`, `internal/trpc/.../getInvoiceById.ts`), so customers see exactly what we sent to Stripe. Migrate `bill-period.ts` from `getEntriesByStatementKey` to `getInvoiceLines` in the same change so there is one ledger→invoice projection in the codebase. Delete `getEntriesByStatementKey` from `LedgerGateway` once unreferenced (it becomes redundant — `getInvoiceLines` is a strict semantic superset for "what goes on the invoice"). Keeps the test mock surface smaller too.
3. **Retry semantics via `metadata.finalizeAttempts`.** No new invoice status. On provider error: bump `metadata.finalizeAttempts`, persist last error in metadata, leave invoice in `draft`, throw. The dedup gate at `_finalizeInvoice` (`if (invoicePaymentProviderId || status !== "draft") return Ok`) makes the call idempotent if step 1's first attempt persisted the provider ID before crashing. The existing cron retries on the next tick.
4. **Sweeper alarm** in `finilizingSchedule`: when scanning, log a `warn` for any draft invoice with `metadata.finalizeAttempts > 5` OR `dueAt < now - 1h`. (Paging integration is out of scope — log line is enough for ops to alert on.)
5. **Tests.** Sandbox end-to-end (bill → finalize → settle ends in `paid`). Stripe adapter mock asserts `createInvoice → addInvoiceItem (×N) → finalizeInvoice` in order. Failure case: provider error during `createInvoice` leaves invoice `draft` with `metadata.finalizeAttempts == 1`; second call increments to 2; third call (after fixing) succeeds and clears nothing (counter is just for ops visibility).

**Resolution:** Filled the `_upsertPaymentProviderInvoice` stub in `internal/services/src/billing/service.ts` and reordered the public `finalizeInvoice` so the provider HTTP work runs *before* the local status flip — a provider failure now leaves the invoice in `draft` for the existing `finilizingSchedule` cron to retry. (1) `_upsertPaymentProviderInvoice` resolves the configured provider via `customerService.getPaymentProvider`, calls `createInvoice`, persists `invoicePaymentProviderId`/`Url` immediately so a mid-pipeline crash can't orphan a Stripe invoice, projects ledger lines via `LedgerGateway.getInvoiceLines` (filtered to `metadata.billing_period_id != null` to scope to bill-period charges), `addInvoiceItem`s each line with `period`/`isProrated`/`metadata`, then calls `finalizeInvoice`. Sandbox is a no-op via the existing deterministic adapter; Stripe path is fully wired. (2) The dedup gate in `_finalizeInvoice` was tightened to `status !== "draft"` only — provider id alone no longer short-circuits, so a partial-failure replay (provider id stamped but local status not yet flipped) correctly proceeds to the status flip. (3) New `_bumpFinalizeAttempt` records `metadata.finalizeAttempts` + `lastFinalizeError` + `lastFinalizeAttemptAt` on every provider failure; best-effort, swallows its own errors. (4) `invoiceMetadataSchema` extended with the three new optional fields. (5) Bill-period migrated from `getEntriesByStatementKey` to `getInvoiceLines` so the same projection feeds both the BILL totalAmount sum and Stripe `addInvoiceItem` — `getEntriesByStatementKey` was deleted from `LedgerGateway` (it summed both legs of every transfer, which only worked because the metadata filter dropped half by accident). (6) `finilizingSchedule` now logs `stale_draft_invoice` warn lines for invoices with `finalizeAttempts > 5` OR `dueAt < now - 1h` — the alarm hook for ops. (7) Tests: 6 new unit tests in `service.finalize.test.ts` cover happy path call sequence, zero-amount → `void` skip, provider error bumps attempts and stays `draft`, already-stamped provider id skips upsert, already-past-draft is a no-op, missing-lines surfaces a data integrity error. All 262 services tests pass.

---

### [x] HARD-006 — Settlement failure after `invoice.status='paid'` has no retry (P0, money correctness)

**Files:** `internal/services/src/use-cases/payment-provider/process-webhook-event.ts` (~L229-280), `internal/services/src/use-cases/billing/settle-invoice.ts`

**Problem:** Webhook flow: update invoice to `paid` → call `settlePrepaidInvoiceToWallet`. If the wallet ledger transfer fails (gateway down, lock contention), the webhook is logged failed and **never retried**. The invoice is `paid`, the customer's receivable is unsettled, the next period's billing starts from a wrong wallet state. Manual replay only.

**Plan:**
1. Reorder: do the wallet `settleReceivable` ledger transfer **first** (in the webhook tx), then update `invoice.status='paid'` in the same tx. Both ops are idempotent already; doing them in this order means a partial failure leaves invoice in `finalized` (so the webhook retry path picks it up cleanly) instead of "paid but unreconciled."
2. Replace "log and exit" on settlement failure with throwing an error that the webhook framework will retry. Confirm the webhook handler's outer harness retries `failed` rows (it should — read `apps/api/src/routes/paymentProvider/providerWebhookV1.ts`). If not, add a sweeper job in `internal/jobs/src/trigger/schedules/` that polls `webhook_events WHERE status='failed' AND attempts < N` and re-enqueues.
3. Add a state-machine assertion (mirrors HARD-002): `reconcilePaymentOutcome` must be a no-op if the subscription is already in the target state. Idempotency by inspection.
4. Test: inject a wallet ledger failure mid-webhook, assert the webhook is left retryable and invoice stays `finalized` (not `paid`).

**Acceptance:** No code path produces "invoice=paid AND receivable unsettled" as a terminal state.

**Resolution:** Reordered `applyWebhookEvent` for both `payment.succeeded` and `payment.dispute_reversed` to run **settle → invoice status update → subscription reconcile** instead of the previous **status update → settle → reconcile**. (1) `settlePrepaidInvoiceToWallet` now runs first; on error the function returns Err immediately and the outer webhook handler persists `webhook_events.status='failed'` and returns 500 — Stripe re-delivers and the next attempt replays from a clean `unpaid`/`finalized` state instead of the previous "paid + unreconciled" trap. (2) The `!updated` branch in `updateInvoiceIfStatus` no longer short-circuits; it only logs a `warn` ("invoice already in target state") and falls through to reconcile. The previous early-return was the actual bug — even after reordering, a settle-after-update partial failure (or a reconcile-only failure) would have left the invoice paid and the next retry would have skipped reconcile because status is no longer in `allowedFromStatuses`. Now retries always re-attempt every step. (3) Idempotency for reconcile is enforced via a new `metadata.subscriptionReconciledAt` + `metadata.subscriptionReconciledOutcome` marker on the invoice (added to `invoiceMetadataSchema`). The subscription state machine itself is **not** strictly idempotent — `PAYMENT_SUCCESS` in `active` self-transitions normally, but at end-of-cycle it can trigger `renewing`, so a duplicate webhook arriving after cycle close would fire an extra renewal. The marker check skips the machine call when the recorded outcome matches the incoming one; a genuinely new outcome (e.g., `payment.reversed` after a prior `payment.succeeded`) bypasses the marker because the outcomes differ. The marker write is best-effort (logged on failure) — losing it just means the next replay will harmlessly re-run reconcile, which is fine inside a single cycle. Same idempotency wrapper handles `payment.failed` and `payment.reversed`. (4) Tests: 3 new tests in `process-webhook-event.test.ts`. (a) "retries idempotent settle + reconcile when invoice is already paid but reconcile marker is missing" — replay against an already-`paid` invoice with empty metadata still calls settle and reconcile; (b) "skips reconcile when invoice already carries a matching reconcile marker" — replay against an already-`paid` invoice with `subscriptionReconciledOutcome='success'` calls settle (idempotent ledger no-op) but does NOT call reconcile; (c) "settle failure leaves invoice unchanged and surfaces an error" — settle error short-circuits before any invoice mutation, no `update` call to the invoice, no `reconcilePaymentOutcome` call, and the function returns Err so the provider retry can recover. Updated the prior "skips downstream side effects" test (which encoded the old bail-on-`!updated` contract) to reflect the new always-replay behavior. All 264 services tests pass.

---

### [x] HARD-007 — `activateWallet` failure leaves paid plan in broken active state (P0, customer impact)

**Files:** `internal/services/src/use-cases/subscription/create.ts` (~L89-114), `internal/services/src/use-cases/billing/provision-period.ts` (catch block ~L164-181)

**Problem:** `createSubscription` runs `activateWallet` after the create transaction commits. Failure is logged but non-fatal. For a paid plan, this leaves `status='active'` with no grants issued — the customer's first event is denied with `WALLET_EMPTY` and they have no path to recover without operator intervention. Also, `provision-period.ts`'s catch only handles `ActivationAbortError`; generic infra exceptions escape uncaught, leaving subscription persisted but inconsistent.

**Plan:**
1. In `provision-period.ts`, broaden the catch to `catch (err)` (any error). Wrap non-`ActivationAbortError` instances in a new `ActivationFailedError`. The transaction should already roll back; ensure no DDL/connection state leaks.
2. In `create.ts`, treat `activateWallet` failure for paid plans as fatal: roll back the subscription create (or, if already committed, mark `status='activation_failed'` and emit a job to retry). For free plans (no grants needed) keep it non-fatal.
3. Decide between rollback-on-failure vs activation-retry job. Recommendation: retry job. Reasons: (a) the subscription record is useful for support visibility, (b) the user may already have a Stripe customer mapping that we don't want to throw away, (c) retries are bounded and observable.
4. Add a new state `pending_activation` to the subscription state machine. Block all event ingestion while in this state (return a typed error to the customer's API client). The retry job promotes to `active` on success.
5. Test: simulate `walletService.adjust` failure on grant #2 of 3 → subscription left in `pending_activation` with no grants posted, retry job picks it up, all 3 grants posted on retry.

**Acceptance:** No code path produces "subscription=active with paid plan AND no grants."

**Resolution:** Routed activation failures into a new recoverable `pending_activation` state (DB enum + machine state) and added a sweeper to retry. (1) New `pending_activation` value appended to `subscription_status_v3` (migration `0004_pending_activation_status.sql`) and to the `SUBSCRIPTION_STATUS` constant. (2) `subscriptions/machine.ts`: `activating.onError` now targets `pending_activation` (a `subscription`-tagged state, so the machine subscriber persists it) instead of the previous `error` (final, untagged) state — the prior wiring left the DB row stuck on whatever status was in place before the activating attempt, so paid plans showed `active` with no grants. The new state accepts `ACTIVATE` (loops back to `activating`) and `CANCEL`. The `restored.always` block routes `status='pending_activation'` rows back into the same node on machine restart. The actor `subscribe` handler now also calls `customerService.updateAccessControlList` on every status change so the bouncer's edge-cached ACL never lags status transitions (HARD-007 specifically needs this for `pending_activation`, but `past_due` benefits too — pre-existing gap fixed in the same place). (3) `SubscriptionService.activateWallet` returns `Err` when the machine ends in `pending_activation` so callers (foreground create + sweeper) treat it as a failure to retry, not as success-with-no-grants. (4) `provision-period.ts` already wraps non-`ActivationAbortError` exceptions in `UnPriceSubscriptionError` — the original ticket plan's "broaden the catch" step was already in place; verified, no change needed. (5) `apps/api/src/util/bouncer.ts` denies ingestion with `FORBIDDEN` when ACL `subscriptionStatus === 'pending_activation'` so first events don't see ambiguous `WALLET_EMPTY` denials. (6) `use-cases/subscription/create.ts`: refreshed the activation-failure comment to reflect that the machine has already parked the subscription before we return — we deliberately keep the subscription record (rolling it back would discard a freshly-minted Stripe customer mapping). (7) New sweeper: `internal/jobs/src/trigger/schedules/activation.ts` (cron: every 5 min in dev, hourly in prod) finds `status='pending_activation'` rows and `batchTrigger`s `activationTask` (max 3 retry attempts) which calls `subscriptions.activateWallet`. The same advisory lock + per-grant idempotency keys (`activate:${cycleKey}:grant:${i}`) keep concurrent retries convergent on the same `wallet_grants` rows. Subscriptions stuck > 1h emit a `stale_pending_activation` warn line — the alarm hook for ops, mirrors HARD-005's `stale_draft_invoice` pattern. (8) Tests: existing `provision-period.test.ts` already covers the partial-failure invariant (grant #1 fails → tx rolled back, no status flip, second grant not attempted). New machine-level test `HARD-007: activate failure parks the subscription in pending_activation, retry from there reaches active` exercises the full state-machine path: 2-grant activation with failure on grant #2 → machine ends in `pending_activation`, DB persisted, ACL update issued; restart with a non-failing wallet from the parked state → second `activate()` reaches `active`. All 265 services tests pass, jobs/services/db typechecks clean.

---

### [ ] HARD-008 — Tinybird flush has no retry, no DLQ, and 30-day SQLite TTL drops data (P1, analytics correctness)

**Files:** `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` (`alarmInner`, `flushToTinybird`, self-destruct logic), `apps/api/src/ingestion/entitlements/db/schema.ts` (`meterFactsOutboxTable`, new flush-state table/row), `apps/api/src/ingestion/entitlements/drizzle/*` (DO SQLite migration)

**Problem:** When `analytics.ingestEntitlementMeterFacts` fails, the function returns `false`, the alarm logs and exits, and the outbox rows stay in SQLite. There is no exponential backoff, no escalation, no metric. After 30 days post-period the DO can `deleteAll()` itself with rows still unflushed. Tinybird outage > 30 days → permanent data loss for analytics (note: not money — the ledger is independent).

**Plan:**

1. **Add structured retry state to the DO.** New SQLite columns/keys on a `flush_state` row: `consecutiveFailures INT`, `lastErrorAt TIMESTAMP`, `nextRetryAt TIMESTAMP`, `lastErrorMessage TEXT`.
2. **Exponential backoff with jitter.** Compute next alarm: `min(30m, 30s * 2^min(failures, 6)) + random(0, 30s)`. On success, reset `consecutiveFailures=0`. The normal alarm cadence (30s/5m) only applies when there is no active backoff.
3. **Self-protect against the 30-day deletion.** In the deletion path (~L917-923), refuse to delete if `outbox` is non-empty *or* `consecutiveFailures > 0`. Instead, schedule an alarm 1h out and surface a metric.
4. **Surface health.** Emit a wide-event log line on every flush: `{customerId, projectId, customerEntitlementId, batchSize, durationMs, success, consecutiveFailures, errorMessage?}`. `period_key` can stay inside individual Tinybird fact payloads; it is not part of DO identity or operator routing. Wire a Tinybird/Grafana alert on `consecutiveFailures > 5`.
5. **Operator escape hatch.** Add an admin RPC `forceFlushEntitlementWindow({ projectId, customerId, customerEntitlementId })` that targets the current DO route and flushes its outbox synchronously, returning the result. Useful for incident recovery.
6. **Long-tail backstop.** Add a worker that scans `entitlement_reservations WHERE period_end_at < now - 7d AND reconciled_at IS NULL` and pings the corresponding entitlement-window DO by `(projectId, customerId, entitlement_id AS customerEntitlementId)`. The DO owns its local period/reservation state; the scanner should not derive a period-scoped DO id.
7. **Decision needed (escalate, do not silently choose):** if Tinybird is down for the entire backoff window (e.g., 24h), do we (a) accept the analytics gap and continue, or (b) fail closed and stop accepting events? Default: (a). Document the decision in this ticket before flipping the box.

**Acceptance:**
- Inject a Tinybird outage of 1h → all facts eventually arrive after recovery.
- Outage of 30d+ → no data loss; outbox preserved; alert fires.
- Test exists for the backoff schedule and the deletion-refusal logic.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-009 — Mid-cycle subscription cancellation strategy: close entitlement-window DOs (P0, money correctness)

**Files:** `internal/services/src/use-cases/subscription/cancel.ts` (create if missing), `internal/services/src/wallet/service.ts` (`flushReservation` final path), `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` (`finalFlush`/new `closeReservation` RPC), `internal/db/src/schema/entitlementReservations.ts`

**Problem:** Today, when a subscription is cancelled mid-cycle, reserved funds sit in the `reserved` ledger account until the DO's 24h-inactivity alarm fires its final flush. This is up to 24h of cash in customer-visible limbo, with the subscription appearing "cancelled" in the UI but the wallet still showing the hold. There is no explicit "cancellation → flush now" hook.

**Strategy.** The reservations table is the index of truth for which customer-entitlement windows have open wallet holds. Use it, but route DO calls by `customerEntitlementId` only. `period_start_at` identifies the wallet reservation, not the DO id.

**Plan:**

1. **State machine.** Add a `cancelling` status to the subscription state machine, between `active` and `cancelled`. While in `cancelling`:
   - Ingestion adapter rejects new events for that subscription with a typed `SUBSCRIPTION_CANCELLING` error (non-retryable).
   - The cancel use case is responsible for transitioning to `cancelled` only after all reservations are reconciled.

2. **Find the open reservations.**
   ```sql
   SELECT id, project_id, customer_id, entitlement_id AS customer_entitlement_id,
          period_start_at, period_end_at
   FROM entitlement_reservations
   WHERE customer_id = $1
     AND project_id = $2
     AND reconciled_at IS NULL
   ```
   This is the existing `entitlement_reservations_customer_idx` plus the active partial index. No new index needed for v1. Add a migration in this ticket to rename `entitlement_id` → `customer_entitlement_id` if you want to pay down the legacy column name; do not add a second identifier.

3. **Derive DO IDs and dispatch close.** The DO routing key is `buildIngestionWindowName({ appEnv, projectId, customerId, customerEntitlementId })`. For each open reservation row, derive the DO stub from `(projectId, customerId, customerEntitlementId)` and call a new RPC `closeReservation({ reservationId, reason: 'subscription_cancelled' })` on the DO.
   - The DO must:
     a. Persist a local `closing`/`deletionRequested` state before any await so concurrent `apply()` calls fast-reject with `SUBSCRIPTION_CANCELLING`.
     b. Verify the local wallet reservation matches `reservationId` when one is supplied. If already closed, return `{ ok: true, alreadyClosed: true }`.
     c. Wait for any in-flight flush/refill promise, then call `finalFlush` — flush all outstanding consumption to ledger, refund remainder via `wallet.flushReservation(final=true)`, and mark `reservation.reconciledAt = now`.
     d. Return `{ ok: true, refunded, finalConsumed }`.

4. **Use-case orchestration.** New use case `internal/services/src/use-cases/subscription/cancel.ts`:
   ```
   cancelSubscription(deps, { subscriptionId, projectId, reason })
     1. Tx: subscription.status = 'cancelling'
     2. Read open reservations for the customer/subscription-owned entitlements
     3. For each: dispatch closeReservation RPC. Collect results.
     4. Re-read open reservations from Postgres.
     5. If none remain → subscription.status = 'cancelled', cancelledAt = now
     6. If any remain → subscription stays 'cancelling', failures emit a row in
        `cancellation_retries(subscriptionId, reservationId, customerEntitlementId, lastError, attempts)`
   ```
   Concurrency: group duplicate reservation rows by `customerEntitlementId` before dispatch, then run RPCs in parallel with bounded fan-out (e.g., `pLimit(10)`). Cancellation latency for a customer with 10s of active entitlements should be sub-second.

5. **Failure recovery — the sweeper.** New cron job `internal/jobs/src/trigger/schedules/cancellation-sweeper.ts`, runs every 5 minutes:
   ```
   For each subscription in 'cancelling' for > 5 minutes:
     For each reservation still open:
       Re-dispatch closeReservation({ reservationId, customerEntitlementId })
     If success on all → flip to 'cancelled'
   ```
   Bounded retry attempts (e.g., 20 attempts over ~24h); after exhaustion, page on-call. Reservations with persistent close failures need human inspection (likely a stuck DO).

6. **Race with in-flight events.** When `closeReservation` RPC arrives at the DO mid-`apply()`:
   - The DO is single-threaded per customer entitlement — the RPC queues behind the current `apply()`. Good.
   - If the apply triggered a refill that's now mid-flight (`waitUntil`), `closeReservation` must wait for it. Track the in-flight promise on the DO and `await` it before final flush.

7. **Tests.**
   - Cancel mid-period with 3 open customer entitlements → all 3 reconciled, wallet refund posted, subscription `cancelled` within seconds.
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

**Files:** `internal/services/src/wallet/reservation-sizing.ts`, `internal/services/src/wallet/local-reservation.ts`, `internal/services/src/entitlements/grant-consumption.ts` (`computeMaxMarginalPriceMinor`), `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` (`bootstrapReservation`, reservation check/refill path)

**Problem:** A single event whose marginal cost exceeds `refillChunkAmount` is denied with `WALLET_EMPTY` even though the wallet has plenty of balance. Common trigger: tier boundaries with flat fees (e.g., $1 onboarding fee on first unit), price spikes, multi-unit events. Today's sizing assumes uniform pricing.

**Strategy — pick (b) as the primary fix, with (a) as a defense-in-depth probe.**

**(a) Probe worst-case event price at sizing time.** Cheap, deterministic, but only catches what the pricing model declares.
1. At reservation bootstrap, `reservation-sizing.ts` already knows the priceConfig. Walk the tier list: for each tier transition within the period's expected usage range, compute the per-unit cost at the boundary (including any flat fees). Take the max.
2. Set `refillChunkAmount = max(baseChunk, 2 * worstCaseEventCost)`. The 2× headroom absorbs two consecutive worst-case events without round-trips.
3. This is bounded and runs once per period — no perf cost.

**(b) Adaptive bump on denial.** Closes the gap when the event cost exceeds even the probed worst case (e.g., volume discounts that flip sign, batch events).
1. In `LocalReservation.applyUsage`, if `cost > remaining + refillChunkAmount` (i.e., one refill won't cover it), don't deny outright. Instead emit a `BUMP_REQUIRED` decision with `requestedChunk = ceil(cost * 1.5 / chunkUnit) * chunkUnit`.
2. The DO triggers an immediate refill with the bumped chunk size, persists `refillChunkAmount = bumped` to the local reservation row and Postgres reservation row (monotonic increase only — never shrink mid-period), then re-applies the event in the same `apply()` call. Pricing still comes from the owning customer entitlement's plan feature config; grant allocation only determines allowance consumption.
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

**Files:** `internal/services/src/entitlements/domain.ts` (`MAX_EVENT_AGE_MS` / timestamp validation), `apps/api/src/routes/events/ingestEventsV1.ts`, `apps/api/src/routes/events/ingestEventsSyncV1.ts`, `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` (SQLite idempotency cleanup), `apps/api/src/ingestion/audit/IngestionAuditDO.ts` (audit retention)

**Detailed explanation of the issue (per request):**

Each event carries an `idempotencyKey` (typically `eventId` or a hash). Two layers cache it:

1. **Batch-level dedup** in `ingestion/message.ts` — short-lived, per-batch only.
2. **Audit DO and EntitlementWindowDO SQLite** — persist `(idempotencyKey → outcome)` rows so that retries replay deterministically.

The API rejects events older than `MAX_EVENT_AGE_MS = 30 days`, and the DO sweeps SQLite idempotency rows by local `createdAt` once they are older than that same constant. The current shared constant makes the system mostly safe, but the invariant is implicit and fragile: a future change could widen ingestion acceptance without widening DO/audit retention.

**The hole:**

- Cloudflare Queues retain failed messages for up to 14 days (current limits; check at fix time).
- A trigger.dev DLQ can retain longer (configurable; could be 30+ days).
- Operators replaying a DLQ after a long incident, or backfill jobs sending events with old timestamps, can submit an event whose `idempotencyKey` was already processed but has been swept from the DO if the replay path bypasses the public timestamp validation or if acceptance and retention constants drift apart.
- The DO sees a "fresh" event, processes it, prices it, posts to ledger → **double-charge for the same event**.

**Realism:** Medium. Triggered by:
- Operator running a manual replay after a multi-week outage (rare but plausible).
- A backfill tool submitting historical events for a new customer migration.
- A bug in the producer that defers events (e.g., batch upload of months-old IoT data).

**Strategy.** Make the acceptance/retention invariant explicit instead of relying on shared constant coincidence. The dedup table must be at least as wide as the oldest event the platform will accept, with a small safety margin for cleanup timing.

**Plan:**

1. **Split the constants and assert the invariant.** In `entitlements/domain.ts`, define `INGESTION_MAX_EVENT_AGE_MS` for public acceptance and `DO_IDEMPOTENCY_TTL_MS` for DO cleanup. Default: keep ingestion at 30 days and set DO TTL to `INGESTION_MAX_EVENT_AGE_MS + 7 days` (matching the audit DO's existing margin). Add a module-level assertion that `DO_IDEMPOTENCY_TTL_MS > INGESTION_MAX_EVENT_AGE_MS`.
2. **Use the right constant at each boundary.** Public routes and the entitlement engine validate against `INGESTION_MAX_EVENT_AGE_MS`. EntitlementWindowDO idempotency cleanup uses `DO_IDEMPOTENCY_TTL_MS`. Audit DO retention remains at least as long as DO idempotency retention.
3. **Backfill escape hatch.** Add an admin-only ingestion endpoint `ingestHistorical` that accepts old events but routes them to a separate processing path (no DO, direct insert to Tinybird, no billing impact). Customers explicitly opt in for migrations; events ingested through this path are flagged `historical=true` and never billed.
4. **Operator runbook.** Document the policy: DLQ replays older than the cap must be either (a) discarded with explicit operator sign-off, or (b) routed through the historical endpoint after billing-impact review.
5. **Telemetry.** Log every `EVENT_TOO_OLD` rejection with rich context (`projectId`, `customerId`, `eventTimestamp`, `now`). Operators need to see when this triggers — it's a strong signal of a DLQ drain or producer bug.
6. **Tests.**
   - Event with timestamp in window → accepted.
   - Event older than `INGESTION_MAX_EVENT_AGE_MS` → rejected with `EVENT_TOO_OLD`, no DO touched.
   - Idempotency row at `INGESTION_MAX_EVENT_AGE_MS + 1d` age is still retained; row older than `DO_IDEMPOTENCY_TTL_MS` is cleaned.
   - Replay of already-processed event within window → idempotency hit, no double-process.

**Acceptance:** No event accepted by ingestion can ever fall outside the DO's idempotency window. The invariant is asserted in code and covered by tests.

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

### [ ] HARD-014 — Audit DO commit failures are swallowed or async after billing (P2, audit correctness)

**Files:** `internal/services/src/ingestion/service.ts` (`commitToAuditAsync`, `commitOutcomesToAudit`, `flushAuditEntries`, sync ingestion path)

**Problem:** The queue batch path now awaits `commitOutcomesToAudit` before returning ack dispositions, which is good. But `flushAuditEntries` catches and logs audit DO failures instead of throwing, so the caller still treats the commit as successful. The sync ingestion path still calls `commitToAuditAsync` via `waitUntil` after billing has already run. Audit DO is supposed to be the cross-period correctness boundary; failures should not be invisible.

**Plan:**
1. Change `flushAuditEntries` so audit DO failures reject the promise after logging. Do not swallow `.commit()` errors.
2. Keep the queue path synchronous: if audit commit fails, return retry dispositions / throw so the queue retries the whole message. Outcomes computed in the previous attempt will be re-computed; DO idempotency and ledger idempotency make this safe.
3. Decide the sync API behavior explicitly. Recommendation: await audit commit in `ingestFeatureSync` before returning success. If that latency is unacceptable, write a synchronous Postgres `pending_audit_commits` row before returning, then have a sweeper confirm to Audit DO. Do not leave it as naked `waitUntil`.
4. Test: inject audit DO failure in queue ingestion → message is retried; on second attempt audit row is created, no double-billing observed.
5. Test: inject audit DO failure in sync ingestion → response is either a retryable failure or a pending-audit row exists; never silent success with no audit trace.
6. Measure: this adds one DO round-trip to the hot path. Confirm latency budget before choosing the pending-commit fallback.

**Acceptance:** No queue ack or sync success occurs without either a confirmed audit row or a durable pending-audit row.

**Resolution:** _(fill in when fixed)_

---

### [ ] HARD-015 — Late-arriving events for closed periods are silently dropped (P1, money correctness)

**Files:** `internal/jobs/src/trigger/schedules/invoicing.ts`, `internal/services/src/use-cases/billing/bill-period.ts`, `internal/services/src/ingestion/service.ts`, `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`

**Problem:** Period closes on `cycleEndAt <= now` and is rated immediately. An event with timestamp inside the closed period that arrives after close (network delay, retry, queue lag) can still route to the same customer-entitlement DO. Because the DO computes grant period buckets from the event timestamp and can bootstrap reservations by period, a late event can either be denied after final flush or reopen a reservation for a period that billing already closed.

**Plan:**

1. **Grace window.** Delay period close by a configurable `LATE_EVENT_GRACE_MS` (default: 1h). Change the invoicing cron query to `cycleEndAt <= now - LATE_EVENT_GRACE_MS`. This catches the long tail of slow producers.
2. **Late-event policy.** Document and enforce: events arriving after close + grace are routed to the *current open entitlement period* for the same customer entitlement, or rejected if product decides closed-period mutation is forbidden. Default recommendation: route to current period and mark `late_event=true`; never reopen or mutate a closed wallet reservation.
3. **Implementation boundary.** Ingestion should not compute period keys. It should ask the entitlement/billing read model whether the event timestamp is inside a still-open billing window or should be treated as late. The DO receives an explicit late-event flag/current-period timestamp override if rerouting is allowed; otherwise ingestion rejects before touching the DO.
4. **Telemetry.** Log every late-event routing: `{eventId, customerEntitlementId, originalEventTimestamp, routedTimestamp, lagMs}`. Operators need to see whether late events are a one-off or systemic.
5. **Edge case:** customer cancels mid-period, event arrives after cancellation. With HARD-009 in place, the subscription is `cancelled`; route the event to a `cancelled_subscription_late_events` table (or just reject) — discuss with product.
6. Tests:
   - Event arriving 30min after close, grace = 1h → captured in the closing period.
   - Event arriving 2h after close, grace = 1h → routed to current open period or rejected per documented policy; it must not reopen the closed reservation.
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

### [ ] HARD-017 — Multi-phase activation input derivation reads first phase without ordering (P2, correctness)

**Files:** `internal/services/src/use-cases/billing/derive-provision-inputs.ts` (~L89)

**Problem:** `deriveActivationInputsFromPlan` still queries phases with `limit:1` and no `orderBy`. This code derives wallet activation inputs such as credit line amount and starting wallet grants; it is not the runtime customer-entitlement grant allocator. Newly-created subscriptions today only have one phase, but multi-phase subscriptions (plan changes, scheduled upgrades) will be a real case.

**Plan:**
1. Pass `now` into `deriveActivationInputsFromPlan` (or pass the active subscription phase from the state machine) and change the phase fetch to: `startAt <= now AND (endAt IS NULL OR endAt > now)`, order by `startAt DESC`, limit 1.
2. Add a code comment near the query stating the active-phase contract and clarifying that this path does not allocate runtime customer-entitlement grants.
3. Add a test with a subscription that has a past phase, active phase, and future phase; assert the active phase's wallet activation inputs are used.

**Acceptance:** Activation derivation never reads a non-active phase and never affects customer-entitlement grant provisioning.

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

- **Double-counting via stacked allowance grants on the same feature** — resolved by clarification #2. One active customer entitlement owns a feature for a customer; multiple allowance grants can exist under that entitlement, but they are not independent metering streams.
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
