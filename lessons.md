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
- You need to use nvm use to install the proper node version of the project
- Before adding a helper, utility, or repeated row shape, search the repo for an established
  pattern first; reuse or extract the canonical path instead of duplicating logic.

## Cloudflare, API, And Ingestion

- 2026-06-06: EntitlementWindowDO SQLite columns need the schema, contract snapshot, SQL migration,
  `drizzle/migrations.js`, and `drizzle/meta/_journal.json` updated together; otherwise existing
  DOs can type-check but fail at runtime on missing columns. Never create migrations manually, always use pnpm run db:check:ingestion:migrations for the api.
- 2026-06-06: `bin/startup.dev` builds/deploys analytics with `tb --local`; use
  `TB_VERSION_WARNING=0 tb --local --output=json info | jq -r ".local.token"` for the app token,
  because `tb --local token copy "workspace admin token"` can return a static token rejected by
  Tinybird Local API requests.
- 2026-06-06: Local dev startup must override `DATABASE_READ1_URL` and `DATABASE_READ2_URL`
  alongside `DATABASE_URL`; `apps/api/dev.sh` regenerates `.dev.vars` from non-empty parent env
  values and otherwise preserves stale preview read-replica secrets.
- 2026-05-09: Removing a Durable Object class needs `deleted_classes` in the affected
  `apps/api/wrangler.jsonc env.*` migration.
- 2026-05-08: `entitlement/verify` stays compact: decision fields only, no internal
  entitlement metadata.
- 2026-05-17: `entitlement/verify` is read-only for wallet reservations; use apply/alarm paths
  for reservation close and release.
- 2026-05-08: `/v1/usage/get` returns raw usage/spend from Tinybird; Hono formats display money.
- 2026-05-08: Keep Tinybird response parsers tolerant during endpoint rollouts; old cloud
  shapes can lag local code.
- 2026-05-31: Tinybird `AggregateFunction` state migrations that change `argMax` version type
  cannot direct-`CAST` old states; `FORWARD_QUERY` must `finalizeAggregation` the old value and
  `initializeAggregation('argMaxState', value, new_version)` for the new state.
- 2026-05-08: `entitlement_meter_facts` needs no synthetic `id`; use `amount` for event spend
  and `amount_after` for cumulative spend.
- 2026-05-08: Sync ingest idempotency must re-enter entitlement apply replay, not synthesize a
  duplicate from audit `exists`.
- 2026-05-08: API wallet-empty messages should use configured meter/event slugs, not derived
  storage keys.
- 2026-05-09: `/v1/events/ingest/sync` must await durable reporting enqueue; `waitUntil`
  alone is not durable enough for ingestion evidence.
- 2026-05-09: Audit payload drift is asynchronous evidence, not a sync-ingest `409`; group
  `canonicalAuditId` and count distinct `payloadHash` values in the audit lake.
- 2026-05-09: Keep sync ingest on the low-latency auth path with `Server-Timing`; do not add the
  API-key rate-limit binding.
- 2026-05-09: Persist final wallet flush intent before external wallet I/O so recovery replays
  final flushes as final.
- 2026-05-09: Serialize native `Error` objects before `evlog.log.error`; Cloudflare/Axiom can
  otherwise store `{}`.
- 2026-05-17: Axiom-bound logs should normalize known camelCase aliases in
  `@unprice/observability`; keep business fields snake_case to avoid duplicate columns.
- 2026-05-18: Keep `request.*` and `business.*` as the canonical Axiom shape; evlog may use
  top-level summary fields for sampling, but strip exact duplicates in the observability drain.
- 2026-05-18: Axiom events should classify normal wide events with `type: log`; reserve
  `type: metric` for `LogdrainMetrics` payloads.
- 2026-05-18: In `APP_ENV=development`, do not attach a custom drain; let evlog's built-in
  pretty development logger handle console output.
- 2026-06-12: When `openlogs tail <service>` has no registered command stream, inspect the raw
  per-service files directly under `.openlogs`, for example `.api.<timestamp>.raw.log` and
  `.nextjs.<timestamp>.raw.log`. Also you can use openlogs tail -n 100 to get the latest logs.
