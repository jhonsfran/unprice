# Lessons

Durable repo memory for repeatable rules, failure modes, commands, and test
patterns. Keep it cheap to load and useful.

## How To Use

- Read before non-trivial code, test, docs, migration, billing, or architecture work.
- New lessons must be dated, repo-specific, and short: 1-3 bullets per entry.
- Use "When X, do Y; watch Z". Include files or commands only when they prevent repeats.
- Update an existing section instead of adding duplicate narrative.
- Do not record secrets, customer data, or one-off local noise.
- Architecture rule changes need an ADR link.

## Cloudflare, API, And Ingestion

- 2026-05-09: Removing a Durable Object class needs `deleted_classes` in the affected
  `apps/api/wrangler.jsonc env.*` migration.
- 2026-05-08: `entitlement/verify` stays compact: decision fields only, no internal
  entitlement metadata.
- 2026-05-08: `/v1/usage/get` returns raw usage/spend from Tinybird; Hono formats display money.
- 2026-05-08: Keep Tinybird response parsers tolerant during endpoint rollouts; old cloud
  shapes can lag local code.
- 2026-05-08: `entitlement_meter_facts` needs no synthetic `id`; use `amount` for event spend
  and `amount_after` for cumulative spend.
- 2026-05-08: Sync ingest idempotency must re-enter entitlement apply replay, not synthesize a
  duplicate from audit `exists`.
- 2026-05-08: API wallet-empty messages should use configured meter/event slugs, not derived
  storage keys.
- 2026-05-09: `/v1/events/ingest/sync` must await strict `IngestionAuditDO.commit`; `waitUntil`
  alone is not durable enough.
- 2026-05-09: Strict audit payload conflicts are expected idempotency failures; map them to API
  `409 CONFLICT`.
- 2026-05-09: Keep sync ingest on the low-latency auth path with `Server-Timing`; do not add the
  API-key rate-limit binding.
- 2026-05-09: Persist final wallet flush intent before external wallet I/O so recovery replays
  final flushes as final.
- 2026-05-09: Serialize native `Error` objects before `evlog.log.error`; Cloudflare/Axiom can
  otherwise store `{}`.
- 2026-05-17: Axiom-bound logs should normalize known camelCase aliases in
  `@unprice/observability`; keep business fields snake_case to avoid duplicate columns.
- 2026-05-08: Test DO eviction/recovery with a new DO instance over the same fake storage.
- 2026-05-11: For usage concurrency, test `EntitlementWindowDO` and `IngestionAuditDO`, not only
  the service adapter.
- 2026-05-08: Tiny-tools usage discovery reads `featurePlanVersion.meterConfig` from
  `entitlements.get`; `verify` is only for the decision.
- 2026-05-11: Tier/package entitlements are static quantity limits from subscription grants; do
  not add meters for them unless the product explicitly needs separate snapshot usage.
- 2026-05-15: API load tests should use `tooling/k6/baseline.js` with one `PROJECT_ID`, one
  `CUSTOMER_ID`, and `EVENTS=1000`; it discovers meters through `entitlements.get`, sends async
  usage grouped by event slug, and verifies every entitlement without signup/payment flows.

## Billing, Wallets, And Invoices

- 2026-05-06: `pay_in_advance` moves fixed fees to period start only; usage actuals invoice at
  period end.
- 2026-05-06: Billing-period rating requires active entitlement grants; no grants intentionally
  means no charges.
- 2026-05-06: Zero-total periods still need local invoices; read models merge ledger-backed and
  zero-cost synthetic lines.
- 2026-05-06: Resolve `resetAnchor: "dayOfCreation"` from entitlement effective date before
  monthly cycle/proration math.
- 2026-05-06: Validate invoice `status` and `dueAt` before loading the subscription machine.
- 2026-05-06: Direct free, zero-amount, and sandbox provisioning must not depend on payment
  webhooks.
- 2026-05-06: If signup returns `200` but stays `pending_activation`, inspect wallet activation
  and `openlogs` before payment webhooks.
- 2026-05-06: Project funding accounts must exist before customer wallet movements:
  `topup`, `promo`, `plan_credit`, `manual`, and `credit_line`.
- 2026-05-06: Wallet balances are state buckets; use ledger entries or `issued_amount` for grant
  history.
- 2026-05-06: Wallet bigint amounts are ledger-scale minor units; pgledger views are decimals.
- 2026-05-06: `creditLineAmount` is period usage allowance, not plan fee or creditworthiness.
- 2026-05-06: Arrears plans can derive allowance from finite priced usage limits; unlimited paid
  usage needs explicit allowance or balance.
- 2026-05-06: Reserve wallet funds only for positive projected cost; zero-cost usage bypasses
  reservation after entitlement verification.
- 2026-05-08: Public wallet reads expose display money plus `ledger_amount`; avoid raw accounting
  buckets on the public surface.
- 2026-05-08: Capped subscription usage is wallet-backed; keep wallet assertions in
  `tooling/tiny-tools/plan-wallet.ts`.
