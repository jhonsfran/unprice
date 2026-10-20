# Budgets dashboard: catalog on upsert, live truth on demand

## Status

Proposed on 2026-10-19. Not implemented.

Three competing designs were written in parallel and scored against one rubric by a separate
judge. This document is the chosen base plus the parts worth taking from the other two. The
section "Designs considered" says what lost and why.

## The problem

Operators need a **Budgets** item in the project sidebar. It opens a filterable list of the
project's budgets. A budget opens a small dashboard of its own: the live balance, each limit,
the money locked in open holds, recent activity, and a way to release a hold that is stuck.

Three facts shape the design.

- **Nothing can list budgets today.** A budget lives only in its `BudgetDO`. The object id is a
  hash of `${appEnv}:${projectId}:budget:${key}`, so Cloudflare cannot list objects back to
  keys. No Postgres table, Tinybird datasource, queue, or lakehouse event carries a budget key.
  The route's Axiom event has no key and keeps about 1% of 402 responses.
- **The hot verbs must not gain any work.** `authorize`, `settle`, `release`, `charge`,
  `record`, `lease`, and `report` run on one single-threaded object at 60 to 110 writes/s.
  Authorize p50 is about 40 ms, almost all of it the object hop and the output gate.
- **A budget key is not a safe URL segment.** It matches
  `^[A-Za-z0-9][A-Za-z0-9:/_.@-]{0,127}$`. A `/` splits a `[key]` segment, a trailing `.io`
  trips the middleware's file-extension skip, and the key can name a customer (personal data).

## The design in one paragraph

The upsert route writes one Postgres catalog row per budget after the object replies, off the
response path. The list reads only that catalog, so it never wakes an object. Its filters are
configuration facts, which only upsert can change, so no filter can go stale. The detail page
asks the object directly through a new read-only `inspect` method beside `execute`. `inspect`
returns the snapshot, the reservations that expire next, and the operations closed in the last
hour, each read bounded by a row cap. One operator action ships: release one open hold. It is
limited to OWNER and ADMIN, needs a reason and a no-usage attestation, and is written to an
audit table before and after the call. The hot verbs' code does not change.

## What the operator sees

### List: `/{ws}/{project}/budgets`

```
┌ Budgets ─────────────────────────────────────────────── [ Open by key ] [ </> API ] ┐
│ Spend caps your app enforces per customer, run, or agent.                            │
│ Configuration as of each budget's last change. Open a budget for its live balance.   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ [ Key prefix…  customer:acme ]  Status [open ▾]  Unit [USD ▾]  Cap [hard ▾]          │
├────────────────────────────────┬─────────────────────────────┬──────┬────────┬───────┤
│ Key                            │ Limits                      │ Unit │ Status │Changed│
├────────────────────────────────┼─────────────────────────────┼──────┼────────┼───────┤
│ customer:acme.io/prod      ⧉   │ 100.00/day hard · 2k/mo soft │ USD  │ ● open │ 2h    │
│ run:r_42                   ⧉   │ 5.00 hard                   │ USD  │ ◐ closes 14:00 │ 1m │
│ team:ops:tokens            ⧉   │ uncapped                    │ tok  │ ○ closed│ 9d   │
├────────────────────────────────┴─────────────────────────────┴──────┴────────┴───────┤
│ 1-25 of 312                                                      ‹ 1 2 3 … 13 ›      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

The filters are key prefix, status (`open`, `closing`, `closed`, derived from `closesAt`),
unit, and cap (`hard`, `soft`, `none`). **Open by key** reads the object once, registers a
budget the catalog missed, and goes to its page.

### Detail: `/{ws}/{project}/budgets/bgt_8f2k…`

```
┌ customer:acme.io/prod ⧉   [● open]  USD · v7                  [ Debug ] [ </> API ] ┐
│ Live from the budget · as of 14:32:05 · refreshes every 30 s                          │
├─────────────────┬─────────────────┬──────────────────┬───────────────────────────────┤
│ Remaining       │ Held (locked)   │ Consumed today   │ Resets                         │
│ 61.20 USD       │ 12.40 USD       │ 26.40 of 100.00  │ in 9h 27m (day)                │
├─────────────────┴─────────────────┴──────────────────┴───────────────────────────────┤
│ Limits                                                                                │
│ daily   hard  ████████░░▒▒▒░░░░░░  26.40 used · 12.40 held · 61.20 left               │
│ monthly soft  ███░░░░░░░░░░░░░░░░  410.00 of 2,000.00 · resets Nov 1                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Usage by period (daily, last 12)  ▁▃▅▂▇▆▃▄▅▆▃█                                         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Expiring next · 8.00 of 12.40 held listed                          [ Scan further ]   │
│ hold  h_4812  job-991   5.00  opened 13:20 (72m)  expires 14:35  in 2m55s [Release…]  │
│ hold  h_4820  job-1002  2.00  opened 14:20        expires 14:35  in 3m10s [Release…]  │
│ lease agent-7  1.00 left of 3.00                  expires 14:41  only its holder can return it │
│ At expiry an open hold is charged in full. Capacity returns when its window resets.  │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Closed in the last hour                                                               │
│ 14:31:58 settle  h_4830  0.31 of 0.50 held                                            │
│ 14:31:40 record  evt_77…  0.03                                                         │
│ 14:30:02 settle  h_4790  3.00 (expired, charged in full)                              │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Operator actions   Oct 19 13:02  ADMIN released h_4790 (3.00) "worker crashed pre-call" │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Debug sheet