- 2026-05-18: API Axiom drain flushes should be batched through scheduled `waitUntil`;
  reserve immediate flushes for errors, thrown DO operations, and slow requests.
- 2026-06-08: EntitlementWindowDO batch diagnostics that must be queried in Axiom need a
  first-class drain event; constructor-scoped DO logger entries can be absent from top-level
  Axiom rows, leaving only the outer `runDoOperation` wrapper fields.
- 2026-05-18: HTTP tRPC inside Next.js should enrich the enclosing Next wide event
  instead of emitting a second event; only standalone/RSC tRPC contexts should emit
  their own batched procedure event.
- 2026-06-05: `cloudflare/wrangler-action` fails before deploy when a listed secret is
  empty; build the secret list dynamically for optional Worker secrets such as
  `DATABASE_READ1_URL` and `DATABASE_READ2_URL`.
- 2026-05-25: Public API route allowlists must run before `init()` so scanner 404s do not
  construct cache, DB, service, or log-drain context.
- 2026-05-08: Test DO eviction/recovery with a new DO instance over the same fake storage.
- 2026-05-11: For usage concurrency, test `EntitlementWindowDO` replay and reporting enqueue
  retry paths, not only the service adapter.
- 2026-05-08: Tiny-tools usage discovery reads `featurePlanVersion.meterConfig` from
  `entitlements.get`; `verify` is only for the decision.
- 2026-05-11: Tier/package entitlements are static quantity limits from subscription grants; do
  not add meters for them unless the product explicitly needs separate snapshot usage.
- 2026-05-15: API load tests should use `tooling/k6/baseline.js` with one `PROJECT_ID`, one
  `CUSTOMER_ID`, and `EVENTS=1000`; it discovers meters through `entitlements.get`, sends async
  usage grouped by event slug, samples verification with `VERIFY_EVERY`, and runs one final
  verification without signup/payment flows.
- 2026-05-17: Async raw ingestion supports one event fanning out to multiple active usage
  entitlements with the same `eventSlug`; keep same-slug meter tests at the service layer so
  payload-compatible meters stay processed together.
- 2026-05-17: Async ingestion should batch entitlement-window RPCs by customer entitlement in
  chunks of 100; DO alarm cleanup should use indexed bounded probes/deletes, not `count(*)` scans
  over outbox, audit, or idempotency tables.
- 2026-05-17: EntitlementWindowDO apply/verify hot paths should read only active
  `grant_windows` bucket keys; full-table grant-window scans multiply storage rows read under
  load.
- 2026-05-30: EntitlementWindowDO no longer uses a local fact outbox; post-apply commits must
  still schedule lifecycle alarms so wallet final flush, idempotency cleanup, and retention wakeups
  continue.
- 2026-05-31: Ingestion hot paths enqueue append-only reporting envelopes after
  `EntitlementWindowDO` apply; do not reintroduce `IngestionAuditDO.exists` or
  `IngestionAuditDO.commit` into sync or async request handling.
- 2026-05-31: `IngestionAuditDO` is retired; keep only the `deleted_classes` migration marker
  in `apps/api/wrangler.jsonc`, and use reporting envelopes for audit/Pipeline/Tinybird delivery.
- 2026-06-05: Customer-visible ingestion analytics should project from reporting envelopes in
  the reporting consumer; avoid parallel service-level status writes that can split evidence.
- 2026-06-05: Lakehouse registry fields with `required: false` and `defaultValue: null` should
  parse explicit `null`, because reporting payloads send nullable optional columns.
- 2026-05-17: Async ingestion in-flight result correlation must use per-message keys; keep
  `idempotencyKey` only for audit/dedupe identity.
- 2026-06-10: EntitlementWindowDO batch wallet retries must discard in-memory staged plans before
  awaiting wallet I/O; reread SQLite and retry optimized so reservation fixes do not turn into
  per-event sequential writes.
- 2026-06-12: EntitlementWindowDO batch wallet growth readiness must compare reservation runway
  against staged batch headroom, not only the current event cost; post-refill wallet-empty denials
  must be staged before mutating the optimized batch draft.