- 2026-05-08: `allocation_amount` is reservation runway, not consumed usage; keep DO id metadata
  for traceability.
- 2026-05-08: On finite limit reached, close active wallet reservations through the final-flush
  helper.
- 2026-05-08: Treat `WALLET_EMPTY` as possibly DO-local underfunding; flush+refill once before
  denying.
- 2026-05-08: Prefer `/v1/wallet/balance`; keep `/v1/wallet` as compatibility and credit balance
  reads under `/v1/wallet/credits/{walletId}/balance`.
- 2026-05-08: Saved subscription phase `creditLinePolicy` and `creditLineAmount` are immutable.
- 2026-05-08: Fractional meter deltas price against integer tiers; unmatched quantities return
  calculation errors.
- 2026-05-08: Pass scaled quantities to Dinero for fractional usage; raw JS decimals can throw or
  mis-price.
- 2026-05-07: Day/week/month/year billing starts at the beginning of the UTC day; minute billing
  stays timestamp-exact.
- 2026-05-11: `billPeriod` concurrency tests should assert persisted invoices, periods, ledger
  idempotency, and pgledger entries.
- 2026-05-11: BILL rollback tests should fail the second `LedgerGateway.createTransfer` to prove
  transaction rollback.
- 2026-05-11: A stamped `invoicePaymentProviderId` is not proof of provider finalization; retries
  must reload and finish provider work.
- 2026-05-11: Draft invoice finalization must reread while holding the subscription lock.
- 2026-05-11: If local invoice update fails after provider work, retry from the stamped provider
  invoice without duplicating items.
- 2026-05-11: Subscription machine locks use wall-clock time plus heartbeat `extend()`, not
  billing-window `context.now`.
- 2026-05-09: `wallet_only` skips BILL/SETTLE; test it as wallet-only, not as capped arrears.
- 2026-05-09: Capped usage that should invoice at period end should use `pay_in_arrear` plus
  capped credit-line policy.
- 2026-05-09: Money-path plans should stay service-only first: golden cases, properties, stateful
  models, scenario DSL, and ledger invariants.
- 2026-05-11: Provider invoice 404/error on stamped id should clear the id and fall through to
  create.
- 2026-05-11: Provider invoice item orphan detection can warn only; the provider interface has no
  delete-item method.
- 2026-05-11: `withLockedMachine` mocks must pass `assertLockHeld` as the second `run` arg.
- 2026-05-11: Reference billing model has no grant expiry; add expiry support before expiry
  golden cases.

Related: [ADR-0002](docs/adr/ADR-0002-wallet-payment-provider-activation-guardrails.md).

## API SDK And Public Contracts

- 2026-05-08: Public Hono routes callable from `@unprice/api` need SDK-shaped `operationId`s.
- 2026-05-08: Align first OpenAPI tag and first `/v1` path segment with the SDK namespace.
- 2026-05-08: Keep SDK resource methods as one-object calls grouped by product concepts.
- 2026-05-08: Payment methods live under `/v1/payments/methods/*`; provider callbacks/webhooks
  under `/v1/payments/providers/*`.
- 2026-05-06: Tiny-tools fake customer tests should use real feature slugs and expect
  `customer_not_found`, not `feature_missing`.
- 2026-05-06: Validate local provisioning with signup E2E before usage E2E:
  `UNPRICE_TOKEN=unprice_dev_1234567890 pnpm --filter @unprice/tiny-tools e2e:signup:local`.

## Payment Providers And Stripe

- 2026-05-11: New payment provider adapters must pass the reusable provider contract suite before
  relying on service billing integration tests.
- 2026-05-07: Use Stripe `invoice.paid` as the canonical success signal; do not process both
  `invoice.payment_succeeded` and `invoice.paid`.
- 2026-05-11: Stripe Connect readiness UI should read `connectionData.requirements.errors` and
  due fields; `disabledReason` alone is too generic for failed verification.
- 2026-05-07: Stripe Connect webhooks should reject unsupported event types after signature
  verification and before account lookup/persistence.
- 2026-05-07: For Connect Standard accounts, pass owner email on create but do not update
  `account.email` on reused accounts.
- 2026-05-11: Stripe invoice line fixtures must be Stripe-shaped: lowercase currency and
  `price.product` as string or expanded object.
- 2026-05-11: Signed webhook tests should use real Stripe SDK signature verification; mock only
  outbound API calls.
- 2026-05-11: Async paid-invoice lifecycle integration tests should return `open` from
  `collectPayment`, then deliver a paid webhook.
- 2026-05-11: DB-backed webhook retry tests can proxy the real `WalletService` and fail only the
  first `settleReceivable` call, preserving real ledger writes on replay.
- 2026-05-11: `SubscriptionMachine` should not re-persist its restored initial status when it
  matches the DB row; that async write can race and overwrite a later transition.
- 2026-05-11: A DB-backed cancellation golden should assert both sides: the earned period still
  invoices, and no billing periods or invoices exist with `cycle_start_at_m >= canceled_at`.
- 2026-05-11: Do not keep invoice-time credit application paths in code or fixtures. Wallet
  credits drain through reservation/flush, and manual credits use `WalletService.adjust`.
