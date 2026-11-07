# Lessons

Durable repo memory for repeatable rules, failure modes, commands, and test
patterns. Keep it cheap to load and useful.

## How To Use

- Read before non-trivial code, test, docs, migration, billing, or architecture work.
- If you need to run the project, always use bin/startup dev
- use ripgrep when available instead of grep. rg
- Do not start process without specific permissions, if you need the app running ask me again.
- New lessons must be dated, repo-specific, and short: 1-3 bullets per entry.
- Use "When X, do Y; watch Z". Include files or commands only when they prevent repeats.
- Update an existing section instead of adding duplicate narrative.
- Do not record secrets, customer data, or one-off local noise.
- Architecture rule changes need an ADR link.
- You need to use nvm use to install the proper node version of the project
- 2026-06-30: The repo pins `pnpm@10.28.0`; if the Codex runtime resolves `pnpm` to 11.x,
  use the pinned/Corepack pnpm instead. pnpm 11 ignores the root `pnpm` config, can report
  lockfile config mismatch, and may purge `node_modules` before tests run.
- 2026-07-03: In Codex, prefer targeted `corepack pnpm --filter <pkg> typecheck` over the
  root `pnpm typecheck` turbo path; the root path can invoke the runtime pnpm during package
  tasks and try to reinstall dependencies.
- 2026-07-05: Destructive project deletion depends on project-owned FKs cascading. When adding an
  explicit FK from a project-owned table to `unprice_projects`, include `ON DELETE CASCADE` or
  `ProjectService.deleteProjectRecord` can fail after child rows exist.
- Before adding a helper, utility, or repeated row shape, search the repo for an established
  pattern first; reuse or extract the canonical path instead of duplicating logic.
- 2026-09-19: Tooling packages that support local configuration should load an optional package-local
  `.env` with Node's `--env-file-if-exists`; keep `.env.example` tracked and let shell variables override it.
- Before running the app, always check if it's already running on locahost:3000 for landing or app.locaholst:300 for dashboard.
- Whenever you are gonna work with the front end, please load the shadcn skill. And keep and follow the patterns for empty states, components, etc.
- 2026-07-06: Mintlify dev can throw `No docs config` after hot-adding or editing docs pages even
  when `mint validate` passes; restart `apps/docs` dev preview from the docs root before treating it
  as a config bug.

## Rate Cards And Plan Pricing

- 2026-11-06: Rate-card version writes lock the plan, then the version, then its cards. Publication also updates the previous latest version; a version-first lock can deadlock with a shared-card copy.
- 2026-11-06: `RateCardService.withTransaction(tx)` omits cache writes. The use case invalidates version prices only after the outer transaction commits.
- 2026-11-06: Inline table cells read saved props while idle. Capture the saved value at focus and skip blur commits if it changed during the edit.
- 2026-11-06: `createRateCardsFake` skips `planPublish` and `planClose` validation. For feature-edit and card-copy boundary tests, run the production planners too; the fake accepts rows that the real service rejects.
- 2026-11-05: A feature's meter exists twice: `features.meter_config` is the project template and
  `plan_versions_features.meter_config` is the snapshot the plan editor writes and the budget reads.
  Validate a card's rows against the plan features of the versions assigned to it
  (`planFeaturePricing`), never against the project template once the card is assigned, or a
  `model` row is refused with `UNKNOWN_DIMENSION` while the editor says the meter has it.
- 2026-11-05: The 10-minute rate notice is a liveness rule: it applies once a version with
  `published_at` prices with the card, not once the card has rows. Decide it under the card lock,
  and never let a dialog pre-fill "now" as a start time: send no time and let the server pick the
  earliest allowed, or the minute truncation rejects a card's first row.
- 2026-11-05: A plan version's status moves only through publish; `planVersions.update` must not
  accept `status`, or a published version set back to draft makes its live card look unused.
- 2026-11-05: A number typed into a text input reaches the form schema as a string; a form
  schema that extends a boundary schema with a number field must use `z.coerce.number()`
  (`plan-form.tsx` trial), or the dialog shows "expected number, received string" and never submits.
- 2026-11-05: Features are project-wide: a second plan reuses them from the library, and a
  feature dialog with an existing slug refuses (by design). A browser walk that creates features
  must start from a project that lacks them.
- 2026-11-05: A jotai list setter must return a new array; `features[index] = x; return
  features` keeps the same reference and subscribers (the feature table) do not re-render.
- 2026-11-05: In a cmdk palette whose items load async, mount the "Create" item only once the
  matches are in; while it is the only item cmdk keeps it selected after the matches arrive, and
  Enter creates instead of picking the first match.
- 2026-11-05: `pnpm --filter @unprice/services test:integration -- <file>` ignores the file and
  runs the whole suite; run one file with
  `NODE_ENV=test SKIP_ENV_VALIDATION=true APP_ENV=test pnpm exec vitest run --config vitest.integration.config.ts <file>`
  from `internal/services`. A live-card test must attach the feature to the published version,
  because the card is validated against its assigned versions' plan features.

- 2026-11-05: The pre-commit hook runs `pnpm validate` plus every test suite in parallel, so a
  fast-check property test that takes 5 s alone takes 20 s there. Give such a test its own
  timeout (`budget.statements.properties.test.ts` has `PROPERTY_TIMEOUT_MS`) instead of raising
  the global one, and rerun a suite alone before suspecting a regression.

## CI And GitHub Actions

- 2026-11-03: When a billing PR predates the dependency migration on main, merge main before updating audit pins; preserve its Zod 4 compatibility patches and lockfile.
- 2026-10-27: Mintlify validation 0.1.813 needs the checked-in Zod v4 patch (partial enum records, issue formatting, native JSON schema conversion). Keep `apps/docs/test/zod-compatibility.test.mjs` passing when updating it; the removed converter dependency is replaced by that implementation, not an audit exclusion.
- 2026-10-27: With drizzle-zod 0.8, use refinement callbacks to retain column nullability and explicitly mark optional insert overrides. Zod v4 runs defaults inside optional fields; omit those defaults when the old boundary left fields absent.
- 2026-10-27: Zod GHSA-mrhx-c7xc-m3w5 is fixed in v4.6.6, but its upstream patch only changes v4. Keep v3 integrations explicit; upgrading the package and importing `zod/v3` does not apply that fix.


- 2026-10-22: Next.js security patches must update both `apps/nextjs` and `internal/auth`. Keep the sharp 0.35.5 override; it mitigates the image RCE but does not fix Server Actions advisories.
- 2026-10-22: For a dependency PR that must not deploy, include `renovate/` in the head branch name. `Test Renovate` runs the Build checks, and every `Deploy Preview` job skips that branch.
- 2026-10-21: Vite security updates must change both the root dependency and workspace override. After pnpm resolves override changes, retain unrelated lockfile resolutions and verify with a frozen install.
- 2026-08-27: Database-backed property tests that reseed for each generated case can exceed the
  shared 10s integration timeout under full-suite CI load; set a scoped per-test timeout instead
  of raising the limit for every integration test or reducing property coverage.
- 2026-08-24: npm trusted publishing requires `packages/api/package.json#repository.url` to
  match the GitHub Actions repository exactly; keep the release guard aligned after repo transfers.
- 2026-08-24: Changesets release PRs can expand short arrays in `packages/api/package.json`; keep
  `bump-versions` running Biome on that manifest before the release action creates its commit.
- 2026-08-24: When an audit batch mixes patched and unpatched advisories, update package overrides
  and aligned tool packages first; baseline only advisories whose registry metadata has no patch.
- 2026-08-10: When one advisory affects multiple `nanoid` major lines, use version-qualified
  `pnpm-workspace.yaml` overrides and regenerate the lockfile offline; do not baseline a patch
  release that can be safely forced within each major line.
- 2026-07-31: `tooling/scripts/audit-high.mjs` must give `spawnSync` enough output buffer for
  the full npm audit report; `GHSA-mh99-v99m-4gvg` falsely flags patched
  `brace-expansion` v1/v2 lines because its vulnerable range has no lower bound.
- 2026-07-31: Vitest 4 supports `maxWorkers` but removed `minWorkers`; remove that option from
  integration scripts and configs or the CI command exits before loading tests.
- 2026-07-28: Changesets uses the root `package.json` workspace list before
  `pnpm-workspace.yaml`; mark every non-published app/package in that list as `private: true` and
  fail release unless `@unprice/api` is the only publishable workspace.
- 2026-07-11: Node 24 GitHub Actions workflows should use `actions/checkout@v5`,
  `actions/setup-node@v5`, `actions/cache@v5`, and `pnpm/action-setup@v4.4.0`; older action
  majors trigger GitHub's forced Node 24 compatibility warning.
- 2026-07-04: `job_build.yaml` requests `pull-requests: write` and `statuses: write`; callers
  that set workflow-level `permissions` must grant those scopes on the reusable-workflow job.
- 2026-07-11: `neondatabase/schema-diff-action@v1` does not accept `username`; pass only its
  supported `database` input because the action resolves the branch role itself.
- 2026-07-11: Jobs schedule tests must reset the chained query's `limit` mock between cases;
  `clearAllMocks()` preserves queued `mockResolvedValueOnce` results and can leak period rows.

## Cloudflare, API, And Ingestion


- 2026-10-19: The API's `c.get("services")` is its own `DomainServiceContext` (`hono/env.ts`), filled
  in `middleware/init.ts`; a service added to `createServiceContext` must be added there too, and to
  the route test harnesses (`budgets.test.ts`, `local-mode.fuzz.test.ts`) that set `services` by hand.
  Exception: `budgetOperator` calls the API itself, so the API's bag leaves it out.
- 2026-10-19: A gateway to an internal route reads "not found" only from the API's JSON error body
  (`error.code === "NOT_FOUND"`); Hono's default 404 for a missing route is plain text, and
  read-repair that trusted a bare 404 would forget catalog rows during a split deploy.