The sheet opens from **Debug** and loads only when open (`enabled: open`), like
`ingestion-event-details-sheet.tsx`.

```
┌ Debug · customer:acme.io/prod ─────────────────────────────────────┐
│ Find an operation (last 24 to 25 h)                                │
│ ( ) hold id  (•) idempotency key  ( ) lease key  [ job-1002 ] ⏎    │
│ → hold h_4820 · open · 2.00 · created 14:20 · expires 14:35        │
│   Not found means denied (a denial writes nothing), never sent,    │
│   or purged.                                                       │
├────────────────────────────────────────────────────────────────────┤
│ Would it pass now?   authorize [ 70.00 ] ⏎                         │
│ → Denied by daily (hard, day): 61.20 left with 12.40 held.         │
│   Resets 00:00 UTC. Release stuck holds or raise the limit.        │
├────────────────────────────────────────────────────────────────────┤
│ Counters  upsert 7 · authorize 18,204 · settle 18,190 · …          │
│ Scan      examined 1,000 rows · listed 7 · inspect 1.4 ms          │
│ Raw       { snapshot, history }                             [copy] │
└────────────────────────────────────────────────────────────────────┘
```

"Would it pass now" runs the existing `blockingLimit` from `decide.ts` against the live
balance. A pure `explainDenial` turns its result, or a pasted 402 `blocked` body, into the
sentence shown.

## Data shape

There are two new Postgres tables and one new object method. Nothing else stores state.

**`budgets` (catalog).** One row per `(project_id, key)`. It stores configuration facts only:
`id` (`bgt_…`), `key`, `unit`, `version`, `cap`, a `limits` summary, `closes_at`, `created_at`,
and `updated_at`. It never stores a balance, because any copy of a hot budget's balance is
wrong within milliseconds. Indexes: the primary key `(id, project_id)`, a unique
`(project_id, key text_pattern_ops)` for prefix search, and `(project_id, updated_at)`.

**`budget_audit`.** One row per operator action, unique on
`(project_id, budget_id, action, subject)`. The only action is `release_hold`. A row stores the
actor's user id, the reason, the status (`requested`, `applied`, or `rejected`), the released
amount, and the rejection code. It references the catalog id and never copies the key.

**`BudgetDO.inspect(query)`.** A second RPC method. It runs in one synchronous SQLite
transaction and returns:

- the same snapshot and 12-period history that `get` returns, through the same `loadView` and
  `transition`. Like `get`, it writes only when a window rolled.