- 2026-05-11: Wallet top-up webhooks settle only after provider normalization maps the checkout
  completion to `payment.succeeded` with `metadata.kind = "wallet_topup"`.
- 2026-05-11: Ledger account seeding must lock per account name before pgledger create; account
  names are not database-unique, so first-use wallet operations need DB-backed concurrency tests.
- 2026-05-11: Wallet credit expiration belongs in the services use-case layer; the Trigger
  schedule should call that seam, and the sweep must stamp fully drained expired credits without
  posting a zero-amount ledger transfer.

## UI And Dashboard

- 2026-05-07: After provider payment-method setup, bypass `customerPaymentMethods` cache and poll
  before showing an empty state.
- 2026-05-07: Keep subscription creation drafts open while provider setup runs; refetch with
  `skipCache` and auto-select the first method.

## Tests, Tooling, And Docs

- 2026-05-09: For `docs/plans/**`, use
  `pnpm biome check --no-errors-on-unmatched docs/plans/<file>.md` plus `git diff --check`.
- 2026-05-09: `docs/plans/**` is gitignored; inspect with `git status --ignored` or force-add
  when reporting plan-only work.
- 2026-05-09: Integration tests should import migration helpers from `@unprice/db/migrate`, not
  `internal/db/src/migrate.ts`.
- 2026-05-09: Keep `*.integration.test.ts` out of normal service unit config; use
  `test:integration`.
- 2026-05-09: Serialize service integration tests that share `unprice_test`: one worker,
  `maxConcurrency: 1`, and matching script flags.
- 2026-05-09: Focused integration scripts are useful when DB state must remain for `psql`
  inspection.
- 2026-05-09: Wallet reservation callers with event time should pass `effectiveAt`.
- 2026-05-17: EntitlementWindowDO non-final flush retries must reuse persisted
  `pending_refill_amount`; do not recompute adaptive refill size for an existing
  `pending_flush_seq`.
- 2026-05-17: EntitlementWindowDO wallet retries must persist the whole ledger intent
  (`pending_flush_seq`, `pending_flush_amount`, refill/final flags); one ledger idempotency
  key must never replay with a recomputed financial payload.
- 2026-05-10: Billing properties stay replayable with `UNPRICE_PROPERTY_SEED` and tunable with
  `UNPRICE_PROPERTY_RUNS`.
- 2026-05-10: Keep DB-backed properties separate from pure/fake-service properties.
- 2026-05-10: Service property fixtures should satisfy full validator shapes; avoid partial casts.
- 2026-05-11: DB billing properties must encode seeded tier contracts explicitly, not infer from
  one golden usage value.
- 2026-05-11: Capped wallet DB properties reserve/flush actual usage cost and assert consumed
  bucket plus remaining credit balance.
- 2026-05-11: `pay_in_advance` DB properties assert period-start fixed and period-end usage
  statements separately.
- 2026-05-11: Lock tests need real owner-token behavior; fake DB locks must verify `ownerToken`
  on extend.
- 2026-05-11: Stateful reference-model tests should apply generated commands one at a time and
  assert invariants after every step.
- 2026-05-11: `computeProratedRefundAmount` tests need `tx.query.invoices.findFirst`, plus
  `phaseStartAt`, `billingAnchor`, and `billingConfig`.
- 2026-05-11: Mock `calculateProration` through `@unprice/db/validators`.
- 2026-05-11: `LedgerGateway.getInvoiceLines` returns `Result<InvoiceLine[]>`; mocks return a
  flat array in `.val`.
- 2026-05-11: Fake `InvoiceLine.amount` as Dinero-like `{ toJSON: () => ({ amount }) }`.
- 2026-05-11: `transitionInvoiceStatus` treats current `"failed"` as `already_applied` for
  `payment_reversed`.
- 2026-05-11: `getInvoiceStatementLines` orders ledger-backed lines before synthetic zero lines.
- 2026-05-11: Raw SQL bigint millisecond columns can return strings; normalize with `Number(...)`
  before timestamp assertions.
- 2026-05-11: Subscription phase entitlements/grants preserve exact phase timestamps, but billing
  period materialization can normalize sub-day starts to the UTC day boundary; assert those
  invariants separately.
- 2026-05-11: Future subscription phases should not receive entitlements/grants until the phase is
  activated/synced at its start boundary.
- 2026-05-11: DB-backed integration files that install or initialize pgledger should run through the
  serialized integration script; launching them concurrently can race Postgres extension setup.
- 2026-05-11: Prefer Drizzle table inserts/updates for DB-backed test fixtures; use raw SQL only
  for DB-native behavior or pgledger views so schema drift fails at typecheck.
- 2026-05-11: The billing schema has no `hour` interval; model hourly cadence as
  `billingInterval: "minute"` with `billingIntervalCount: 60`.
- 2026-05-11: Deterministic DB fixture ids must stay within the shared cuid column length
  (`varchar(36)`); Drizzle catches shape drift, but length constraints still fail at runtime.