- 2026-10-19: The internal release route gets the budget's rejection from `UnpriceApiError.cause`
  (`budgetApiError` sets it) and adds it as `details: { kind: "release_rejected" }`; the public
  route's answer is unchanged. The gateway reads a rejection only from those details.
- 2026-10-19: A budget recreated at the same key keeps its catalog id but restarts hold ids at `h_1`,
  so anything outside the budget that is keyed per hold uses the hold's id plus its `createdAt`
  (`budget_audit.subject_created_at`); the id alone matches the closed budget's row.
- 2026-10-19: A route test can run the real budget core behind the mocked `CloudflareBudgetClient`:
  `MemoryBudgetStore` from `@unprice/services/budgets/memory-store` (see `releaseBudgetInternalV1.test.ts`).
- 2026-10-19: DO SQLite binds a JS number as REAL, so `'h_' || ?` gives `h_1.0` and `? % 1000` is
  float math. Seed SQL with `CAST(? AS INTEGER)` (see the 1,000,000-row inspect bench).
- 2026-10-19: `BudgetDO.inspect` reads through `BudgetSqliteStore.inspecting`, not `atomically`, so
  no verb's transaction binds the inspect reads. Its walk and closed-row scans stay on the `due_at`
  index: 2,108 rows read at 1,000,000 rows; check `rowsRead` in the storage bench after changing them.
- 2026-10-19: Preview native logs/traces and BudgetDO placement diagnostics were temporary and are
  disabled. Keep sampled request events with the budget operation, outcome, and RPC duration;
  failed alarms remain error logs.
- 2026-09-20: Default authenticated SDK requests to `cache: "no-store"`; Cloudflare Workers reject
  an explicitly supplied `cache: "default"` before the request reaches the API.
- 2026-09-20: Treat a missing or disabled payment provider during paid plan publication as an
  expected precondition failure; `INTERNAL_SERVER_ERROR` is masked by the tRPC formatter and hides
  the payment-settings action from the user.
- 2026-09-02: Pricing automation needs separate credentials: configuration keys own
  `monetization.get`/`monetization.apply`, while runtime keys own signup, usage, and ingestion
  status operations.
- 2026-08-25: Entitlement reset buckets must pass the raw cadence start and configured reset
  anchor to `calculateCycleWindow`; cover monthly `dayOfCreation` behavior with a non-midnight
  timestamp or usage can reset at UTC midnight before subscription renewal. In reset tests, match
  expected period keys to the explicit numeric anchor; daily anchor `0` means UTC midnight.
- 2026-08-24: SDK reservation facades may release only on a known non-billable path; when provider
  usage can already exist, keep settlement retryable and never turn a settlement error into a
  release.
- 2026-08-01: When replacing a synchronous runtime usage or run route, preserve the cached bouncer at the work-authorizing boundary; `access.check` and async `usage.record` are not enforcement gates.
- 2026-07-11: Keep entitlement pricing helpers store-free: pass readonly meter/grant snapshots,
  return next/touched grant states, and let processor transactions own all state reads and writes.
- 2026-07-11: Meter transition semantics belong in `@unprice/services/entitlements`; engine writes
  and entitlement cost projections must share the canonical pure transition. Timestamp validation
  stays caller-selected: single-event wallet bootstrap defers it to apply, batch/sync uses ambient
  `Date.now()`, and async uses its injected clock.

- 2026-06-06: Local dev startup must override `DATABASE_READ1_URL` and `DATABASE_READ2_URL`
  alongside `DATABASE_URL`; `apps/api/dev.sh` regenerates `.dev.vars` from non-empty parent env
  values and otherwise preserves stale preview read-replica secrets.
- 2026-05-09: Removing a Durable Object class needs `deleted_classes` in the affected
  `apps/api/wrangler.jsonc env.*` migration.
- 2026-11-04: After a wrangler binding change, edit `apps/api/worker-configuration.d.ts` by hand
  unless a filled `.dev.vars` exists; `wrangler types` without one drops every secret's type.
- 2026-11-04: The onboarding paid-action proof charges a standalone budget per attempt
  (`onboarding:<customer>:<feature>:<attempt ms>`, closes after 1 hour), never the payer budget.
- 2026-05-08: `entitlement/verify` stays compact: decision fields only, no internal
  entitlement metadata.
- 2026-05-17: `entitlement/verify` is read-only for wallet reservations; use apply/alarm paths
  for reservation close and release.
- 2026-05-08: `entitlement_meter_facts` needs no synthetic `id`; use `amount` for event spend
  and `amount_after` for cumulative spend.
- 2026-05-08: Sync ingest idempotency must re-enter entitlement apply replay, not synthesize a
  duplicate from audit `exists`.
- 2026-05-08: API wallet-empty messages should use configured meter/event slugs, not derived
  storage keys.
- 2026-05-09: Audit payload drift is asynchronous evidence, not a sync-ingest `409`; group
  `canonicalAuditId` and count distinct `payloadHash` values in the audit lake.
- 2026-05-09: Keep sync ingest on the low-latency auth path with `Server-Timing`; do not add the
  API-key rate-limit binding.
- 2026-05-09: Persist final wallet flush intent before external wallet I/O so recovery replays
  final flushes as final.
- 2026-05-09: Serialize native `Error` objects before `evlog.log.error`; Cloudflare/Axiom can
  otherwise store `{}`.
- 2026-06-13: When logging caught failures with `Logger.error`, pass the caught `Error` as the
  first argument and put the operation name in fields; string-first error logs make evlog create a
  wrapper error whose stack hides the real cause.
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
- 2026-09-19: Deployed Cloudflare Worker timers only advance after I/O; `Date.now()` and
  `performance.now()` can both report `0` for synchronous Durable Object CPU/SQLite work. Use
  caller-side RPC timing, native CPU/wall traces, and separate timers around awaited wallet calls.
- 2026-05-18: HTTP tRPC inside Next.js should enrich the enclosing Next wide event
  instead of emitting a second event; only standalone/RSC tRPC contexts should emit
  their own batched procedure event.
- 2026-06-05: `cloudflare/wrangler-action` fails before deploy when a listed secret is
  empty; build the secret list dynamically for optional Worker secrets such as
  `DATABASE_READ1_URL` and `DATABASE_READ2_URL`.
- 2026-05-25: Public API route allowlists must run before `init()` so scanner 404s do not
  construct cache, DB, service, or log-drain context.
- 2026-05-08: Test DO eviction/recovery with a new DO instance over the same fake storage.
- 2026-07-04: API Durable Object tests are integration-style under root Turbo concurrency; keep
  `apps/api/vitest.config.ts` on a 15s `testTimeout` instead of relying on Vitest's 5s default.
- 2026-07-11: Durable SQLite atomic store callbacks must execute synchronous Drizzle `.run()`
  statements inside `db.transaction`; async callbacks can leave earlier writes committed when a
  later statement fails.
- 2026-10-16: The budget primitive (ADR-0006) keeps its state machine pure in
  `@unprice/services/budgets` (`transition`); a DO persists the returned ledger, rows, and periods
  in one transaction. When adding a verb, extend the reference model in `budget.properties.test.ts`
  (its own calendar math, no core imports beyond the API) instead of asserting the core's totals.
- 2026-10-17: A budget estimate is the maximum authorized usage. Reject settlement above the
  reservation; do not treat it as permission for debt. `record` reports work that already ran, so
  it always counts, even past a hard limit: refusing it loses the count, not the spend.
- 2026-10-17: Keep unresolved BudgetDO holds reserved across timeouts and window resets. Only
  final settlement or explicit zero-usage release can return capacity; see ADR-0006 B2-B3.
- 2026-11-04 (replaces 2026-10-17): BudgetDO data has shipped since 10-18: preview benchmark
  budgets and prod test budgets. A stored-format change ships a custom migration
  (`bin/migrate.dev budget --custom`) that clears the rows the new code cannot read, never an
  in-place reinterpretation; still no read-compat or legacy states. See
  `0007_reset_rows_before_usage_vectors.sql`.
- 2026-10-17: The installed Drizzle SQLite generator splits commas in index expressions. For
  budget key lookup, use `data_json ->> '$.idempotencyKey'`, generate through
  `bin/migrate.dev budget`, and verify index selection with `EXPLAIN QUERY PLAN` in workerd.
- 2026-10-18: Measure BudgetDO row writes with `pnpm --filter api test:workers:bench` before and
  after; do not predict them. The ledger row costs 2 rows written as an upsert or a plain UPDATE;
  each secondary index entry a row touches costs 1.
- 2026-10-18: A partial SQLite index (`budget_operations_hold_key_idx ... WHERE kind = 'hold'`) is
  used only when the query repeats the predicate as a literal; drizzle's `eq(kind, "hold")` binds a
  parameter and falls back to a scan.
- 2026-10-18: Budgets use automatic placement (`getBudgetStub`: no jurisdiction, no hint); every
  other DO stays EU-pinned. evlog `keep` rules only add; to except a request, drop the global rule
  and decide in the middleware's `keep` callback (`keepFailedRequest` in `apps/api/src/observability.ts`).
- 2026-10-19: CI passes secrets between jobs with `.github/actions/secret-outputs` (gpg symmetric, base64),
  which replaced the cloudposse Docker action after public.ecr.aws rate limits failed preview deploys
  repeatedly. Run `.github/actions/secret-outputs/secret-outputs.test.sh` (Docker) after touching it.
  No ciphertext outlives a run: preview encodes `DATABASE_URL_ENCRYPTED` and decodes it in later jobs.
- 2026-10-19: Never time Durable Object work from the object's `Date.now()`: it is stale until the
  object's next I/O. A Worker-to-object `queueMs` read 0 on about 27,000 preview requests and was
  removed; use caller-side RPC timing instead.
- 2026-10-18: In DO SQLite, `DELETE ... RETURNING` costs one extra row read per deleted row (measured on
  the alarm purge: +2,048 rows read at its cap). Count deletions with `SELECT changes()` in the same
  transaction instead: one statement, no rows read.