- `expiringNext`: the open holds and leases found by walking `budget_operations` in `due_at`
  order from a `(due_at, id)` cursor, examining at most 1,000 rows. The result carries the
  cursor for **Scan further**.
- `closedRecently`: rows whose retention ends in the next hour plus 24 h (closed holds and
  charges) or 25 h (records), newest first. That is two bounded range scans on the existing
  `due_at` index.
- `listed` and `held`: the sum of the listed reservations' exposure, next to the ledger's exact
  `held`. `held` already includes unused lease amounts (`exposureOf`).
- an optional `find` (point lookup by hold id, idempotency key, or lease key, through the
  existing indexed reads) and an optional `probe` (an amount checked with `blockingLimit`).

`execute`, `processor.execute`, `loadView`, `transition`, and the store's `commit` do not
change.

### Why the reservation list is "expiring next", not "all open holds"

Open holds sit in the `due_at` index at `expiresAt`. Closed rows sit at their end of retention,
24 or 25 hours after they closed. On any budget older than a day the two are mixed in the
index. At 100 ops/s, 1,000 rows cover about 10 seconds of expiry. A complete list would need a
partial index on `status = 'open'`, and that index costs a write on every authorize, settle,
and release. The design refuses it.

The bounded walk still answers the debugging question. A healthy hold settles in seconds, so
an open hold close to its expiry is almost always a stuck one. Ascending `due_at` lists exactly
those first. The money line says how much of `held` the list covers, so the page never claims
a complete list it did not produce.

## How data moves

```
upsert route ─► upsertBudget ─► BudgetDO.execute ─► reply to caller
                                     └─ waitUntil: catalog.record(catalogFactsOf(snapshot))
                                        (skipped for a pure replay)

dashboard list ─► tRPC budgets.list ─► Postgres catalog          (no object call)

dashboard detail ─► tRPC budgets.inspect ─► HttpBudgetOperatorGateway
   ─► POST /v1/internal/budgets/inspect ─► BudgetDO.inspect
   └─ read-repair: catalog.record on ok, catalog.forget on BUDGET_NOT_FOUND

release ─► tRPC budgets.releaseHold (OWNER, ADMIN) ─► releaseHoldAsOperator
   ─► audit "requested" ─► POST /v1/internal/budgets/release ─► existing release command
   ─► audit "applied" or "rejected"
```

These are the decisions that carry the design:

1. **The catalog write runs in `waitUntil` and never fails the upsert.** ADR-0006 example 3
   upserts a `run:<id>` budget at every run start, so upsert is on a hot path for per-run
   budgets. Run start must not depend on Postgres. A pure replay (`changes.length === 0` and
   `version > 1`) skips the write. A create with no limits also returns `changes: []`, so the
   version check is required too.
2. **The write is idempotent and only moves forward.**
   `INSERT … ON CONFLICT (project_id, key) DO UPDATE … WHERE budgets.version < excluded.version
   OR budgets.closes_at < now() - interval '7 days'`. The second clause admits an object that
   was deleted and created again at version 1.
3. **Drift converges three ways.** The next upsert that changes config rewrites the row.
   Opening the detail page repairs the row from the live snapshot, or forgets it when the
   object answers `BUDGET_NOT_FOUND`. **Open by key** registers any budget the catalog missed,
   including budgets created before the catalog shipped. A failed `waitUntil` write logs an
   error that sampling keeps.
4. **Operator routes are internal.** `/v1/internal/budgets/inspect` and
   `/v1/internal/budgets/release` use `audience: "internal"` and `sdk: false`.
   `internalKeyAuth` limits them to main and internal projects, so a tenant key cannot call
   them. The customer SDK packages (`@unprice/api`, `@unprice/budgets`) do not change. Services
   reach the routes through an HTTP gateway, the same pattern as
   `use-cases/billing/reservation-flush-gateway.ts`. The public `release` route is not touched.