- 2026-06-12: Ingestion event table pagination should use a composite Tinybird cursor
  (`handled_at`, `canonical_audit_id`); `handled_at` alone can skip rows when many events share a
  timestamp.

## Billing, Wallets, And Invoices

- 2026-06-08: Sandbox payment-provider invoice methods should return an empty hosted invoice URL;
  the dashboard must keep sandbox invoice viewing inside Unprice instead of opening placeholder
  external origins.
- 2026-06-08: Project creation must seed an active managed sandbox payment-provider config in the
  same transaction; plan-version publish should log provider validation failures with normalized
  error context before returning `payment_provider_error`.
- 2026-06-08: Invoice finalization collectability should use the provider/display
  currency-minor amount; if a tiny positive ledger-scale total rounds to zero,
  skip provider work and void the invoice.
- 2026-06-08: Usage plan-version features should persist an explicit reset cadence;
  when reset follows billing, derive and store it from feature `billingConfig` while keeping
  `metadata.resetCadenceOverride=false`, so rating/explainability read the same period keys.
- 2026-06-08: Project dashboard revenue should use invoice-visible ledger credits into
  `customer.*.consumed`; do not estimate it from plan prices or raw payment/top-up funding
  accounts.
- 2026-06-07: Customer-facing invoice money should quantize ledger-scale amounts through
  `toCurrencyMinor` before display; keep sub-cent precision internal.
- 2026-06-07: Provider invoice items must allocate currency-minor rounding from the
  ledger-summed invoice header total; do not independently round each line and let
  provider totals drift.
- 2026-06-06: Invoice headers store `grossAmount`, `amountDue`, `amountPaid`, and
  `amountIncluded`; ledger lines remain the invoice source of truth, and
  collectability comes from settlement metadata derived from wallet funding legs.
- 2026-06-06: Plan publish should set `paymentMethodRequired` from any non-zero
  `charge_automatically` feature price path, not flat price alone; `createPhase`
  resolves the provider default before inserting a required payment method.
- 2026-06-07: `createPhase` status decisions must use the resolved/stamped
  `paymentMethodIdToUse`; sandbox defaults can be discovered during phase creation and should
  not park direct signup in `pending_payment`.
- 2026-06-07: Wallet-backed usage invoices should project wallet capture ledger lines; do not
  re-rate capped wallet captures through Tinybird during BILL or they can zero/duplicate invoices.
- 2026-06-07: Wallet capture ledger metadata must include `feature_slug` and `quantity`; invoice
  read models should consume ledger-projected descriptions/quantities instead of looking up usage
  feature labels from billing periods.
- 2026-06-07: Subscription phase edits must persist `paymentMethodId` in `updatePhase`; the
  Next.js phase form should not reset a selected payment method from plan-version defaults.
- 2026-06-07: Transaction-backed phase creation must materialize billing periods after the outer
  transaction commits and before wallet activation; async `waitUntil` period generation can race
  immediate usage ingestion and leave EntitlementWindowDO without invoice context.
- 2026-06-12: Subscription machine activation already runs under the subscription lock during
  renewals; call billing-period materialization with `lock: false` from that actor, or
  `generateBillingPeriods` will reacquire the same lock and park the subscription in
  `pending_activation`. Ingestion catch-up must retry `activateWallet` for subscriptions already
  parked there instead of fanning out to EntitlementWindowDO with stale billing context.
- 2026-06-12: Ingestion catch-up must materialize per-item billing periods for active/trialing
  subscriptions even when the subscription cycle is not due for renewal; usage feature cadences can
  be shorter than the subscription cycle and still need invoice context before DO fanout.
- 2026-06-07: When signup or provider-completion use cases materialize billing periods, wire
  `billing` through API route service bags and `apps/api/src/hono/env.ts`; missing adapter wiring
  can return signup `success=false` with a hidden `generateBillingPeriods` error.
- 2026-06-06: `explainCharge` treats invoice rows as grouped buckets: use ledger totals for the
  line amount, query Tinybird by period key when available, and fall back to the billing window
  when the key cannot be derived.