- 2026-10-18: In a non-TTY shell vitest-pool-workers swallows the benchmarks' `console.info`; run
  `pnpm --filter api test:workers:bench --disableConsoleIntercept` to see `BUDGET_BENCHMARK` lines.
  Measured there: an UPDATE that moves `due_at` adds no row written (lease report 3 with or
  without renewal), so measure rather than count index entries.
- 2026-10-18: A stored `record` receipt costs 330 B (36-character key) to 559 B (256-character key) of
  BudgetDO SQLite (`bytesPerReceipt` in `BudgetDO.storage.benchmark`). Each 10 GB object holds
  `RECORD_DEDUPE_MS` × rate of them. At 8 days that was 26-44 records/s; at 25 hours it is ~200-340/s.
  A 150 s k6 run on a fresh budget shows neither the ceiling nor an alarm purge.
- 2026-10-18: After extending `budget.properties.test.ts` with a verb, flip one of its core rules
  and confirm the property fails. Lease reports first reached their accepted path 1% of the time
  and survived every mutation; planning them against live leases and adding a steady-clock
  scenario made each mutation fail.
- 2026-10-18: A nullable discriminated union in a response schema renders in OpenAPI 3.0 as a
  `oneOf` with a bare `{ nullable: true }` member, and openapi-typescript then types the field as
  `unknown`. Make such a field optional (absent instead of null) and check `openapi.d.ts`.
- 2026-10-18: tsx cannot import `packages/api/src` (its CommonJS `export *`); budget tooling scripts
  import the built `@unprice/budgets`, so run `pnpm --filter @unprice/budgets build` first. Run tooling probes
  with explicit env vars rather than `--env-file`, which loads the operator's credentials.
- 2026-10-20: A tsx script that reaches `@unprice/db/validators` must be a `.cts` entry (see
  `internal/services/scripts/sync-model-catalog.cts`): `@unprice/error` is untyped CommonJS whose
  `export *` barrel hides `BaseError` from Node's ESM loader, so an ESM `.ts` entry fails to import it.
- 2026-10-18: `apps/api/src/routes/budgets/local-mode.fuzz.test.ts` runs the built SDK's local mode
  through the real budget routes and processor on fake timers; rebuild `@unprice/budgets` before it.
  Keep `setImmediate` real and step with `vi.advanceTimersToNextTimer()`: the async advance waits a
  real 1 ms per timer. Never put `vi.fn()` on a per-request path there: it keeps every Hono context.
- 2026-10-18: A refusal that writes nothing is not idempotent: a late copy of the request (an HTTP
  retry still in flight) is decided again and can succeed once room returns. Budget leases write
  their refusal (`status: "refused"`, 10-minute retention), and the SDK waits a flush interval
  before asking again, so a blocked key writes one row per interval rather than per call.
- 2026-10-19: `BudgetTransition` is the rows to write plus a `BudgetReply`. A refused lease is the
  one rejection that writes: `ok: false` with LIMIT_EXCEEDED, committed and armed like any write.
  Every other rejection is the `Err` of `transition` and writes nothing; core tests narrow with `ok()`.
- 2026-10-19: For billing, keep durable usage facts separate from BudgetDO replay receipts and
  cumulative lease reports. Local `record` still calls the remote API; `occurredAt` only bounds
  acceptance, and an expired unreported lease counts its whole grant, not proven actual usage.
- 2026-10-18: The local-mode fuzz test asserts that every lease on the server reached its client.
  Reverting the refusal row failed it after about 390 runs at the old fault weights; stray copies
  weighted 3, faults on half the steps, and close weighted 2 cut that to about 40 (at most 110).
- 2026-10-18: `pnpm add` can re-resolve unrelated peer variants in `pnpm-lock.yaml`; add only the
  importer entries and confirm with `corepack pnpm install --frozen-lockfile`.
- 2026-11-03: `@unprice/services/pricing` prices usage as `round(f(after)) - round(f(before))` on
  the cumulative position. Rounding the exact per-event delta instead fails every split-invariance
  property in `pricing.properties.test.ts`; never "simplify" `delta` in `rate.ts`.
- 2026-11-03: Rate card decimals parse into `Amount` in `internal/db/src/validators/rate-cards.ts`; write
  pricing fixtures in wire form and parse them through the schemas (`pricing/fixtures.ts`).
- 2026-10-16: Budget amounts are `@unprice/money` `Amount` (bigint at `LEDGER_SCALE`) and the wire
  patterns live in `@unprice/db/validators`; never redeclare them in the budget core.
- 2026-10-16: `Omit` over a generic `BudgetOutcome & { type: T }` does not narrow; strip `type` at
  the route where `T` is concrete (`const { type: _, ...outcome } = await runBudgetVerb(...)`).
- 2026-10-16: `internal/services` targets ES2018, so bigint literals (`1n`) fail tsc; use
  `BigInt(1)` in budget code and tests.
- 2026-10-16: Workers RPC carries `bigint` both ways, but DO SQLite rejects a bigint binding
  ("Cannot convert a BigInt value to a number"); store amounts as TEXT. A generic DO RPC method
  loses its type parameter through the stub, so narrow the result at the caller instead.
- 2026-10-16: A budget verb returns a `Change` (rows written, held and consumed deltas) and
  `transition` applies it; there are no facts or journal. Window rolls come back as `periods` that
  `BudgetSqliteStore.commit` inserts, so add new budget outputs to `BudgetTransition`, not the processor.
- 2026-10-16: Never purge budget state keyed on time past `ledger.lastAt`: commands clamp to
  `lastAt`, so a purge at a later raw clock lets a skewed-back command re-accept a replay. A
  `sweep` always writes `lastAt = now` first, and the alarm purges at that clock.
- 2026-10-16: An error escaping a DO method (RPC or `runInDurableObject` instance call) shows up as
  an unhandled rejection in vitest-pool-workers; test rollback paths through the processor.
- 2026-11-03: Budget usage is a vector (`Usage` in `budgets/usage.ts`: the amount plus quantities per
  feature); a limit reads one measure. The public wire still carries amounts: route adapters convert
  with `amountUsage` and project back with the `*ToWire` helpers in `routes/budgets/budget-verb.ts`.
- 2026-11-04: Workers RPC types a tuple (`readonly [string, string]`) in a BudgetDO reply as
  `string[]`, so the stub's reply stops matching `BudgetRejection` while `pnpm typecheck` stays
  green. Use arrays, never tuples, in replies.
- 2026-11-04: A hold's estimate is the most its event can cost from any position. A property that
  an actual within the estimate never prices above it passed with the bound's jump points removed
  until a scenario had a flat into a cheaper tier; give bound properties a curve where the worst
  stretch straddles a boundary.
- 2026-11-04: A field typed `unknown` anywhere in a BudgetDO reply (an operation row inside
  `BudgetInspection`) is not RPC-serializable, so the stub's reply type stops narrowing on `ok`
  (`client.ts` loses `reply.inspection`). Type stored event properties as flat JSON scalars.
- 2026-11-04: A routing mutation in `budget.statements.properties.test.ts` survived 200 runs while
  most scenarios never reached January. `clocksOf` now scales each scenario's advances to end on
  `LAST_CLOCK`, so every run seals November and December; keep that when changing the generator.
- 2026-11-04: Budget funding (ADR-0008 D10) follows the CARDS_STALE shape: the core refuses with
  FUNDING_REQUIRED and writes nothing; only `fund` and a seal persist wallet intents. Never call the
  wallet before an intent row exists, and never recompute a pending intent: `fund` answers it as stored.
- 2026-11-04: `BudgetDO.cacheCards` stores nothing for a key without a budget, so a priced upsert over
  RPC to a fresh key stays CARDS_STALE; workers tests seed the card cache inside `runInDurableObject` first.
- 2026-11-04: Only `syncPayerBudget` writes `unprice:customer:<id>` (pure `compilePayerBudget`, then
  `executeBudgetCommand`); the API runs it in process (`InProcessPayerBudgetGateway`), tRPC and jobs via
  `/v1/internal/payer-budgets/sync`. Call `billing.syncPayerBudget` after the change commits, outside any lock,
  with `caller: "request"` (one attempt) on request paths; only Trigger jobs pass `"job"` (waits out holds).