5. **URLs carry the catalog id.** The path segment is `bgt_…`, so a key never appears in a URL,
   a breadcrumb, or a request log. The header shows the key with a `CopyButton`. **Open by key**
   sends the key in a tRPC body.

## What each verb gains

| Verb | Object rows | Awaits | Index upkeep | Bytes or sends | Code on its path |
| --- | --- | --- | --- | --- | --- |
| authorize | none | none | none | none | unchanged |
| settle | none | none | none | none | unchanged |
| release | none | none | none | none | unchanged |
| charge | none | none | none | none | unchanged |
| record | none | none | none | none | unchanged |
| lease | none | none | none | none | unchanged |
| report | none | none | none | none | unchanged |

Upsert gains one Postgres upsert in `waitUntil` after the reply, skipped for replays. `get`
gains nothing. `inspect` is new. It reads about 2 + 12 × limits rows for the snapshot, at most
1,000 rows for `expiringNext`, and at most 2 × 50 rows for `closedRecently`, all serialized
with the hot verbs on the same object. One open detail tab calls it once per 30 s. The target
is p99 at or under 2 ms inside the object on a budget with 1,000,000 operation rows. This
target is not measured yet. Phase 2 measures it.

## Locked funds

The page shows the exact `held` total, the per-limit held amounts, the reservations that expire
next with a countdown to "charged in full", and the money line that says how much of `held` the
list covers.

One action ships: **Release** on one open hold.

- **Who.** OWNER and ADMIN, through `ctx.verifyRole(["OWNER", "ADMIN"])`. Other roles see the
  table without the button.
- **What the person asserts.** ADR-0006 B3 says a release asserts that no usage occurred, and
  that time never returns a reservation. The dialog makes the operator state it: a required
  reason of 10 to 500 characters and a checkbox, "This work stopped and used nothing. If it used
  anything, ask its owner to settle the actual amount instead."
- **What the object enforces.** The route runs the existing `release` command. A hold the alarm
  already settled answers `HOLD_CLOSED`. A retired hold answers `HOLD_RETIRED`. A second click
  replays the first answer.
- **Audit.** `releaseHoldAsOperator` inserts a `requested` row before the call and moves it to
  `applied` or `rejected` after. A crash in between leaves a `requested` row. Running the action
  again reuses that row, because release is idempotent per hold.

There is no action for leases, for expired holds, or for many holds at once. Only the lease's
holder knows what it captured in memory, and B6 forbids releasing capacity that a pending
capture may still cover.

## Future fit

**Runs replaced by budgets (ADR-0006 step 6).** A run becomes the budget `run:<id>`, opened by
an upsert and closed by an upsert that sets `closesAt`. The run list is the Budgets list with
the key prefix `run:`. The **View Budgeted Runs** shortcut points there. The deletion removes
`budget_runs`, `listRunsRefreshed` (one object call per running row per render), RunBudgetDO,
the 12-hour refresh job, and the Budgeted Runs pages. The catalog, the URL scheme, the detail
page, and `inspect` do not change. If the closed-run list needs spend, the closing upsert
already returns the snapshot, so the catalog can store the consumed amount at close in one more
column.

**Parent budgets (ADR-0006 B6).** A child's upsert carries `funding: { parent: { key } }`. The
upsert use case resolves the parent's catalog row and writes a nullable `parent_id`, indexed on
`(project_id, parent_id)`. The list shows root budgets by default and expands a row to its
children. The detail page links the parent and lists the children from the catalog, with live
numbers from `inspect`. Capacity granted to children shows as the parent's open leases. The
tree lives only in the catalog behind tRPC and never in a public API field, as B6 requires.

## Where keys are copied

| Place | New | Lifetime |
| --- | --- | --- |
| `BudgetDO` SQLite `budget.key` | no | until `closesAt` + 7 days |
| Postgres `budgets.key` | yes | until project deletion; a prune waits until volume calls for it |
| Internal route request bodies | yes, in transit | not logged |
| Dashboard payloads and the `keyPrefix` search parameter | yes | the browser session |
| URLs, Axiom, Tinybird, `budget_audit` | no | the catalog id stands in |