- 2026-06-06: Draft plan-version billing changes should cascade feature billing/reset cadences
  unless `metadata.billingCadenceOverride` or `metadata.resetCadenceOverride` is true; missing
  override flags mean the feature follows the plan. Usage feature billing may be shorter or longer
  than plan billing; only reset cadence must be less than or equal to feature billing cadence.
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
- 2026-05-17: Public signup `creditLineAmount` is currency minor units; convert to
  ledger-scale before saving subscription phases or customer sessions.
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
- 2026-05-08: On finite limit reached, close active wallet reservations through the reservation
  close helper.
- 2026-05-08: Treat `WALLET_EMPTY` as possibly DO-local underfunding; flush+refill once before
  denying.
- 2026-05-17: Lazy reservation bootstrap should return `WALLET_EMPTY` only from zero allocation;
  wallet service errors stay retryable infrastructure failures.
- 2026-05-17: Reserve ledger source ids must be reservation-scoped; keep period-scoped DO keys as
  trace metadata only so same-period re-bootstrap cannot replay old reserve transfers.
- 2026-05-17: EntitlementWindowDO inactivity final-flush uses 1h in production/test and 60s in
  `NODE_ENV=development`; ledger freshness flushes use 10m in deployed envs.
- 2026-05-18: EntitlementWindowDO alarm scheduling should use flush cadence only when
  `consumedAmount > flushedAmount`; fully flushed live reservations should wake on lifecycle
  deadlines, not stale `lastFlushedAt`.
- 2026-06-08: EntitlementWindowDO time-based wallet flushes with `pendingRefillAmount=0` are
  capture-only; do not call reservation extension for a zero-amount refill or alarms can keep
  retrying flush/refill work.
- 2026-06-08: Wallet capture usage transfers are statement-keyed; capped-wallet statement tests
  should assert transfer source types, not raw pgledger debit/credit entry counts.
- 2026-06-08: API error mapping must treat `UnPriceWalletError("WALLET_LEDGER_FAILED")` as an
  infrastructure 500; only `WALLET_EMPTY` is a business ingestion denial.
- 2026-06-09: EntitlementWindowDO apply logs must keep wallet-empty denial fields and wallet
  service error fields mutually exclusive; stale `error_message` values in Axiom can misclassify
  operational underfunding as ledger failure.
- 2026-05-17: Reservation release and grant expiration are separate financial events: release
  restores unused reserved funds to customer buckets; only grant expiration returns available
  grant balance to platform funding.
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

### 2026-06-12: Queued usage ingestion may catch up subscription renewals, but entitlement context stays read-only.

- Billing-period generation and wallet grant issuance belong to the subscription lifecycle. If queued ingestion sees subscription-backed usage past the funded billing window, call the subscription machine under its existing lock, then reload entitlement context before fanout.
- Do not add billing-period writes to `internal/services/src/ingestion/entitlement-context.ts`; that loader reads/caches entitlements and billing contexts only.

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

- 2026-05-23: `pnpm --filter <package> test <path>` resolves test filters from the package
  directory; use package-relative paths such as `src/ingestion/...`, not repo-root paths.
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
- 2026-05-29: EntitlementWindowDO async compaction must commit idempotency results and
  fact outbox intent in the same durable SQLite transaction; never advance replay seals
  without recoverable priced facts.
- 2026-05-29: Compact-only ingestion DOs use batch tables as the replay source:
  `idempotency_key_batches`, `meter_facts_outbox_batches`, and `ingestion_audit_batches`.
  Do not reintroduce per-event DO tables or a DB-backed meter storage adapter.
- 2026-05-29: Async ingestion must not ack when audit DO commit fails after entitlement apply;
  throw so the queue retries against entitlement idempotency instead of losing audit intent.
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
- 2026-06-08: Durable Object diagnostics that must be queried in Axiom should go through
  `createDoLogger` as first-class drain events; request-scoped wrapper rows alone can hide inner
  fields such as `mode`, fallback `reason`, and `error`.
