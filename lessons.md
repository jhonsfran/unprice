# Lessons

This file is durable working memory for agents and maintainers. Add a lesson
when a task reveals a repo-specific rule, failure mode, build process detail, or
debugging shortcut that should influence future work.

## How To Use

- Read this file before making non-trivial changes.
- Add concise, dated entries when new durable lessons are learned.
- Prefer concrete rules over narrative. Include affected files, commands, or
  docs when useful.
- Do not record secrets, tokens, private customer data, or one-off local noise.
- If a lesson changes an architecture rule, update or create an ADR and link it.

## 2026-05-09: Cloudflare Durable Object class removal

- If deploy fails with “does not export class `X` which is depended on by
  existing Durable Objects”, the account still registers that class from an
  older deploy. After removing the binding from `wrangler.jsonc`, add a new
  migration tag with
  `"deleted_classes": ["X"]` in   `apps/api/wrangler.jsonc` for the affected
  `env.*` blocks. This permanently deletes all DO instances of that class.
  If only production ever shipped the removed class, add the `deleted_classes`
  migration under `env.prod` only. Docs:
  [Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

## 2026-05-06: Wallet, Payment Provider, And Activation Lessons

- `pay_in_advance` only means fixed subscription charges bill at period start.
  Usage charges are actuals-based and must invoice at period end; otherwise a
  start-of-cycle zero rating can void the usage billing periods before usage
  exists.
- Billing-period rating must resolve the active customer entitlement grants for
  the subscription item. Calling `RatingService.rateBillingPeriod` without
  grants intentionally returns no charges.
- Zero-total billing periods still need a local invoice row. Finalization can
  void or skip provider collection later, but the statement must exist so the
  dashboard can show what was invoiced for the period.
- Zero-cost invoice items do not have ledger entries. Invoice read models must
  merge ledger-backed lines with invoiced billing periods so statement details
  still show every item at `0`.
- Feature reset configs may use `resetAnchor: "dayOfCreation"`. Rating must
  resolve that anchor from the customer entitlement effective date before
  calling monthly cycle/proration helpers; coercing it to `0` breaks monthly
  invoice generation.
- Invoice finalization must validate the invoice row (`status` and `dueAt`)
  before loading the subscription machine. Draft invoices scheduled in the
  future should return a domain error such as "not ready to finalize yet"
  instead of leaking raw subscription-machine query failures to the dashboard.
- Direct free, zero-amount, and sandbox provisioning must not depend on payment
  webhooks. Webhooks settle provider-owned outcomes; they should not be required
  to make direct signup activation work.
- If signup returns `200` but the subscription parks in `pending_activation`,
  inspect wallet activation first. Search openlogs for `pending_activation`,
  `activateSubscription`, `Wallet activation`, and `Failed query: commit`.
- Project funding accounts are required before customer wallet movements:
  `platform.{projectId}.funding.topup`, `promo`, `plan_credit`, `manual`, and
  `credit_line`.
- Customer wallet account balances are state buckets, not history. A grant can
  move `available.granted -> reserved -> consumed`. Use `pgledger_entries` or
  `unprice_wallet_credits.issued_amount` to inspect the original grant.
- Wallet bigint amounts are ledger-scale minor units. Pgledger account views are
  decimal balances. Normalize before comparing both sides.
- Ledger scale examples: `1 EUR = 100_000_000`, `100 EUR = 10_000_000_000`,
  `0.10 EUR = 10_000_000`.
- `creditLineAmount` means explicit period usage allowance. It is not the plan
  fee and not customer creditworthiness.
- For arrears plans, `creditLineAmount = 0` may derive a conservative allowance
  from finite priced usage limits. Unlimited paid usage still requires an
  explicit allowance or purchased balance.
- Reservations are for positive projected cost only. Zero-cost usage should
  verify entitlement and bypass wallet reservation.
- Tiny-tools E2E should verify real feature slugs from nested entitlement data.
  Fake customer tests must use a real feature slug and expect
  `customer_not_found`, not `feature_missing`.
- Use the signup E2E before usage E2E when validating local provisioning:
  `UNPRICE_TOKEN=unprice_dev_1234567890 pnpm --filter @unprice/tiny-tools e2e:signup:local`.

Related: [ADR-0002: Wallet And Payment Provider Activation Guardrails](docs/adr/ADR-0002-wallet-payment-provider-activation-guardrails.md).

## 2026-05-08: Entitlement Meter Facts And Verify Shape

- Do not add a synthetic `id` to `unprice_entitlement_meter_facts`. Tinybird already dedupes these
  rows with the ReplacingMergeTree sorting key built from existing business columns, so a repeated
  ID only stores redundant data and makes the outbox payload larger.
- Track both event spend and cumulative period spend in entitlement meter facts:
  `amount` is the signed price delta for the event, and `amount_after` is the total priced spend
  after that event, mirroring `delta` and `value_after`.
- Keep `/v1/usage/get` customer-facing: Tinybird usage period endpoints should return raw
  `usage`, `amount_after`, and `currency`; the Hono route owns formatting `amount_after` into
  `{ amount, currency, display_amount }`.
- During Tinybird endpoint schema rollouts, keep the analytics client row schema tolerant of the
  previous response shape until the Cloud endpoint is deployed. For usage periods, accept legacy
  `value_after` and let the Hono route fall back to project currency plus zero spend instead of
  surfacing parser errors as `500`s.
- Keep `entitlement/verify` as a compact decision response. Return `allowed`, `featureSlug`,
  optional uppercase `rejectionReason` from `INGESTION_REJECTION_REASONS`, optional
  `usage`/`limit`, and optional `spending` with `displayAmount`; do not expose internal entitlement
  metadata like meter config, overage strategy, effective windows, or synthetic status.
- Tiny-tools usage discovery should read `featurePlanVersion.meterConfig` from
  `entitlements.get`, then call `entitlements.verify` only for `allowed`, `usage`, `limit`, and
  `rejectionReason`.

## 2026-05-08: Sync Ingestion Idempotency Replay

- For `/v1/events/ingest/sync`, do not use the ingestion audit `exists` check to synthesize a
  duplicate response. Re-enter the entitlement window and let its idempotency table replay the
  original apply result, including `WALLET_EMPTY`/`LIMIT_EXCEEDED` messages.
- Keep derived meter keys for storage and logs, but API-facing wallet-empty messages should use the
  configured meter/event slug instead of the full `slug=...|method=...|field=...` key.
- Test `EntitlementWindowDO` eviction by constructing a new DO instance over the same fake durable
  storage, not by trying to force Cloudflare OOM. Inject failures between external I/O and local
  SQLite fold commits to prove idempotency rows, outbox rows, lazy reservation bootstrap, and
  `pendingFlushSeq > flushSeq` recovery converge.

## 2026-05-08: Fractional Usage Tier Pricing

- Meter deltas may be fractional, for example `0.1`, even though tier definitions use
  integer `firstUnit`/`lastUnit` boundaries. Positive usage below the first tier boundary should
  price against the first tier; tier calculators must return a calculation error for unmatched
  quantities instead of assuming a tier exists and throwing a raw `TypeError`.
- When multiplying Dinero prices by fractional usage, pass the quantity as a scaled amount
  (`{ amount, scale }`) rather than a raw JS decimal. Raw decimals can throw or mis-price
  sub-cent tier prices such as `0.001`.

## 2026-05-08: Wallet Read API Display Amounts

- Public wallet reads should expose customer-facing money objects, not only ledger-scale integers.
  Include the raw `ledger_amount` for precision/debugging plus exact major-unit `amount`,
  `currency`, and localized `display_amount`.
- Keep public wallet reads current-state focused: expose simple display fields such as `available`
  and `held`, not raw accounting buckets like `granted`, `reserved`, and `consumed`. The consumed
  ledger account can include non-wallet subscription charges and is easy to misread as current
  wallet usage.
- Capped subscription usage is wallet-backed. Keep wallet assertions in the dedicated
  `tooling/tiny-tools/plan-wallet.ts` E2E; usage E2E should stay focused on ingestion and exact
  entitlement usage deltas.
- Entitlement reservation `allocation_amount` is wallet runway, not consumed usage. It can exceed
  `consumed_amount` after a refill; explain it as initial reserve plus refill chunks minus flushed
  consumption, and keep the DO id in reservation metadata for traceability.
- When usage reporting or entitlement verification observes a reached finite entitlement limit,
  close any active wallet reservation by scheduling the DO final-flush path. Keep recovery,
  deletion-cleanup, and pending wallet-flush skip guards inside the final-flush helper.
- `WALLET_EMPTY` from `EntitlementWindowDO` can mean the DO-local reservation is underfunded, not
  that the customer wallet is empty. Before caching `WALLET_EMPTY`, synchronously flush+refill the
  reservation once from `WalletService`; only deny when the wallet cannot grant enough runway.
- Prefer `wallet.balance` / `/v1/wallet/balance` for the public read surface. Keep `/v1/wallet` as
  a compatibility alias, and use `/v1/wallet/credits/{walletId}/balance` for one `wcr_...` credit.

## 2026-05-08: Subscription Phase Credit Policy Immutability

- Once a subscription phase is saved, keep its `creditLinePolicy` and `creditLineAmount`
  immutable. The dashboard should show the saved values as disabled controls, and
  `SubscriptionService.updatePhase` should preserve the stored values because wallet grants and
  billing periods may already have been created from the original policy.

## 2026-05-08: API SDK Endpoint Drift Guard

- Public Hono API routes that should be callable from `@unprice/api` should use SDK-shaped
  `operationId`s. The SDK metadata test compares route operation IDs in `apps/api/src/routes/**`
  with namespace methods exposed by `Unprice`; it intentionally excludes payment-provider
  callback/webhook routes. Do not add a separate endpoint registry when the OpenAPI path types and
  client method surface can be checked directly.
- Keep public route `operationId`s aligned with the SDK namespace/method shape, not necessarily
  with the API route folder that owns the HTTP handler. Keep the first OpenAPI tag aligned with the
  operation namespace. The first path segment after `/v1` must also match the route namespace. For
  example, `/v1/entitlements/get` should use `entitlements.get`
  and tag `entitlements` so the generated OpenAPI contract points at the intuitive SDK call.
- Keep SDK resource methods as one-object calls and group them by product concepts, not raw route
  owners: `entitlements.get({ customerId })`, `subscriptions.get({ customerId })`,
  `payments.methods.list({ customerId, provider })`, `usage.get({ range })`,
  `features.list()`, `plans.getVersion({ planVersionId })`, and `invoices.get({ invoiceId })`.
- Keep payment method endpoints under `/v1/payments/methods/*` and provider callback/webhook
  endpoints under `/v1/payments/providers/*`; both live in `apps/api/src/routes/payments`.

## 2026-05-09: Worker Environment Error Logging

- Do not put native `Error` instances directly inside plain `evlog.log.error({...})` payloads.
  Cloudflare/Axiom JSON serialization can turn them into `{}` and hide the message. Serialize to
  `{ type, message, stack }` first, as in `apps/api/src/errors/log.ts`.

## 2026-05-09: Sync Ingestion Durability

- `/v1/events/ingest/sync` must not rely on `waitUntil` as the only durability boundary for
  canonical ingestion audit rows. Await a strict `IngestionAuditDO.commit` after the
  `EntitlementWindowDO.apply` result so the audit DO owns publishing through its outbox.
- Strict audit payload conflicts are expected idempotency failures, not platform failures. Throw a
  typed ingestion error and map it to API `409 CONFLICT` with guidance to retry the exact original
  event or use a new `idempotencyKey`.
- Keep `/v1/events/ingest/sync` on the low-latency auth path like entitlement verification:
  bypass the API-key rate-limit binding and use `Server-Timing` spans around the service call so
  auth, routing, entitlement apply, and audit commit latency can be separated in traces.
- When a wallet final flush is pending, persist that it is final before external wallet I/O.
  Recovery must replay a pending final flush as `final: true`; replaying it as a mid-period refill
  can strand a locally open reservation after the wallet reservation has already reconciled.

## 2026-05-09: Markdown Plan Validation

- Biome does not process Markdown plan files by default. For docs-only plan edits under
  `docs/plans/**`, use
  `pnpm biome check --no-errors-on-unmatched docs/plans/<file>.md` plus `git diff --check` instead
  of the plain targeted Biome command, which exits with "No files were processed."
- `docs/plans/**` is gitignored. Normal `git status` and `git diff` will not show changes to those
  plan files unless they are force-added or inspected with `git status --ignored`; mention this when
  reporting plan-only work.
- For service DB integration tests, do not import `internal/db/src/migrate.ts` as a script. Use the
  exported helpers from `@unprice/db/migrate` so tests can run Drizzle migrations and pgledger
  installation without also executing the dev admin/project seed path.
- Keep `*.integration.test.ts` excluded from `internal/services/vitest.config.ts`. The normal
  `pnpm --filter @unprice/services test` command must stay fake/unit only; use
  `pnpm --filter @unprice/services test:integration` for Docker/Postgres-backed tests.
- Keep `internal/services/vitest.integration.config.ts` file-level parallelism disabled while
  integration tests share one `unprice_test` database and truncate/re-seed in `beforeEach`. Also
  force one worker and `maxConcurrency: 1`; otherwise separate scenario files can overlap and erase
  another file's fixture state mid-run. Keep the same serialization flags on the
  `test:integration` script, because config-only settings did not prevent overlap in Vitest 2.1.9.
- Use one of the focused integration scripts when a DB-backed billing workflow needs to leave
  rows behind for psql inspection. Each focused script runs a single integration file. The full
  integration suite's final test determines the remaining database state.
- Wallet reservation callers should pass `effectiveAt` when draining or refilling wallet credits.
  The service defaults to the current clock only for callers that do not have event time. This keeps
  deterministic billing fixtures from becoming undrainable just because the test window is now in
  the past relative to the real database clock.

## 2026-05-10: Billing Property Tests

- Keep fast-check billing properties seedable through `UNPRICE_PROPERTY_SEED` and configurable
  through `UNPRICE_PROPERTY_RUNS`; this makes minimized failures replayable without slowing normal
  PR runs.
- Keep DB-backed property tests separate from pure/reference and fake-service properties. Real
  Postgres plus pgledger cases need lower iteration counts and explicit fixture reset.
- Service property fixtures should satisfy the full validator shape even when a test uses only one
  part of the object. For rating grants, include a real `billingConfig`; casting partial grant
  objects hides schema drift that `tsc` can catch.

## 2026-05-11: DB-Backed Billing Properties

- Do not infer fixture pricing from one golden usage value. The monthly arrears P0 fixture uses
  volume tiers (`1..1000` events: `1 EUR + 0.001 EUR/event`; `1001+`: `0.10 EUR/event`), so
  generated DB properties should encode the seeded tier contract explicitly.
- For capped wallet DB properties, reserve and flush the generated actual usage cost, not the full
  credit line. Then assert both the consumed bucket and remaining `unprice_wallet_credits` balance;
  this proves partial credit-line drains as well as the full-drain boundary.
- For `pay_in_advance` DB properties, always assert the two statement keys separately. Fixed
  charges belong to the period-start statement; usage actuals belong to the period-end statement,
  even when both use the same cycle window and plan version.

## 2026-05-11: BILL Failure And Concurrency Tests

- `billPeriod` returns `phasesProcessed` from pre-lock pending statement groups. In concurrency
  tests, multiple workers can report work even when only the first worker posts ledger entries.
  Assert persisted state instead: invoice count, period statuses, ledger idempotency, and
  `pgledger_entries_view`.
- For BILL rollback tests, fail the second `LedgerGateway.createTransfer` call. That proves the
  first successful transfer attempt was still inside the transaction and rolls back with the
  injected failure.
- In invoice finalization, a stamped `invoicePaymentProviderId` does not mean provider finalization
  completed. Retries must reload the provider invoice and complete draft item/finalize work before
  flipping the local invoice out of `draft`.
- Draft invoice finalization must reread the invoice while holding the subscription lock. Locking
  after a preflight read is not enough; a second worker can otherwise act on stale `draft` state
  after the first worker has finalized the invoice.
- If invoice finalization completes provider work but fails the local status update, retry from the
  stamped `invoicePaymentProviderId`. The retry must poll/reuse the provider invoice and only flip
  local state; it must not create duplicate provider invoices or provider items.
- Do not mock unique lock owner tokens as a substitute for real DB lock tests. `randomId()` once
  encoded a zero-filled buffer and returned a constant token; fake lock tests with mocked tokens
  missed that stale owners could release a lock after another worker took it over. Keep this token
  edge-safe and non-crypto; it is an ownership nonce, not a secret.
- For usage-ingestion concurrency, test the Durable Object owners, not just the service adapter.
  `EntitlementWindowDO` owns billable usage writes and must collapse concurrent same-key applies to
  one engine application/outbox fact; `IngestionAuditDO` owns audit idempotency and must classify a
  concurrent same-key commit as a duplicate while keeping one row.
- Subscription machine locks should use operational wall-clock time, not billing-window
  `context.now`. Long-running machine work needs a heartbeat `extend()` loop so a slow provider or
  billing call does not let another worker take over after the original TTL.
- Stateful reference-model tests should apply generated commands one at a time and assert
  invariants after every step, not just at the end. That gives fast-check a useful shrink target and
  makes `UNPRICE_MODEL_SEED=<seed> pnpm --filter @unprice/services test:billing-stateful` a real
  replay path.

## 2026-05-09: Service Workflow Billing Test Priorities

- When testing capped usage that should still produce a period-end invoice, use `pay_in_arrear`
  with capped `creditLinePolicy`/`creditLineAmount`. Do not model it as `wallet_only`;
  `wallet_only` skips BILL and SETTLE in the subscription machine because the wallet is the point
  of charge.
- Test `wallet_only` as its own service workflow: assert wallet accounts/grants/reservations,
  final flush/renewal behavior, balanced wallet ledger entries, and absence of invoice rows or
  payment-provider invoice calls.
- For the metering/billing invariant plan, keep the scope service-only: golden cases,
  property-based tests, stateful model-based lifecycle tests, scenario DSL, and ledger invariants.
  API, SDK, load, and external verifier coverage can reuse the DSL later, but they should not drive
  the core money-path correctness plan.

## 2026-05-07: Payment Method Setup UX Cache Refresh

- After returning from a provider payment-method setup flow, the dashboard must bypass the
  `customerPaymentMethods` service cache and poll briefly before showing a permanent empty state.
  Otherwise a freshly attached provider method can be hidden behind a cached `[]`.
- Keep subscription creation drafts open while provider setup runs in a separate tab/window. The
  original form should enter a confirming state, refetch `customers.listPaymentMethods` with
  `skipCache`, and auto-select the first returned method.

## 2026-05-07: Day-Based Subscription Billing Starts

- Recurring `day`, `week`, `month`, and `year` billing treats subscription and grant starts as the
  beginning of their UTC day for cycle and proration math. This avoids charging a prorated first
  flat fee just because the subscription was created mid-day.
- Keep `minute` billing timestamp-exact so short-cycle local testing and sub-day billing behavior
  remain precise.

## 2026-05-07: Stripe Invoice Webhook Success Event

- Stripe can emit both `invoice.payment_succeeded` and `invoice.paid` for the same successful
  invoice payment. Use `invoice.paid` as the canonical success signal because it also covers free,
  credit-balance, and out-of-band paid invoices. Treating both as actionable can race subscription
  reconciliation and surface `SUBSCRIPTION_BUSY` from the subscription machine lock.
- Stripe Connect webhook routes should reject unsupported event types immediately after signature
  verification, before connected-account lookup or webhook-event persistence, so an over-broad
  Stripe endpoint does not amplify DB load across many connected accounts.

## 2026-05-07: Stripe Connect Standard Account Email

- For Stripe Connect Standard accounts, pass the owner email when creating the connected account,
  but do not update `account.email` on reused accounts. Stripe can reject platform updates with
  "not authorized to edit the parameter 'email'" because the connected account owner controls that
  field through onboarding.

## 2026-05-11: Lock Loss, Provider Resilience, And Test Fakes

- When editing a method signature in the middle of a method definition, take care not to delete
  the closing brace of the type, the `: Promise<T> {` return type, or the `try {` / `return await`
  preamble. The `withSubscriptionMachine` method in `subscriptions/service.ts` was broken by a
  signature edit that accidentally removed the method body opener.
- Fake DB implementations for `SubscriptionLock` must track the acquired `ownerToken` from the
  initial `insert` and verify it against `row.ownerToken` in the extend path. Without this check,
  the extend path always succeeds even after an external takeover, and lock-loss heartbeat tests
  pass spuriously. The real SQL uses `WHERE ownerToken = this.token`.
- When a stamped `providerInvoiceId` returns a 404 or error from `getInvoice`, clear the id and
  fall through to the create path. Propagating the error as `Err` leaves the invoice in a retry
  limbo where every attempt hits the same missing provider invoice.
- Provider invoice item orphan detection should use a `Map.delete` during reconciliation and warn
  about remaining entries after the loop. Since the payment provider interface has no
  `deleteInvoiceItem` method, orphans cannot be removed automatically — only warned about.
- `withLockedMachine` test mocks must pass `assertLockHeld` as the second argument to `run`. The
  production code at `billing/service.ts` calls `assertLockHeld()` before the critical local
  status flip, and a mock that omits it will crash with a runtime error.
- The reference billing model (`test-fixtures/reference-model.ts`) has no grant expiry support.
  `WalletGrant` has no `expiresAt` field and all drain/reserve methods are time-unaware. Adding
  grant expiry mid-period golden cases requires extending the reference model first.

## 2026-05-11: Proration And Statement Line Test Patterns

- `computeProratedRefundAmount` uses `tx.query.invoices.findFirst(...)` (Drizzle relational query
  on the transaction), not a repository method. Test mocks must shape `tx` with
  `{ query: { invoices: { findFirst: vi.fn() } } }` — passing `{} as Database` will throw.
- The same method requires `phaseStartAt`, `billingAnchor`, and `billingConfig` in its input;
  tests that skip those fields only pass if the early-return branches fire first. Provide all
  required fields for cases that exercise the proration math.
- `calculateProration` is imported from `@unprice/db/validators` in `billing/service.ts`. Mock it
  via `vi.mock("@unprice/db/validators", ...)` when you need deterministic proration factors.
- `LedgerGateway.getInvoiceLines` returns `Result<InvoiceLine[], ...>`, where `.val` is a flat
  array. Test mocks returning `Ok({ lines: [...] })` will fail because `.val.reduce` is called
  directly on the array.
- `InvoiceLine.amount` is a `Dinero<number>` object. The code accesses `.toJSON()` to extract
  `.amount`. Test fakes must provide `{ toJSON: () => ({ amount: N }) }` not plain numbers.
- `transitionInvoiceStatus` checks `currentStatus === transition.nextStatus` before
  `allowedFromStatuses.includes(currentStatus)`. For `payment_reversed` (nextStatus `"failed"`),
  a current status of `"failed"` returns `"already_applied"`, not `"disallowed"`. Tests that loop
  over all non-paid statuses must handle `"failed"` separately.
- `getInvoiceStatementLines` merges projected ledger lines (first) with synthetic zero-amount
  lines (second) for billing periods that have no ledger entries. Tests should verify ordering:
  ledger-backed lines precede zero lines in the output array.