Hold idempotency keys and lease keys appear in the detail page and the debug sheet. They are
stored nowhere outside the object.

## Delivery

Each phase ends in a check. Phase 1 alone ships a usable section.

1. **Catalog and list.** The `budgets` table, `catalogFactsOf`, the catalog service, the
   `upsertBudget` use case with the `waitUntil` write, tRPC `budgets.list`, the nav item, and
   the list page. Check: an API test shows an upsert writes one row, a replay writes nothing,
   and an older version is ignored. `pnpm --filter api test:workers:bench` shows the hot-verb
   row counts unchanged (authorize 5, record 4, settle 4) and authorize p50 within noise. The
   list page is checked in a browser on a seeded project.
2. **Inspect and the detail page.** `BudgetDO.inspect`, the internal inspect route, the gateway,
   read-repair, tRPC `budgets.inspect` and `budgets.openByKey`, the detail page, and the debug
   sheet. Check: workers tests show the money line equal to `held` when every open row is listed
   and lower on a 5,000-row object, `find` returns a settled hold, `probe` matches a real
   authorize's 402 `blocked`, and `inspect` on an unknown key creates no storage. The bench
   measures `inspect` p99 at 1,000,000 rows.
3. **Release and audit.** `budget_audit`, the internal release route, `releaseHoldAsOperator`,
   and the dialog. Check: a use-case test covers `requested` then `applied`, a retry that reuses
   the row, `HOLD_CLOSED` stored as `rejected`, and a MEMBER who gets `FORBIDDEN`.
4. **Hygiene (deferred).** A daily prune of catalog rows past `closes_at` + 8 days, one day
   after the object deletes itself. Deferred on 2026-10-20: closed rows stay until their volume
   calls for it. The list already hides them. Check: the prune removes only those rows.
5. **Runs as budgets, then parents.** These follow ADR-0006 step 6 and B6. Check: the old
   surface is deleted and its routes redirect.

## Designs considered

| Design | What it bought | Why it lost |
| --- | --- | --- |
| **Catalog on upsert, live inspect** (chosen base) | No change to the object's hot code. Fewest new parts. No filter that can go stale. | It cannot filter on "near limit" or "has open holds", and it cannot explain past denials. |
| **Each object publishes its own state** from its alarm through a queue into Postgres | Filters on live state, at most 30 s behind while active. | Every idle budget wakes at least every 15 minutes, forever. Today an idle budget has no alarm. It adds a queue, a consumer, KV publication state, and a snapshot build on a busy budget's alarm. |
| **Evidence stream** of every verb call from the route Worker into Tinybird | The only design that explains a past denial. | It adds work to every hot verb's route. It costs about $16 to $311 a month per hot budget in queue operations. It copies idempotency keys into Tinybird. A lost settle event shows a hold that does not exist, which is a false statement about money. |

What came from the losing designs: the "closed in the last hour" range scans and the paged
**Scan further** from the publishing design, with a `(due_at, id)` cursor so equal `due_at`
values are not skipped. Main-key-only operator routes also came from the publishing design. The
`explainDenial` sentence came from the evidence stream, applied to the live probe and not to a
stream.

## Open decisions

- **Live-state filters.** The list cannot filter on "near limit" or "has locked funds". The
  recommendation is to add them later from the ADR-0006 B7.6 outbox: its limit-crossed events
  can set a `last_crossed_at` column with an honest timestamp. Adding them now needs either the
  publishing design's heartbeat or the stream.
- **Past denials.** A denial writes nothing, and Axiom keeps about 1% of 402 responses. The
  detail page explains a denial in the present tense only. Explaining past denials needs the
  same outbox, or a decision to keep budget 402 events unsampled in Axiom.
- **A public `inspect`.** A 402 tells the caller `remedy: release_holds`, but a customer cannot
  list their holds today. The internal route could become public later. It stays internal now.