- 2026-11-04: A trial period registers its statement with `free: true` (compile reads the billing
  period's `type`); a prepaid close never captures a free statement, and `resolvePeriodCharge` throws
  when a capped phase's non-trial usage is not captured in full. Recurring proration ends a phase's last
  period at `phase.endAt + 1`, since `calculateProration` reads a half-open window.
- 2026-11-04: Request paths never invoice: an immediate cancel only caps periods and syncs; the
  invoicing job bills canceled and expired subscriptions through `billing.invoiceEndedSubscription`.
  Payer statement completion in `billPeriod` is best effort and runs only when a group is metered.
- 2026-11-04: Phases and their last billing period end inclusively (the next starts 1 ms later);
  statements are half-open, so compile ends a phase's last statement at `phase.endAt + 1`. Shortening an
  open statement stops at `lastEventAt + 1`, and the next registration of the feature starts there.
  A `dayOfCreation` reset on the billing interval compiles from the phase's numeric `billingAnchor`.
- 2026-11-03: `apps/api` tsconfig excludes tests, so a core type change breaks DO and route tests only
  at runtime. Typecheck them with a scratch tsconfig that extends `./tsconfig.json`, includes
  `src/ingestion/budget` and `src/routes/budgets`, and adds `@cloudflare/vitest-pool-workers` types;
  the baseline has errors, so diff per-file error counts against the same run on HEAD.
- 2026-10-15: When reviewing run expiry, distinguish retryable captures from abandoned captures;
  `closeRunInStorage` can release funds after abandonment and mark reconciliation needed.
- 2026-05-08: Tiny-tools usage discovery reads `featurePlanVersion.meterConfig` from
  `entitlements.get`; `verify` is only for the decision.
- 2026-05-11: Tier/package entitlements are static quantity limits from subscription grants; do
  not add meters for them unless the product explicitly needs separate snapshot usage.
- 2026-05-15: API load tests should use `tooling/k6/baseline.js` with one `PROJECT_ID`, one
  `CUSTOMER_ID`, and `EVENTS=1000`; it discovers meters through `entitlements.get`, sends async
  usage grouped by event slug, samples verification with `VERIFY_EVERY`, and runs one final
  verification without signup/payment flows.
- 2026-09-19: Production k6 latency and baseline phases must use separate customers; customer-scoped
  ingestion totals can otherwise let latency traffic hide missing baseline events.
- 2026-05-17: Async raw ingestion supports one event fanning out to multiple active usage
  entitlements with the same `eventSlug`; keep same-slug meter tests at the service layer so
  payload-compatible meters stay processed together.
- 2026-06-05: Lakehouse registry fields with `required: false` and `defaultValue: null` should
  parse explicit `null`, because reporting payloads send nullable optional columns.
- 2026-07-01: R2 Pipeline audit records are parsed through the lakehouse registry before send; when
  reporting payloads gain customer-visible fields, update `internal/lakehouse/src/registry.ts` and
  `apps/api/scripts/schemas/events.json` together or the fields are stripped before R2.
- 2026-05-17: Async ingestion in-flight result correlation must use per-message keys; keep
  `idempotencyKey` only for audit/dedupe identity.
- 2026-06-13: Dashboard-to-API workflows should use the `@unprice/api` SDK path; avoid bespoke
  internal fetches for public API operations such as ingestion replay.
- 2026-06-13: Dashboard-to-API project overrides should pass `project_id` through the public SDK
  body and use `validateIsAllowedToAccessProject`; do not add parallel internal auth headers when
  API-key admin/root access already models the permission.
- 2026-07-11: Subscription phase scheduling must normalize stale `currentCycleEndAt` values to a future boundary; otherwise `updatePhase` clamps the old end to `now` and `createPhase` reports a false overlap.
- 2026-07-11: Subscription creation must return a conflict when a customer already has an active subscription; explain the one-subscription invariant and direct callers to update the existing subscription.
- 2026-07-11: Subscription creation checks customer activity before duplicate-subscription handling; map inactive customers to a visible precondition instead of `SUBSCRIPTION_OPERATION_FAILED`, which becomes a generic internal error.

- 2026-09-19: Address every Durable Object through `apps/api/src/ingestion/do-placement.ts`.
  Jurisdiction is part of a DO's identity, so a single unscoped call site silently creates a
  second object holding half the money state; `do-placement.test.ts` fails the build on a raw
  binding access or an addressing call outside that module.
- 2026-09-19: `namespace.jurisdiction()` throws "Jurisdiction restrictions are not implemented in
  workerd", which breaks `wrangler dev` and the workers test pool, so `do-placement.ts` skips it
  when `APP_ENV === "development"` and applies it everywhere else. Test mocks of a DO namespace
  need `jurisdiction()` too — use `ingestion/testing/durable-object-namespace-mock.ts`.

## Next.js And Dashboard

- 2026-10-19: tRPC `infiniteQueryOptions` exists only for inputs with a `cursor` field, and
  `budgets.inspect` pages with `after`; `budget-live.tsx` uses `useInfiniteQuery` with
  `useTRPCClient` under the key `[path, { input, type: "infinite" }]` so `pathFilter` still reaches it.
- 2026-10-19: The pre-commit react-doctor fails on `const query = useQuery(...)`; destructure the
  fields you read. Component tests in `apps/nextjs` render with `renderToString` (automatic JSX in
  `vitest.config.ts`), seeding the query cache instead of mocking tRPC.
- 2026-10-19: `renderToString` never renders a Radix `DialogContent` (it portals); test a controlled
  form inside a bare `<Dialog>`, and detect a disabled button by `disabled=""`, since class names
  contain `disabled:` (see `release-hold-dialog.test.tsx`).
- 2026-10-19: A signup intent routes past auth only through `next`: `INTENT_LANDING` in
  `lib/signup-funnel.ts` is the one table of intents, and `/new` must forward `intent` into the
  workspace signUp `successUrl` (the provider appends `workspace_id`) or it dies at workspace creation.
- 2026-10-19: The `@sidebar/[...all]` slot decides per route whether to hide the sidebar; a nested
  route under a hidden section (`/{ws}/onboarding/budgets`) needs that check widened.

- 2026-08-01: Auth middleware that enriches sessions from Postgres must declare
  `config.runtime = "nodejs"`; leaving it on Edge can surface the database failure as a misleading
  Auth.js `JWTSessionError`.
- 2026-08-01: Keep Turbopack opt-in on Next 15 for this dashboard until its large workspace graph
  no longer exhausts the dev-server heap; use Webpack memory optimizations for the default dev path.
- 2026-08-01: Never enable Auth.js `debug` logging against real OAuth credentials, even locally;
  provider config, access tokens, refresh tokens, and encrypted cookies are included in metadata.

- 2026-08-01: Before enabling Turbopack in `apps/nextjs`, remove unused Next compiler plugins and
  version-mismatched wrappers; `@next/mdx` 14 can inject a legacy webpack config beside Next 15.
- 2026-08-01: Auth.js sessions are host-only; redirect base-host `/auth/*` entries to `APP_DOMAIN`
  before sign-in and allow final auth redirects only on that canonical origin instead of sharing the
  session cookie with the marketing host.
- 2026-08-01: When middleware derives dashboard scope from the URL, set the corresponding
  `NextRequest` cookies before `NextResponse.rewrite` and forward its request headers; the
  private response-header copying workaround can leave the first Next 15 RSC render on stale scope.
- 2026-07-11: Keep an explicit `/dashboard/page.tsx` terminal route because the root dashboard layout
  has parallel slots but no content page; its parent layout already supplies `force-dynamic`, so do
  not duplicate the segment flag on the page.
- 2026-07-04: Onboarding step navigation must stay sequential even in development; avoid dev-only
  `goToStep` bypasses or "continue anyway" buttons that advance after an incomplete step.
- 2026-07-04: OnboardJS `updateContext` is async and persists before notifying state; await it
  before enabling or performing step navigation that depends on newly written `flowData`.
- 2026-07-05: OnboardJS flows with a visible final step must still call `next()` from that step so
  `onFlowComplete` persists the completed state; do not clear evidence flags before completion.
- 2026-07-04: tRPC router procedure keys cannot use reserved object names such as `apply`;
  expose plan-template creation as `planVersions.applyTemplate` and keep client calls aligned.
- 2026-07-04: Theme-sensitive visuals should use `resolvedTheme` from `next-themes`, not
  `theme`; `theme` can be `"system"` while the rendered UI needs the actual light/dark palette.
- 2026-07-09: `.ledger-dots` is a background utility; keep its pseudo-element isolated and behind
  content instead of raising each child panel or text layer.
- 2026-07-04: Workspace signup should omit `planVersionId` when no pricing CTA plan is
  selected; sending an empty string blocks the customer signup default-plan resolver.
- 2026-07-04: Dashboard header full logos should use the `Logo` size prop, not Tailwind
  `size-*` width/height classes; fixed-size wrappers can make the SVG mark flex-shrink away while
  the wordmark remains visible.
- 2026-07-04: Centered ghost cards in dashboard forms need `w-full` alongside `max-w-*`; otherwise
  conditional form sections can make the flex item shrink-wrap different content widths.
- 2026-07-05: Subscription phase history actions should derive from phase timing (`past`,
  `active`, `future`); render historical rows from embedded phase data and only allow removal for
  future phases.
- 2026-07-05: Subscription phase scheduling belongs in `SubscriptionPhaseForm` as a form mode, not
  a separate change-plan dialog; keep view/create/schedule in one sheet so provider, trial, usage
  credit policy, payment method, and config stay visible together. The user-facing entry point is
  still Add phase, not a separate row-level schedule action.
- 2026-07-05: Future subscription phases are editable scheduled work. Use the edit sheet for safe
  future-phase updates, keep active/past phase commercial fields locked, validate `endAt >= startAt`,
  and only append another future phase after the current last future phase has an end date.
- 2026-07-05: Workspace self-serve plan changes must reject subscriptions with a future phase; only
  internal subscription phase editing should modify scheduled phase timelines.
- 2026-07-05: tRPC redacts all 5xx messages in `error-format.ts`; map expected domain `Result`
  errors to `BAD_REQUEST`, `PRECONDITION_FAILED`, or another 4xx code in the adapter when the
  message should be customer-visible.
- 2026-07-05: In the Next.js tRPC client, generate `unprice-request-id` with a lazy `headers`
  function; a shared header object reuses one request id across unrelated mutations.
- 2026-07-05: Dashboard tRPC mutation failures should use the global MutationCache toast in
  `apps/nextjs/src/trpc/shared.ts`; local `onError` handlers should keep rollback/state side
  effects only, or they create duplicate error toasts.
- 2026-07-05: Project danger-page mutations should pass the route `workspaceSlug` and `projectSlug`;
  `protectedProjectProcedure` falls back to workspace/project cookies when inputs are absent.
- 2026-07-03: Customer detail header actions are rendered by
  `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/layout.tsx`
  for every tab; for tab-specific header buttons, keep the header data load in the layout and put
  `useSelectedLayoutSegments` branching in a small client action child.
- 2026-07-03: Dashboard breadcrumbs are rendered by the `@breadcrumbs` parallel route, so they
  only see URL/search params. For entity-context crumbs, pass context in the URL/search params or
  resolve it inside `apps/nextjs/src/app/(root)/dashboard/@breadcrumbs/[...all]/page.tsx`.
- 2026-07-03: Customer current-access usage is a per-feature entitlement-period view, not the
  last-30-days evidence view; compute/query each active usage entitlement by its current grant
  `period_key` and keep the UI on realtime polling so reset-specific windows update in place.
- 2026-07-03: Workspace billing overview is self-reflective customer reporting; resolve
  `workspace.unPriceCustomerId` to the customer owning project before calling customer
  current-access, wallet, or usage-dashboard queries.
- 2026-07-05: Workspace/project selector plan badges should use active subscription
  `planSlug`/current-access state; do not reintroduce a workspace-owned plan display column.
- 2026-07-03: Dialog forms rendered from inside another React form can still bubble submit events
  through the React tree even when Radix portals the dialog content; stop propagation on the dialog
  form submit when the inner action must not save the parent form.
- 2026-06-13: Public `generateStaticParams` paths must not call session helpers or live database
  queries; return `[]` for dynamic ISR routes so `next build` does not depend on request scope or
  preview database reachability.
- 2026-08-10: Do not use `generateStaticParams` for a public page that reads `searchParams` for
  preview access; the static ISR path can fail at runtime with `DYNAMIC_SERVER_USAGE`. Let the
  request-time API make that route dynamic and retain explicit `unstable_cache` data caching.

## Billing, Wallets, And Invoices

- 2026-11-04 ([ADR-0008 D2](adr/ADR-0008-payer-budgets-rate-cards-and-r2-journal.md#d2-a-rate-card-owns-every-price-a-plan-version-owns-the-package)): A plan feature's `config` keeps only `usageMode` and `units`; read every price from the version's card with `rateCards.pricingForPlanVersions`/`rowsForVersions`, and format it with `describeRatePrice` (`@unprice/services/pricing`, client-safe). Templates, `monetization.apply`, and onboarding price a draft through `pricePlanVersion`, one card per version.
- 2026-11-04: Price every draft target after the completeness check, never inside materialization: a run that wrote all features then failed to price leaves a complete draft. `pricePlanVersion` (`services/src/rate-cards`) adopts a card already named `<slug> <pvId> <currency>` when its unit matches.
- 2026-11-04: Publishing refuses `unpriced` (no card in the version's currency, or a plan feature without a current or scheduled row). A draft's new currency deletes its other-currency card assignments.
- 2026-11-04: `RateCardService` writes clear `cache.planVersion` for every version on the card; `planVersionList` keys are filter combinations, so both namespaces go stale after `CARD_REFRESH_MS`.
- 2026-11-04: `monetization.get` reads prices back from the card in canonical decimals, so the boundary canonicalizes prices on parse ("0.10" hashes as "0.1"); a feature whose card rows a decimal price cannot state makes its plan unrepresentable.
- 2026-11-03: Tiers are graduated only (volume and `tierMode` removed, U1). A graduated config
  whose higher tier has a smaller flat fee still prices a positive usage delta negatively (the seeded
  plans do at 1000 -> 1001), so never assume tier cost deltas are non-negative.
- 2026-11-04 ([ADR-0008 D4](adr/ADR-0008-payer-budgets-rate-cards-and-r2-journal.md#d4-usage-is-priced-once-at-ingestion)): `billPeriod` seals the statement key through `PayerBudgetGateway.seal` at `max(now, period end + 1)` (a phase's last statement ends 1 ms past its inclusive end), bills each statement's amount as priced at ingestion, and prices recurring items from the plan card with `priceQuantity`, prorated over the period clipped to its phase. A metered period without a statement bills zero; one still open blocks the invoice for a retry.
- 2026-11-04: `completeInvoiced` runs before and after every invoice and completes each sealed statement whose billing period is invoiced or voided, so a completion lost after a commit heals on the next run.
- 2026-11-04: A canceled subscription's machine is final; invoice it with `BillingService.invoiceCanceledSubscription` (an immediate cancel passes grace 0, the invoicing job the usual grace). Billing-period capping only reaches phases that ended within the lookback, so proration also clips to the phase.
- 2026-11-04: Service integration plans price recurring items only from rate cards: the plan seeds carry `card_test_arrear`/`card_test_advance`; a test that inserts a recurring feature must add its row, or it bills free.
- 2026-11-02: Wallet quantity excludes free usage accepted before reservation allocation. A correction can cross that boundary; keep grant usage exact and floor the wallet quantity at zero while preserving captured and pending quantities.

- 2026-10-27: When collection succeeds, settle the receivable before saving `paid`; keep failed
  settlement eligible for retry with the existing invoice idempotency key.
- 2026-10-27: When checking invoice readiness, include all pending rows for the statement across
  phases; advance-plan usage still needs grace because its stored invoice time is at cycle end.

- 2026-09-20: Customer ledger statements must use `COALESCE(event_at, created_at)` for both date
  filters and pagination order; ordering by insert time moves late or backfilled transfers to the
  wrong visible date and page.
- 2026-07-19: Plan-included credits are configured on `plan_versions.metadata.includedCreditAmount`
  (ledger scale) and derived into a `plan_included` activation grant in
  `derive-provision-inputs.ts`; phases on such plans must use the `capped` policy
  (`CREDIT_POLICY_CONFLICT` otherwise) because uncapped phases never open wallet reservations.
- 2026-07-19: `drainGrantedFIFO` ranks `credit_line` last among granted credits (free money first),
  then expiry, then `createdAt`; same-transaction grants share `created_at`, so never rely on
  insertion order for drain priority.
- 2026-07-04: `dayOfCreation` is a plan/reset config shorthand; subscription phases store the
  numeric anchor resolved with `getAnchor`, and subscription period windows must preserve
  `subscription_phases.start_at_m`.
- 2026-07-04: Project payment-provider mutations should pass the route `workspaceSlug` and
  `projectSlug`; Stripe provider `active` must stay false unless the managed connection status is
  `active`.
- 2026-07-04: Workspace billing portal actions must use the active subscription phase
  `paymentProvider`; map provider config failures to provider-agnostic billing portal messages.
  Also pass the URL `workspaceSlug` into workspace-scoped mutations so `protectedWorkspaceProcedure`
  does not fall back to a stale active workspace.
- 2026-07-01: Billing periods generated for subscription phases must never start before
  `subscription_phases.start_at_m`; `statement_key`, pay-in-advance `invoiceAt`, and proration
  all derive from that service start, so rounding down can merge phase-change invoices.
- 2026-06-22: Customer wallet dashboards should distinguish ledger balances from usable display
  balances; expired-by-time wallet credits can remain in ledger until the sweep runs, so UI
  availability must derive from non-expired credits and show credit status explicitly.
- 2026-06-22: Per-credit wallet consumption should come from
  `entitlement_reservation_funding_legs.captured_amount` grouped by `wallet_credit_id`; do not
  infer it from issued minus usable balance, because expired unused credits would look consumed.
- 2026-06-22: Positive wallet `captureReservationUsage` calls must carry billing period and
  statement context; otherwise `customer.*.consumed` can gain non-invoice-backed
  `wallet_capture_usage` ledger rows.
- 2026-06-22: Invoice-visible wallet captures must also carry
  `feature_plan_version_item_id`; `billPeriod` uses it with `billing_period_id` to avoid
  re-rating already captured capped-wallet usage.
- 2026-06-22: External-reservation entitlement applies must roll back meter/grant writes before
  caching `RUN_BUDGET_EXCEEDED`; only accepted run events should advance usage state.
- 2026-06-13: Dashboard-initiated provider return URLs should resolve from
  `window.location.origin` at submit/click time; `APP_DOMAIN` is only safe for canonical host links
  and can point at localhost when public env defaults leak into preview/prod bundles.
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
- 2026-06-15: After invoice money is quantized to currency minor units, render fixed currency
  minor digits in invoice UI; otherwise `3.60 EUR` appears as `3,6 €` and looks inconsistent with
  analytics cards.
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
- 2026-06-07: Wallet capture ledger metadata must include `feature_slug` and `quantity`; invoice
  read models should consume ledger-projected descriptions/quantities instead of looking up usage
  feature labels from billing periods.
- 2026-06-07: Subscription phase edits must persist `paymentMethodId` in `updatePhase`; the
  Next.js phase form should not reset a selected payment method from plan-version defaults.
- 2026-06-07: Transaction-backed phase creation must materialize billing periods after the outer
  transaction commits and before wallet activation; async `waitUntil` period generation can race
  immediate usage and leave the payer budget without a statement period.
- 2026-06-12: Subscription machine activation already runs under the subscription lock during
  renewals; call billing-period materialization with `lock: false` from that actor, or
  `generateBillingPeriods` will reacquire the same lock and park the subscription in
  `pending_activation`.
- 2026-07-03: tRPC subscription machine adapters must map expected lifecycle refusals like early
  renew, invalid invoice action, and `SUBSCRIPTION_BUSY` to non-500 errors; `INTERNAL_SERVER_ERROR`
  is masked to "Internal server error" in the dashboard.
- 2026-06-07: When signup or provider-completion use cases materialize billing periods, wire
  `billing` through API route service bags and `apps/api/src/hono/env.ts`; missing adapter wiring
  can return signup `success=false` with a hidden `generateBillingPeriods` error.
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
- 2026-07-19: Billing activation grant derivation must receive the machine's current phase ID;
  never select an unordered subscription phase when renewals or plan changes can retain old phases.
- 2026-05-17: Public signup `creditLineAmountMinor` is currency minor units; convert to
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
- 2026-06-08: Wallet capture usage transfers are statement-keyed; capped-wallet statement tests
  should assert transfer source types, not raw pgledger debit/credit entry counts.
- 2026-06-08: API error mapping must treat `UnPriceWalletError("WALLET_LEDGER_FAILED")` as an
  infrastructure 500; only `WALLET_EMPTY` is a business ingestion denial.
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

- Do not add billing-period writes to `internal/services/src/ingestion/entitlement-context.ts`; that loader reads/caches entitlements and billing contexts only.

Related: [ADR-0002](docs/adr/ADR-0002-wallet-payment-provider-activation-guardrails.md).

## API SDK And Public Contracts

- 2026-10-19: Both SDKs share one transport, `packages/budgets/src/transport.ts` (retries, error
  mapping, headers, telemetry); fix it there, never in `packages/api`.
- 2026-10-19: SDK codegen lives in `tooling/scripts/sdk-codegen/`; `@unprice/budgets` types a subset
  piped from `budget-openapi.mjs`. `pnpm --filter @unprice/api generate` regenerates both SDKs.
- 2026-10-19: The SDKs resolve to `dist`, so turbo's `typecheck`/`test` depend on `^build`; a job
  running them outside turbo must build `./packages/api` (and with it `@unprice/budgets`) first.

- 2026-09-01: Public API adapters must map expected service errors through
  `resolveDomainErrorKind`; never use a catch-all `BaseError -> BAD_REQUEST` rule, which turns
  disabled, conflict, precondition, and internal failures into the same client error.
- 2026-09-19: Service errors exposed through HTTP or tRPC must extend `DomainError` and own their
  `kind`; keep `resolveDomainErrorKind` independent of concrete service and use-case errors.
- 2026-06-21: Tooling that calls `unprice.analytics.usage.get` should consume the public SDK row
  shape (`usage` plus formatted `spending`), not raw analytics/lake fields such as `value_after`
  or `amount_after`.
- 2026-06-20: Public Hono routes must use `defineEndpointContract`; for `audience: "public"`,
  SDK-exposed operations must set `sdk.path` and `operationId` must equal
  `sdk.path.join(".")` so OpenAPI, docs, and `@unprice/api` resources generate from one
  product operation. Public routes that should not generate SDK methods must set `sdk: false`.
- 2026-06-20: Internal and provider-callback API routes must set `audience: "internal"` or
  `audience: "callback"` plus `sdk: false` and must not be exposed through generated SDK
  resources.
- 2026-06-20: Run `pnpm --filter @unprice/api generate` with the API dev server running before
  SDK contract work is complete; it updates `apps/docs/openapi.json`,
  `packages/api/src/openapi.d.ts`, and `packages/api/src/generated/sdk-resources.ts` together.
- 2026-10-16: `pnpm generate` writes `openapi.d.ts` unformatted (4 spaces, semicolons), which
  diffs every line; run `pnpm biome format packages/api/src/openapi.d.ts --write` afterwards.
- 2026-05-08: Public Hono routes callable from `@unprice/api` need SDK-shaped `operationId`s.
- 2026-05-08: Align first OpenAPI tag and first `/v1` path segment with the SDK namespace.
- 2026-05-08: Keep SDK resource methods as one-object calls grouped by product concepts.
- 2026-05-08: Payment methods live under `/v1/payments/methods/*`; provider callbacks/webhooks
  under `/v1/payments/providers/*`.
- 2026-05-06: Tiny-tools fake customer tests should use real feature slugs and expect
  `customer_not_found`, not `feature_missing`.
- 2026-05-06: Validate local provisioning with signup E2E before usage E2E:
  `UNPRICE_TOKEN=unprice_dev_1234567890 pnpm --filter @unprice/tiny-tools e2e:signup:local`.
- 2026-07-01: Tiny-tools signup against localhost authenticates only against the API database in
  `apps/api/.dev.vars`; preview/prod API keys must be recreated or seeded into local
  `unprice_apikeys`, and plan slugs should be treated as lower-case slugs.

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
- Tailwind v3 + Radix var tokens: opacity modifiers like bg-success-bg/40 don't reliably apply alpha (tokens are var(--…) strings). For emphasis ramps use Radix steps: bg → bgHover → bgActive.
- 2026-07-15: When WAAPI choreography must react to layout that differs per state (MoneyPath's
  stacked one-outcome column), stamp the state as a data attribute on the stage synchronously in
  the same tick before measuring waypoints — React state set in the same function re-renders too
  late for `getBoundingClientRect`. Keep both branches in the DOM (globals.css hides the inactive
  one below `sm`) so no-JS and reduced-motion still render the full fork.
- 2026-06-13: `@unprice/ui/checkbox` wraps Radix Checkbox and renders a button; do not nest it
  inside another button in filter rows or table actions, because React/Next will hydration-fail on
  invalid button descendants.
- 2026-06-13: Dashboard near-realtime queries with a default relative window must advance the
  query input timestamp on each poll; refetching a frozen `{ from, to }` window only reloads old
  data.
- 2026-06-15: Customer-visible relative usage dashboards should poll on the same 30s cadence as
  the analytics SWR freshness window and display payload `freshness.generatedAt`; keep Basin SQL
  throttling in the tRPC cache instead of bypassing it from the UI.
- 2026-06-15: Usage dashboard money must reconcile after currency-minor rounding; header totals,
  feature rows, and top consumers should share the same rounded allocation source instead of each
  independently rounding raw ledger-scale amounts.
- 2026-06-12: Dashboard client components that use `useSuspenseQuery` for protected tRPC data
  must have matching RSC `trpc/server` prefetches; otherwise server render can fall back to the
  app React Query HTTP link without browser cookies and log `User not found in session`.
- 2026-05-07: After provider payment-method setup, bypass `customerPaymentMethods` cache and poll
  before showing an empty state.
- 2026-05-07: Keep subscription creation drafts open while provider setup runs; refetch with
  `skipCache` and auto-select the first method.
- 2026-06-13: When commits fail with react-doctor errors, run `pnpm run doctor`, read the full
  diagnostics directory it outputs, and fix each rule's root cause.
  Do not suppress rules. Common fixes: move hooks before early returns (rules-of-hooks), derive
  state instead of syncing via useEffect (no-derived-state), hoist `new Intl.*` to module scope
  (js-hoist-intl), use `next/dynamic` for heavy chart libs (prefer-dynamic-import), replace
  `[...arr].sort()` with in-place sort or `.toSorted()` (js-tosorted-immutable), combine
  `.filter().map()` chains into `for...of` loops (js-combine-iterations), destructure
  `useQuery`/`useInfiniteQuery` results (query-destructure-result), and split 300+ line components
  (no-giant-component).
- 2026-06-13: Every client-side `next/dynamic` or `React.lazy()` component must include a `loading`
  fallback that matches the component's layout dimensions (e.g., a `<Skeleton>` with the same
  height/width). Without it, the page content shifts when the chunk arrives, causing visible flicker.
- 2026-08-01: Server Components can render a `"use client"` component directly; do not wrap it in
  `next/dynamic({ ssr: false })`, which Next 15 rejects during the build.
- 2026-08-01: In Next 15 App Router pages, `params` and `searchParams` are promises; await them
  before reading route fields or passing query state into `nuqs` loaders.
- 2026-08-01: Let `src/app/icon.svg` own `/icon.svg`; a matching `public/icon.svg` makes normal
  page loads fail with Next's conflicting-public-file 500.
- 2026-06-15: Use `EmptyPlaceholder` with `isLoading` prop for loading states instead of inline
  spinners; use `EmptyPlaceholder` with Icon/Title/Description for empty states. This keeps the UI
  consistent across tables, charts, and panels. The component lives in
  `apps/nextjs/src/components/empty-placeholder.tsx` and accepts `isLoading` to show a centered
  `LoadingAnimation`.
- 2026-06-15: Whenever you are using link component, prefer the superlink component if the link is inside the dashboard.
  The superlink component disables the auto fetch of next.js, allowing to reduce unnecesary load.

## Tests, Tooling, And Docs

- 2026-11-03: Zod 4 throws on `.pick`/`.omit` of a refined object; export the unrefined fields
  schema and refine each composition (see `validators/rate-cards.ts`). Postgres `jsonb` reorders
  object keys (shorter first), so compare stored JSON with `canonicalJson` (`rate-cards/wire.ts`)
  and expect stored-map iteration order, not authoring order.

- 2026-10-27: Select integration databases through `BILLING_TEST_DATABASE_URL` in the shared test
  helper; Vitest worker `env` alone does not select the database used by global setup.

- 2026-10-19: Every API error's `docs` field links to
  `docs.unprice.dev/api-reference/errors/code/<CODE>`; give each code the API returns a page there
  and list it in `docs.json` (`BUDGET_EXCEEDED` and `INSUFFICIENT_PERMISSIONS` were missing).

- 2026-10-16: Keep `getAnchor` month-length calculations entirely in UTC; local `endOfMonth`
  combined with `getUTCDate` returns day 1 in Bogotá. Verify billing changes under both
  `TZ=America/Bogota` and `TZ=UTC`.

- 2026-08-31: Before launch, remove retired endpoint docs; do not add compatibility redirects
  or deprecation pages for API operations that users have not used.

- 2026-08-31: When retiring empty `getUsageDashboard` cache entries, version the key;
  deleting after `swr` can remove a concurrent refresh. Cover stale refresh and zero-usage
  evidence with the real `@unkey/cache` memory store.

- 2026-08-31: Keep internal ingestion rollout guides out of `apps/docs`; verify public MDX
  examples against `apps/docs/openapi.json` and the owning implementation. Link full SDK schemas
  to the generated API reference instead of maintaining parallel field catalogs.

- 2026-08-31: Keep docs money-path SVGs aligned with the full landing graph: `usage.consume`,
  `LIMIT_EXCEEDED`, and the invoice arithmetic. Use native SVG without filters or `foreignObject`,
  and select light/dark assets with Mintlify theme classes rather than the OS color preference.

- 2026-08-26: License project-owned files under `packages/**` as MIT and all other project-owned
  files as AGPL-3.0-only; keep the release guard checking each package's MIT metadata and local
  `LICENSE` file.
- 2026-08-11: Before publishing a repository skill with `gh skill publish`, remove tracked
  `.agents/skills` installs from Git and give each `SKILL.md` a license; discovery otherwise
  includes foreign skills and emits source-hygiene warnings.

- 2026-07-31: The audit override upgrades `tar@^6` to v7; keep `apps/docs` on
  Mint `^4.2.770` or newer, because Mint 4.2.354 default-imports `tar` and crashes on Node 24.
- 2026-06-22: `millionco/react-doctor@v2` passes `--scope` during PR scans; keep its
  `version` input on `react-doctor` 0.5.x or newer. The repo now pins Node 24.17.0, so keep the
  root `doctor` script and the action on the same Node 24 toolchain. Keep the root script on the
  installed `react-doctor` binary so pnpm owns native optional dependencies.
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
- 2026-05-29: Compact-only ingestion DOs use batch tables as the replay source:
  `idempotency_key_batches`, `meter_facts_outbox_batches`, and `ingestion_audit_batches`.
  Do not reintroduce per-event DO tables or a DB-backed meter storage adapter.
- 2026-05-29: Async ingestion must not ack when audit DO commit fails after entitlement apply;
  throw so the queue retries against entitlement idempotency instead of losing audit intent.
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
- 2026-06-15: Usage analytics that must reconcile with invoices should aggregate latest
  `amount_after`/`value_after` per `customer_entitlement_id + grant_id + period_key`, then sum to
  the visible feature. Rank latest facts by a DO-owned `fact_sequence`; treat customer
  `idempotency_key` as dedupe identity and legacy fallback only.
- 2026-08-24: Run settlement tests must cross the budget cumulatively across separate steps and
  prove full usage, capped funded capture, replay safety, and terminal reconciliation together.
- 2026-06-22: Ingestion billing-period context should expose only `pending` periods; allowing
  `invoiced` periods lets late events create wallet ledger captures after the invoice is frozen.
- 2026-07-04: Browser/onboarding usage callers should use `POST /v1/usage/record` for async
  evidence and `POST /v1/usage/consume` for synchronous checks; `/v1/events/ingest*` is stale.
- 2026-07-04: Onboarding evidence setup should call the generated API SDK from a backend
  use case exposed through tRPC; do not hardcode public API `fetch` URLs in onboarding UI.
- 2026-07-19: Onboarding evidence retries must reuse deterministic customer, API-key, and
  subscription identities; resume completed runs and start a fresh run only after a failed run.
- 2026-07-04: For scheduled future subscription phases, pass request `now` into
  `subscriptions.createPhase`; passing the future `startAt` makes the service activate the phase
  immediately and can update subscription state before the effective boundary.
- 2026-07-05: When running `apps/nextjs` with `SKIP_ENV_VALIDATION=true`, set
  `NEXT_PUBLIC_APP_DOMAIN` explicitly to the dev host/port; otherwise middleware can treat
  localhost requests as customer-site routes.
- 2026-07-05: Before starting any frontend/dev server, check whether the app is already running
  on its normal port; if a server is running, use it instead of starting another one, and ask the
  user before launching an additional server.
- 2026-07-12: Run biome via `./node_modules/.bin/biome` — `npx biome` fetches a mismatched
  version that dies OOM. The repo pin lives in node_modules.
- 2026-07-13: Landing "Reveal"-wrapped content renders opacity-0 in Playwright fullPage
  screenshots (IO never fires in stitched captures) and very tall fullPage shots can duplicate
  the first viewport at the bottom; verify with stepped real scrolling + per-section viewport
  shots instead.
- 2026-10-21: The budgets landing video comes from `~/repos/tutorials/budgets-launch`. When its copy changes, update the scene and narration, regenerate timing and the mix, then replace `apps/nextjs/public/videos/budgets-launch.mp4` with a web export of the new render.
- 2026-10-21: The main landing animation comes from `~/repos/tutorials/unprice-spend-authorization`. Export 720p H.264 with `preload="none"`; files under `public/videos/spend-authorization/` have immutable caching, so regenerate content hashes and update `demo-video.ts` when replacing them.
- 2026-07-13: A `curl --max-time 5` timeout against :3000 does not mean the port is free — the
  user's dev server may be cold-compiling. If `next dev` reports "Port 3000 in use, trying
  3001", the :3000 owner is another server; verify against the one serving the working tree.
- 2026-07-31: Period-boundary entitlement tests must freeze `Date.now()`; single-event metering
  validates event age against ambient time rather than the request's `now` field.
- 2026-07-31: Vitest 4 mocks used with `new` must be classes or regular-function implementations;
  arrow-function `vi.fn()` implementations are not constructible.
- 2026-07-31: `@cloudflare/vitest-pool-workers` v0.20 uses an ESM `.mts` Vitest config and the
  `cloudflareTest` plugin; the old `/config` helper is no longer exported.
- 2026-08-02: Use a zero-priced first graduated usage tier for included units and a later paid
  tier for overage; `customers.signUp.creditLineAmountMinor` is the separate per-period customer
  spend cap, expressed in currency minor units.
- 2026-08-03: Direct signup replay succeeds only after billing periods plus activation/invoice
  side effects complete; reconcile partial state or surface a failure rather than reporting
  semantic success early.
- 2026-08-10: Treat `*.vercel.app` deployment hostnames as application hosts, never customer
  site domains; otherwise site middleware can rewrite a preview request into a customer-site page.
- 2026-08-10: When a preview uses the shared `auth.unprice.dev` redirect proxy, its
  `AUTH_SECRET` must equal the proxy's `AUTH_SECRET`; an OAuth callback otherwise cannot decode
  the state cookie.
- 2026-08-10: Preview Vercel builds must pass `APP_ENV=preview` and
  `NEXT_PUBLIC_APP_ENV=preview` explicitly; an inherited development value makes `APP_DOMAIN`
  generate `http://app.<preview-domain>` instead of the `app-<preview-domain>` alias.
- 2026-09-19: Shared URL constants must prefer `NEXT_PUBLIC_APP_ENV` when it is set; `APP_ENV`
  has a development default and can otherwise override preview configuration. Keep
  `APP_BASE_DOMAIN` hyphenated for preview aliases.
- 2026-09-19: Never apply the Vercel preview alias to a localhost app, even when preview variables
  are inherited; local auth must use `http://app.localhost:<port>`.
- 2026-10-16: k6 cannot share state across VUs, so a load test that must compare a server total
  with what the client saw uses a `Counter` that VUs add to and `teardown` subtracts from, with a
  `count==0` threshold (`tooling/k6/budgets.ts`). Counters accept negative values, and a non-zero
  total fails the run with exit 99.
- 2026-10-16: k6 in Docker Desktop against a local `wrangler dev` occasionally reuses a keep-alive
  connection the server already closed and gets `EOF` (status 0). It is the client pool, not the
  API: the same load is clean with `K6_NO_CONNECTION_REUSE=true` and with Node's `fetch`. Check
  for it before chasing a server bug.
- 2026-10-16: A dedupe that relies on a client-sent timestamp (`record`'s `occurredAt` bounding
  replays past the 25-hour receipt) breaks the moment the SDK defaults that timestamp to the time of
  the call: a retry gets a fresh time and passes the bound. Require it in the SDK, and keep clock
  values out of the request hash so a re-stamped retry replays instead of conflicting.
- 2026-10-16: Don't store a flag the config already implies. The budget's anchored counters used
  an `orphan` flag for "no limit references this"; `rollCounters` now reads that from the limits in
  force, so the flag cannot drift from the config. Likewise, don't wake an alarm for a roll a
  counter can replay later from its own period start.
- 2026-10-16: A closed budget row answers until its `dueAt` by the clamped clock, not until the
  alarm purges it. A keyed command that reuses an expired row's key returns that row in `purged`,
  and the store deletes it before inserting (the `key_hash` index is unique).
- 2026-10-16: To rewrite the budget core, freeze the old core next to it and diff every outcome
  with fast-check across monotone, disjoint-key, and skewed clocks. On a skewed clock, purge the
  frozen store only up to its own `lastAt`, or the harness reports false divergences.
- 2026-10-16: Budget DO migrations are append-only once pushed (preview deploys run them). Keep
  each `drizzle-kit generate` to drops or to creates: a create and a drop together prompt for a
  rename, which cannot be answered non-interactively.
- 2026-10-16: `BudgetDO` creates its schema on the first upsert; any other verb on an empty object
  answers `BUDGET_NOT_FOUND` without writing. A test that builds its own processor over
  `state.storage` must run `migrate` first.
- 2026-10-17: Budget rows have two times: `dueAt` is retention (null while a hold is open) and
  decides whether a row still answers; `alarmAt` is when the alarm visits (an open hold's expiry)
  and is what `due_at` stores. Using `alarmAt` for retention would retire live holds.
- 2026-10-17: `apps/api` tsconfig excludes tests, so a new required field on `BudgetCommand` only
  fails at runtime in DO tests. Grep `type: "upsert"` and update every helper when it changes.
- 2026-10-17: After `pnpm --filter @unprice/api generate`, format `packages/api/src/openapi.d.ts`
  with `./node_modules/.bin/biome format --write`; the raw output is a 19k-line style-only diff.
- 2026-10-17: A Durable Object that deletes its own storage must also reset any "schema ready"
  latch inside the same `blockConcurrencyWhile` (`BudgetDO` sets `ready = null`), or the next
  request on the live instance runs against dropped tables.

## AI budget integrations

- 2026-10-21: AI reservations include only price tiers whose strict threshold is below the input bound. Keep every reachable rate, including lower tiers, so unordered or decreasing catalog prices remain safe.
- 2026-10-21: Adaptive AI admission belongs in `packages/budgets-ai`: count OpenAI input only after definite denial, then reauthorize the final output allowance. A local lease remainder cannot prove exhaustion because the lease can refill.
- 2026-10-20: AI budget adapters share final serialized request policy in `packages/budgets-ai`; Pi and AI SDK wrappers only convert native calls and usage. Keep a hold per physical dispatch and preserve JSON versus SSE mode.
- 2026-10-20: Public integration packages must be added to `tooling/scripts/assert-publishable-packages.mjs` and ship their own MIT license. Build workspace dependencies before standalone package tests or archive consumer tests.
- 2026-10-20: Anthropic and Gemini preflight counts are estimates. Budget holds use the byte bound of the final request body (`inputBound` in `packages/budgets-ai`) plus Anthropic's hidden tool-use prompt when tools are present; refunds require final raw usage evidence because native SDKs can emit finish events from preliminary counters.
- 2026-10-20: Downstream packages test and typecheck against each other's built `dist`; after a change to
  `packages/budgets` or `packages/budgets-ai`, run `pnpm --filter @unprice/budgets build` then
  `pnpm --filter @unprice/budgets-ai build` before the ai-sdk and Pi suites, or they run the old code and
  typecheck reports missing declarations.
- 2026-10-20: `pnpm --filter @unprice/api generate:openapi` curls a running dev server on port 8787
  (`pnpm --filter api start`); then `pnpm --filter @unprice/budgets generate` and the api `generate:*`
  scripts, then rebuild `@unprice/budgets` and `@unprice/api` so `internal/services` typechecks.
- 2026-10-20: `pnpm exec biome ...` under the rtk hook dies with "Linter process terminated abnormally";
  run it as `rtk proxy pnpm exec biome ...`.
- 2026-10-20: A keyed budget verb with `ifMissing` creates its budget inside the same `decide` change
  (`decideUpsert` then the verb, `configured` merged); outcomes carry `created`, and a rejected first
  call writes no budget row. The DO prepares storage only for an upsert or a verb with `ifMissing`, and
  drops the schema again when that first call leaves no budget behind.
- 2026-10-20: Anthropic adds a hidden tool-use system prompt to input tokens whenever `tools` is sent
  (264 to 804 tokens by model and `tool_choice`, per its tool-use docs). Anything a provider bills
  outside the request body needs a per-protocol reserve in `provider-request.ts`; a settle above the
  hold is rejected, so the session records the excess before settling the hold in full. Capture one budget handle and immutable recovery inputs; retry with the same event time and idempotency key.


- 2026-10-20: Operator release must carry `holdCreatedAt` into the budget core transaction; audit-row dedupe alone does not protect a replacement `h_1` after storage deletion.
- 2026-10-20: Budget inspection cursors use the indexed `(due_at, id)` order. Verify SQLite query plans and `rowsRead` on tied expiries; `LIMIT` alone does not bound query work.
- 2026-10-20: Replace the budget `due_at` index with `(due_at, id)` rather than keeping both. Local workerd measured identical operation-row write counts for either index; creating the replacement still writes approximately one index row per existing operation.
- 2026-10-21: Use `withUnpriceTool` for fixed-fee Pi Durable tools. It adapts the session/task ID to `budget.wrap` charge replay and records the fee in native Pi tool usage.
- 2026-10-21: Replacing local SDK archives at the same version can leave Vite's worker dependency cache on old code. Confirm the optimized module, refresh that generated cache, and reload the existing dev server before live verification.
- 2026-10-21: Put large Pi diagnostic prompts in a fork. Their text persists in the transcript and inflates later byte bounds, which can reduce the affordable output cap even when cached actual usage costs much less.
- 2026-10-21: Local budget charges deduplicate only within one lease. `withUnpriceTool` requires a remote handle and rejects local handles before charging or executing a durable tool.
- 2026-10-21: Export Pi Durable tools from `@unprice/pi-budget/tools`. The root declaration must compile without the optional Pi Durable peer installed.
- 2026-10-21: AI output search changes only numeric output settings. Check its byte bound against the serialized request across digit boundaries, including Anthropic's enabled thinking budget.

- 2026-10-27: Metering batches must preserve a persisted pending flush payload under its sequence. Coalesce only new draft flush intent.
- 2026-10-27: Billing integration fixtures must declare accepted usage independently from wallet captures and pass their gateway explicitly.
- 2026-10-27: Use classes for Vitest constructor mocks. `pnpm validate` can convert anonymous function mocks to non-constructible arrows.
- 2026-11-03 ([ADR-0008 D8](adr/ADR-0008-payer-budgets-rate-cards-and-r2-journal.md#d8-tinybird-is-deleted)): Web analytics rows go through `createWebEventsWriter` (validates with `webEventRowSchema`); a Pipelines stream accepts an invalid row and drops it silently.
- 2026-11-03: Web analytics reads are SQL builders in `services/src/analytics/web-analytics.ts` run by the `BasinSql` port. Escape every value with `sqlString`/`sqlTimestamp`; test with literal SQL and a fake port.
- 2026-11-04: An unauthenticated beacon (`/api/tracking`) parses its payload into its own object with `~/lib/web-tracking` schemas; never spread payload keys next to validated envelope ids, and bound every id with `attributionIdSchema`.
- 2026-11-04: Sign-up attribution travels only as explicit `planVersionId` and `pageId`: the pricing CTA URL carries them, `/auth/*` hands them to `/new`, and sign-up validates them. Never resolve a plan from web analytics; Basin exposes a plan click minutes later.
- 2026-11-04 (ADR-0008 D6, D7): Usage and access routes reach the payer budget through `meterPayerUsage` and `checkPayerAccess` with a `CloudflareBudgetClient`, never `runBudgetVerb`. Refused events go to `budget_journal` with `seq` 0, operation id `r:<idempotency key>`, and status `rejected`.
- 2026-11-04: `meterPayerUsage` never throws for a transport failure: the failing customer's remaining events answer `unavailable` (wire `UNAVAILABLE`/503, logged, not journaled). Usage routes report the whole batch once through `callBudget` + `batchOutcome` (`budget.outcomes` counts); never call `callBudget` per event, or the wide event keeps only the last one.
- 2026-11-04: `vi.clearAllMocks()` keeps queued `mockResolvedValueOnce` answers, so a test that fails before the call leaks them into the next test. Route tests that queue answers use `vi.resetAllMocks()` and re-arm the mocks in `beforeEach`.
- 2026-11-04 (ADR-0008 D7): Usage history reads `budget_journal` through `AnalyticsService` (builders in `services/src/analytics/budget-journal.ts`); every query keeps the latest `seq` per `(budget_key, operation_id)` with `QUALIFY ROW_NUMBER()`. Basin SQL has no UNNEST, so `priced.features[]` is read by index up to `FEATURE_SLOTS`; report the overflow row (null `feature_slug`) instead of dropping it.
- 2026-11-04: Test journal-backed use cases and routes with `journalAnalytics` (`@unprice/services/analytics/journal-fixture`): a real `AnalyticsService` over a fake Basin port that parses literal rows with the production row schemas.
- 2026-11-04 (ADR-0008 D8): Tinybird is gone. Dashboard interval, stat-card and usage-row contracts
  (`prepareInterval`, `analyticsIntervalSchema`, `statsSchema`, `getUsageResponseSchema`) live in
  `@unprice/db/validators`; `ServiceDeps` has no `analytics` client. Analytics reads go through
  `AnalyticsService` over Basin SQL only.
- 2026-11-04: `generate:openapi` needs only a booting worker: a `.dev.vars` copied from the example with `APP_ENV=development`, placeholder `DATABASE_*_URL`s, and every empty key filled serves `/openapi.json` on 8787 without real secrets.
- 2026-11-05 (ADR-0008 D2): Prices render as a vendor price sheet (`priceTableOf` in `services/src/pricing/price-table.ts`: a line per dimension value, a column per component, "per 1M tokens" in the header), never as the row's formula string. A catalog revision shows only the lines that change (`changeMatrixOf`), old rate beside new.
- 2026-11-05: A version's own card has no page of its own: `/rate-cards/<id>` redirects it to the version's Prices tab, and only shared cards keep the card route.
- 2026-11-05: `prefetch` in `~/trpc/server` returns the query's promise. A page whose first paint is the data (not a loading state the client would replace) awaits it before `HydrateClient`; otherwise React logs a hydration mismatch and re-renders the tree.
- 2026-11-05: Every raw `<input>` gets a 1px gray border from the global stylesheet. An inline table cell input must set `border-0` itself; a transparent border on the wrapper does not hide it.
- 2026-11-05: `duplicatePlanVersion` spreads the source row into the copy, so every lifecycle field the copy must not inherit (`publishedAt`, `publishedBy`, `archived*`) is reset explicitly. A copy that kept `publishedAt` made its own card live and every price change on the draft wait for the notice.
- 2026-11-05: Webpack dev keeps a deleted module in its graph (overlay error "Failed to read source code") until the dev server restarts; the page still renders, the overlay is noise until then.
- 2026-11-06: An SSR (`renderToString`) test of a component that reads a tRPC query renders its loading branch; seed the cache with `createTRPCOptionsProxy({ client, queryClient })` + `queryClient.setQueryData(trpc.x.y.queryKey(input), data)` to test the loaded UI.
- 2026-11-06: A feature's price draft must not prefill from a row of another `price.type` (`prefillDraft`): switching Fixed $49 to metered once offered "$49 per unit".
- 2026-11-06: `plans.listByActiveProject` returns only published versions unless called with `{ published: false }`; a lookup that names cards or versions (drafts included) must pass it.
- 2026-11-06: The publish-rows form writes one rate; a catalog model row has one per token kind. Replacing a model row from that form drops the other rates, so the dialog warns and points at the catalog markup instead.
- 2026-11-06: Don't nest a scroll area (`max-h` + `overflow-auto`) inside the dashboard's scrolling page: it traps the wheel and the page stops scrolling. Show the first rows plus "Show all" and let the page grow.
- 2026-11-06: Dashboard forms use shadcn parts only (`@unprice/ui` Select, Calendar in Popover, Command combobox, Collapsible, Table); no native `type="time"`, `datalist`, `<details>` or `type="search"`.
- 2026-11-06: A price never changes how a feature is charged: shape (`pricingShape`, now exported) and metered property (`featurePricingOf`) come from the plan feature, as a Stripe price's billing scheme is fixed. "Add a price" shows them read-only.
- 2026-11-06: `costPlusRevision` diffs every catalog model's latest row, manual ones included, so a markup change overwrites a hand-set model price. Until overrides are protected, the UI prices catalog features only through the markup.
- 2026-11-06: `model_costs` is global (`pgTableProject` only prefixes the name; no `project_id`); a project's own model costs live in `custom_model_costs` and enter `costPlusPreview` as `"manual"`, so they outrank models.dev for that project only.
- 2026-11-06: Catalog previews never save policies. `applyPlanVersionCatalogPricing` checks the reviewed feature-scoped hash and commits policy plus rows together; an exact retry writes nothing.
