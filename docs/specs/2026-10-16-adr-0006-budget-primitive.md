# ADR-0006: The Budget Primitive

## Status

Accepted

## Date

2026-10-16

## Context

Unprice wants one primitive that a builder can adopt without the rest of the billing product: a
**budget** on any key they own (a customer, an API key, an agent, a run), in any numeric unit, that
holds capacity before work and records what the work cost. Unprice's own entitlements, wallets, and
runs should become users of the same primitive.

This ADR takes the runtime part of [ADR-0005](./2026-10-14-adr-0005-rate-cards-and-budget-runtime.md)
(its D4) and the budget sections of the
[Budget problem space](./2026-10-13-budget-primitive-problem-space.md) and replaces them. Pricing
rules (rate cards, pricing at write time, the model catalog) stay in ADR-0005.

### What the market does (research on 2026-10-16)

| Who | Hold before work | Hierarchy | Funding | Enforcement |
| --- | --- | --- | --- | --- |
| Orb, Metronome, Lago, Stripe credits | No | Customer, grants | Threshold webhooks, auto top-up | Alerts only; gating is the caller's job |
| LiteLLM | Yes: reserves the max-token estimate, then true-up (default) | Team, member, key, customer, session | None | Hard; fails open without a database |
| OpenRouter | Implicit in-flight cap | Workspace, guardrail, member, key; all stack | Prepaid credits | Hard; error names the blocking layer |
| Autumn | Yes: `check` with `lock`, then `finalize` | Customer, feature | None | Hard at zero unless overage is priced |
| Stripe Issuing, Marqeta JIT | Yes: card authorization | Cardholder, card | Synchronous webhook, 2 s / 3 s deadline, stand-in default | Hard |
| OpenAI, Anthropic | No | Org, project or workspace | Auto-reload | Hard-ish, overshoots |

No billing platform enforces in real time; gateways and card networks do. That gap is the reason
for this primitive. Loved patterns: stacked limits where every layer applies, an error that names the
blocking layer and a remedy, several windows at once, remaining capacity in response headers.
Complaints: limits that silently changed from hard to soft (OpenAI), status codes that differ by
layer (LiteLLM), budgets that cannot be edited (Portkey).

### Established patterns this design copies

- **Telecom online charging** (RFC 4006, 3GPP TS 32.299) is the closest match. A session reserves
  units (CCR-Initial), reports usage and gets more (CCR-Update), and closes (CCR-Terminate, unused
  units refunded). Grants carry a Validity-Time; the server reclaims after a timer of about twice
  that. The client re-authorizes below a quota threshold while service continues. A
  Final-Unit-Indication marks the last grant. A credit pool lets several services with different
  prices share one money balance. A known price change splits a grant in two (Tariff-Time-Change).
  The default when the server is unreachable is to stop service.
- **Card networks**: authorize, partial capture releases the rest, multicapture, bounded
  overcapture, expiry voids the hold. Funding callbacks have a hard deadline and a configured
  default.
- **Ledgers** (TigerBeetle, Modern Treasury): a hold is a pending transfer, so the books balance at
  every step. Posting less than the pending amount restores the remainder; a timeout voids it.
- **Escrow and demarcation** (O'Neil 1986; Barbará and Garcia-Molina 1992; bounded counters,
  Balegas et al. 2015): a global cap is split into local slices. A site spends alone inside its
  slice, the grantor debits before it grants, and a site never raises its own limit. This is the
  proof that parent and child budgets cannot overspend.
- **Leases** (Gray and Cheriton 1989; Google Doorman): every grant expires; usage reported late is
  still real.

### What exists in the code (read on 2026-10-15 and 2026-10-16)

- `EntitlementWindowDO` already implements the funding loop this ADR generalizes: a lazily created
  wallet reservation, adaptive sizing (an EWMA of spend, a target, a low-water mark, a $30 cap;
  `internal/services/src/wallet/reservation-sizing.ts`), intents persisted before each wallet call,
  and `capture:{reservationId}:{flushSeq}` / `extend:{reservationId}:{flushSeq}` keys.
- `RunBudgetDO` reserves the whole run budget once and never refills.
- There is no auto top-up (`AutoTopUpPolicy` is an unused type) and no outbound webhook system.
- Defects the generalized version must not carry over:
  1. Run close releases the money of abandoned captures.
  2. A retried run start can leave an orphaned second wallet hold (`Date.now()` in the dedupe key).
  3. The extend payload hash includes `effectiveAt`, so a replay of a committed extend conflicts and
     the sequence sticks.
  4. The 30-second alarm flush can reuse a pending sequence with a larger amount.
  5. Alarms rethrow, or delete themselves and wait for an operator (`recoveryRequired` is terminal).
  6. A wallet outage looks exactly like an empty wallet.
  7. Unfunded run usage is never recorded as debt.
  8. Idempotency is key-only: a changed payload under a used key is silently accepted.
  9. A volume-tier price decrease is clamped once the earlier amount is flushed (B4 removes volume
     pricing).

## Decision

### B1. A budget is a self-contained counter on one key

```text
Budget
  key        string the builder owns: "customer:acme", "run:r_9", "acme/images"
  unit       money:<ISO currency> | credits:<creditId> | units:<featureSlug>
  limits     [{ amount, window: hour|day|week|month|never, anchor?, feature?, unit?, enforce: hard|soft }]
  closesAt   instant?                                        // one-time end: no new spend after it
  pricing    none | rows (inline) | rateCard { id }            // ADR-0005 rows; one pure rate()
  funding    none | grant | wallet | creditLine { limit } | parent { key } | webhook { url }
  refill     { target?, lowWater?, maxOutstanding? }           // adaptive by default
  overrun    { tolerance: 0 }                                  // above it, usage is recorded as debt
  holds      { defaultTtl: "15m", maxTtl: "24h" }
  onUnavailable  deny | allow | { allowUpTo }                  // default deny; SDK-side, overridable per call
  events     [threshold, exhausted, hold.expired, funding.requested, funding.failed] -> webhook
```

- `parent: "<key>"` is shorthand for `funding: { parent: { key } }`; a child inherits the parent's
  unit. A child without its own limits is bounded only by its parent.
- One Durable Object per budget key, created explicitly. No implicit budgets.
- The key is the whole public address. A caller never sees a Durable Object id, a parent, or a
  funding source.
- Amounts are integers at a fixed scale of 8 in the budget's unit. A budget never converts units:
  no FX, no money-to-credits conversion at runtime.
- `limits` may contain several windows at once ("$10 a day and $100 a month"). A limit with a
  `feature` and a `units:` unit is a sub-limit inside the same budget ("50 images a day" inside a
  credits budget). Every applicable limit is checked; the tightest wins; the response names it.
- Changing `enforce` between hard and soft writes an audit entry and emits an event. It is never
  changed by Unprice.
- A window is a UTC calendar window (`hour`, `day`, `week` from Monday, `month`, `never`) or an
  anchored one: `window: "month", anchor: "2026-10-15T00:00:00Z"` repeats every month from the
  anchor, forward and backward. A monthly anchor keeps its day of month and time of day; in a month
  too short for it, the period starts on the last day (an anchor on the 31st starts Feb 28 or 29
  and Apr 30). Weekly anchors keep weekday and time; daily anchors keep time of day. Anchors fit
  billing cycles that start on the signup date.
- Usage is counted per window id, not per limit. A calendar window's id is its name; an anchored
  window's id is `<window>@<anchor ISO>`, such as `month@2026-10-15T00:00:00.000Z`. The budget
  always keeps the five calendar counters, plus one counter per anchored id a limit uses. Every
  consumption adds to every counter, and counters only roll forward under the clamped clock.
  Renaming a limit, or removing and re-adding it inside one period, never resets its usage: a
  counter no limit uses is kept until its period ends and then dropped. A new anchored window
  counts from the moment it is added; it cannot backfill usage from earlier in its period.
- `closesAt` is the one-time end of a budget, such as a trial or a campaign. An upsert may set,
  move, or clear it, and the change is audited like any other. From `closesAt` on, `authorize` and
  `charge` return 409 `BUDGET_CLOSED` with `closedAt`. `settle` and `release` of holds placed
  before the close keep working, and `record` is accepted for one more retention period (24
  hours) so usage that ran before the close can still arrive. Nothing is deleted at close: the
  balance, the counters, and the window history stay readable, and every snapshot reports
  `closesAt` and `closed`.

### B2. Five verbs; consumption happens at settle, charge, or record

```text
authorize { key, estimate: { amount } | { usage }, ttl?, idempotencyKey }
          -> { holdId, allowed, remaining, blockedBy?, final? }
settle    { key, holdId, actual: { amount } | { usage } }                  // closes the hold
release   { key, holdId }                                                 // nothing consumed
charge    { key, amount | usage, idempotencyKey }   // gated one-shot: denied if it does not fit
record    { key, amount | usage, idempotencyKey, occurredAt }   // already happened: never denied
get       { key } -> { budget, history }            // history: last 12 ended periods per window
```

The lifecycle of one call:

```text
authorize(est 80)   available 100 -> 20   held 0 -> 80
  ... work runs ...
settle(actual 55)   held 80 -> 0          consumed 0 -> 55   available 20 -> 45
```

- The hold id is the idempotency key for `settle` and `release`. Settling again with the same
  amount replays the first result; a different amount, or a release after a settle, returns 409.
  A hold's row is kept for 24 hours after it closes or lapses. After that the hold is retired, and
  settle and release return 409 `HOLD_RETIRED` (B3).
- `authorize` holds the estimate against every limit on the key. If `usage` is passed, the budget's
  pricing turns it into an amount first; a usage without a price row is denied (`NOT_PRICED`), never
  priced at zero.
- `settle` is final in the first release: it consumes the actual amount and releases the rest of the
  hold in one transaction, exactly once. Long work uses several holds. (A non-final settle, the
  telecom CCR-Update, is a later addition with a cumulative-total contract.)
- An actual above the hold consumes the excess from available capacity up to `overrun.tolerance`.
  Anything beyond that is still consumed and recorded as debt; remaining can go negative, and a
  negative remaining denies every new hold until funding catches up.
- `charge` is for cheap work that is gated before it runs. `record` is for usage that already
  happened (event ingestion, provider callbacks). `record` is never denied by a limit, because
  denying it cannot undo the work. It carries `occurredAt`, the epoch milliseconds the usage
  happened, like the event API's `timestamp`; the window rules are in B3.
- When a counter's period ends, the next accepted command (or alarm sweep) writes a
  `window.rolled { windowId, start, end, consumed }` fact for the period that ended, only when it
  had usage. A counter keeps its period's start, so the fact is the same however late the next
  command comes, and nothing wakes at a boundary. An idle gap of many periods writes one fact, for
  the last period with usage. `get` returns the last 12 of these per window that has a limit,
  newest first, and the store keeps no more than that.
- Every response carries `remaining` for each limit, and the HTTP adapter copies it into response
  headers. A denial is always HTTP 402 with `blockedBy` (the limit or the funding source) and a
  remedy.

### B3. Holds expire; late usage is accepted within retention

- Every hold has a TTL (default 15 minutes, maximum 24 hours). At TTL the alarm marks it `expired`
  and keeps it counted. After a grace of twice the TTL it releases the remainder (the telecom Tcc
  rule).
- A settle that arrives after expiry, or after the hold lapsed, is accepted and consumes, even if it
  pushes remaining below zero. It counts against the window it arrives in, not the window the work
  ran in: an amount is priced and attributed when it is written.
- This holds until the hold's retention ends, 24 hours after it closes or lapses. After that the
  row is purged, and a purged row cannot tell a first settle from a retry of one that committed.
  Accepting it would count a retried settle twice, so the hold is retired: settle and release
  return 409 `HOLD_RETIRED`. Retention is the setting for how late is too late. A caller that knows
  its settle never committed reports that usage with `record` and its own idempotency key.
- Holds and settles carry the authorization timestamp. Prices are resolved at that timestamp
  (ADR-0005), so a price change between authorize and settle never changes what one call costs.
- `record` accepts usage whose `occurredAt` is within the last 7 days and at most 5 minutes
  ahead. Older usage returns 409 `TOO_LATE`; a future time returns 400 `INVALID_OCCURRED_AT`.
  `occurredAt` only bounds acceptance: the amount counts against the window it arrives in, like a
  late settle.
- A record leaves a receipt that outlives its row: its key hash, request hash, amount, and
  crossings, kept 8 days, longer than the 7-day accept window plus the skew. For those 8 days the
  receipt answers exactly as the row did: the same key and amount replay with the original
  response, and another amount under the same key is a 409 conflict. After them, a replay is
  already too late. `occurredAt` is not part of the request hash: a retry is the same event even
  if the caller stamps it again. It must still be the event's own time, because the 7-day
  `TOO_LATE` bound is what stops a retry once its receipt is gone; the SDK requires it and never
  defaults it to the time of the call.

### B4. Pricing inside a budget, including credits

A budget prices with the ADR-0005 `rate()` function over rate rows, either inline or from a rate
card. Pricing is optional: a budget in `units:` with no pricing is a plain counter.

- **One feature, several quantities, one budget.** A rate row prices an event with one or more
  components, each reading one event property:

  ```text
  row { feature: "model_call", match: { model: "gpt-4.1" },
        components: [ { property: "input_tokens",  rate: "0.002", per: 1000 },
                      { property: "output_tokens", rate: "0.008", per: 1000 },
                      { property: null,            rate: "1" } ] }      // per call
  ```

  The event keeps today's envelope (`eventSlug`, `properties`). No feature is split into several
  meters or several Durable Objects. This is how a credits product works: every feature and model
  is priced in the budget's credit unit, and one credits budget holds the balance (the telecom
  credit pool with unit-value multipliers).
- **Supported models:** flat per unit, graduated tiers, package. All three are non-decreasing
  functions of the period total, so a charge is `price(totalAfter) - price(totalBefore)` and one big event costs the
  same as the same usage split into many.
- **Volume tiers are not supported.** A volume tier reprices every unit in the window once a
  threshold is crossed, so an event can have a negative price ($1 per unit up to 100 and $0.50 from
  101: unit 101 moves the total from $100 to $50.50, a delta of -$49.50). That breaks monotonic
  consumption, makes a hold's upper bound depend on the ladder's shape, and needs credits against
  amounts already captured. `EntitlementWindowDO` clamps such deltas once the amount is flushed
  (`computeEffectiveWalletCost`), so customers pay the pre-discount price. Volume pricing is removed
  from the product, with no backward compatibility; volume discounts are expressed as graduated
  tiers.
- Tiered pricing that depends on a period total must live on the budget that receives all usage of
  that feature. A child budget prices only with flat rates or passes amounts.

### B5. Funding is one protocol behind every source

A budget spends locally inside capacity it already holds. Funding sources give it capacity in
chunks:

```text
child persists intent { seq, capture, extend }            // before any remote call
source.capture(key = "cap:{budget}:{seq}", amount)         // what was consumed since the last seq
source.extend (key = "ext:{budget}:{seq}", amount) -> granted, final?   // may be partial
child commits allocation, flushed, seq; clears intent      // a crash replays the same seq
close: final capture, then source.release(key = "rel:{budget}:{epoch}")
```

| Source | Capacity comes from | Capture posts to |
| --- | --- | --- |
| `none` | the limit itself (a cap with no money behind it) | nothing |
| `grant` | a fixed amount per window (plan allowance, trial, promotion) | the grant |
| `wallet` | the customer's prepaid balance (ADR-0003) | wallet capture |
| `creditLine` | a postpaid limit, or uncapped | customer receivable (invoiced) |
| `parent` | another budget with the same unit, through the same protocol | the parent's consumed |
| `webhook` | the builder's own system (just-in-time funding) | the builder's ledger |

- Payloads are frozen when the intent is persisted: no timestamps in the idempotency hash.
- Refills are adaptive (the `EntitlementWindowDO` EWMA sizing), start in the background below the
  low-water mark, and only one is in flight. A synchronous refill happens only when the local
  balance cannot cover the request.
- "Funding unreachable" and "funding empty" are different outcomes, with different denial reasons.
- Funding is default-deny. Spending beyond confirmed funds exists only as an explicit `creditLine`.
- Auto top-up is a policy on a `wallet` source: below a threshold, charge the payment method up to a
  target; a cap per period; one top-up in flight; disabled after three consecutive failures, with an
  event.
- A `webhook` source is called asynchronously when the balance falls below the low-water mark, with
  signed requests (Standard Webhooks), the `seq` key, and a 2-second deadline. A timeout denies. A
  late approval is still applied. It is never on the request path unless the local balance is
  exhausted.

### B6. A parent is just a funding source

- A child budget with `funding: { parent: { key } }` reserves chunks from the parent through B5. The
  parent debits its own available capacity before it grants (demarcation). A child never raises its
  own limit.
- Every grant is a lease with an epoch. The child stops spending at expiry; the parent reclaims the
  unreported remainder after twice the TTL; a late report is applied as consumption, never dropped.
- Limits stack: the child's own limits apply, and its capacity can never exceed what the parent
  granted. A denial names which layer blocked.
- Near the parent's limit, chunks shrink, and the last capacity is served pass-through.
- Parent and child must have the same unit.

### B7. Durable Object rules

1. Check and debit in one synchronous block. An `await` on another Durable Object or on Postgres
   lets other requests interleave, so no check survives an `await`.
2. Persist intent before any remote call; use deterministic ids; a replay returns the same answer.
3. Idempotency is the key plus a payload hash. The same key with a different payload returns 409.
4. Alarms are sweepers: they scan for due work, catch every error, and always re-arm. They never
   throw and never delete themselves.
5. Every transition asserts `funded = available + held + consumed + grantedToChildren`.
6. Webhook events leave through an outbox table written in the same transaction as the change.
7. The ledger row is the balance. Journal entries are an audit trail that the alarm prunes after
   24 hours; nothing replays them to rebuild state.
8. Window history and record receipts are projections of facts written in the same transaction:
   `window.rolled` inserts a `budget_window_history` row and deletes that window's periods beyond
   the 12 `get` returns, and `recorded` inserts its receipt into `budget_record_receipts`. A roll
   happens only inside an accepted command or the alarm's sweep, so a denial still writes nothing.
   Each transition checks per counter that consumed after plus what rolled out equals consumed
   before plus what it consumed.
9. The alarm wakes only for work: due holds, the journal prune, and receipts to purge; a budget
   with none keeps the 24-hour heartbeat. Window boundaries need no wake (B2). The sweep purges
   expired receipts in bounded batches, never past the ledger's clock: a command clamps its clock
   to the ledger's, and a receipt purged at a later raw clock could otherwise let a replay count
   twice.

### B8. Unprice's own billing runs on budgets

- A customer's subscription creates a customer budget (unit: the subscription currency, or a credit
  unit) funded by `wallet`, `grant`, or `creditLine`.
- An entitlement is a budget on `customer/entitlement` with the price rows of the subscription's
  rate card. In the first release it lives in the customer's Durable Object; it moves to its own
  Durable Object with `funding: parent` when one is hot. A free entitlement is a `units:` budget with
  no pricing and `funding: none`.
- Postpaid customers use `creditLine`, so every priced amount reaches the receivable account through
  B5, and the invoice is a projection of the ledger (ADR-0005 D2).

### B9. The SDK: define once, then hold a handle

What the SDK copies and avoids (Autumn and Polar read on 2026-10-16):

- Copied: one gate call that can also spend (Autumn `check` with `sendEvent`); hold then confirm
  with an actual amount (Autumn locks with `finalize` and `overrideValue`); the builder's own ids
  with no mapping table; a full balance in every response; config as code with a preview before
  apply (Autumn `atmn push`); a typed config that generates typed calls (Polar RuntimeSDK); a
  freshness flag on locally computed balances (Polar `isPristine`); drop-in model wrappers.
- Avoided: failing open by default (Autumn returns `allowed: true` on an outage, which defeats a
  cap); storing an idempotency key before the effect commits (Autumn issue #1138: a failed attempt
  blocks retries for 24 hours); metering only after the model call (Autumn's gateway and Polar's
  ingestion: one runaway call is never capped); allow decisions in the browser (Autumn deprecated its
  React checks); ingestion with no batching or retry (Polar).

The surface separates definition from use:

```ts
const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })

// Define: idempotent upsert, from a deploy script or `unprice.config.ts` + CLI push
await unprice.budgets.upsert({ key: "customer:acme", unit: "USD", limits: [{ amount: 50, window: "month" }] })

// Use: a handle is local and cheap; it never creates or changes a budget
const acme = unprice.budget("customer:acme")
const hold = await acme.authorize({ amount: 0.05 })      // { allowed, remaining, blockedBy? }
await hold.settle({ amount: 0.031 })                    // or hold.release()

// The same thing in one call: authorize, run, settle the returned actual, release on throw
const text = await acme.spend({ estimate: 0.05 }, async () => {
  const r = await generateText({ model, prompt })
  return { value: r.text, actual: costOf(r.usage) }
})
```

- `spend` throws `BudgetExceededError { blockedBy, remaining, remedy }`; `authorize` returns
  `allowed: false` instead.
- The failure policy is the builder's choice. A budget stores `onUnavailable: "deny" | "allow" |
  { allowUpTo: amount }` (default `"deny"`), and a call can override it. The SDK applies it when
  Unprice cannot be reached within the call's timeout, marks the response `degraded: true`, and
  reports any spend it allowed once the connection returns, through `record`, so nothing is lost.
- `budget.child({ key, limits, ttl })` upserts a child funded by the handle's budget (B6).
- `budget.wrap(price, fn)` returns `fn` with a charge in front, for tool `execute` functions.
- The SDK never runs in a browser.

### B10. Three latency modes, one contract

The code a builder writes is the same in every mode. The mode only changes where the check runs.

| Mode | Where the check runs | Blocking hops per check | Check latency | Cap guarantee |
| --- | --- | --- | --- | --- |
| `remote` (default) | The budget's Durable Object, over HTTPS | 1 (client → Worker → DO) | About 17 ms from a cloud region to the nearest Cloudflare location (Prisma 2024 dataset) plus the Worker → DO hop (not yet measured) | Exact |
| `socket` | The Durable Object, over an open WebSocket | 1 round trip, no TLS setup | One round trip to the edge (estimate: 5 to 25 ms) | Exact |
| `local` | Process memory, against a pre-debited lease | 0 | Microseconds (estimate) | Holds: the lease was debited before it was spent |

`local` is a child budget whose store is process memory:

- On first use the SDK opens a WebSocket to the budget's Durable Object (Hibernation API, up to
  32,768 sockets per object) and asks for a lease: a chunk of capacity the Durable Object debits
  first (B5, B6).
- `authorize`, `settle`, and `charge` run against the lease in memory. Settles are buffered and sent
  in one frame every second, every 100 entries, or on `close()`/`flush()` (Cloudflare suggests 10 to
  100 logical messages per frame; inbound socket messages are billed at 20:1).
- Below the low-water mark the SDK asks for a refill in the background. If the lease runs out before
  the refill arrives, `authorize` waits for it (one round trip) or denies.
- The Durable Object pushes snapshots (`version`, `remaining`, `coldUntil`) so the local balance
  knows what the server has already counted. Each response carries `fresh: boolean`.
- **Overshoot**: none beyond the per-call estimate error. Every process spends only inside its own
  pre-debited lease. The price is stranded capacity: at most the sum of unused leases.
- **A crash loses the buffer, not the cap.** At lease expiry the unreported remainder stays counted
  as consumed and `unreconciled`, never billed. A late report converts it; the window end releases
  it. This is stricter than B3 for holds, because a lost process cannot settle late.
- **Where it can run**: long-lived processes (Node servers, agent runners, containers). Not in
  Workers, Lambda, or Vercel functions: their memory can be dropped or frozen between invocations,
  so they use `remote`, with settles sent through `waitUntil`.

### B11. Inside an LLM loop

For a run with a local lease, the journey of one agent step:

```text
step n:  authorize(estimate)   local, microseconds       ← no network
         model call            500 ms to several s       ← the provider
         settle(actual)        local, microseconds       ← buffered
tool:    charge(price)         local, microseconds       ← no network
background (any time):  flush buffer → DO (1 frame)      refill below low water → DO → parent DO
end:     close()  → final flush, unused lease returns to the parent (1 frame)
```

With `remote`, each step adds one blocking round trip for `authorize` (about 20 to 40 ms, to be
measured) and `settle` goes out without blocking. Model calls take 0.5 to 1 s to the first token and
tool calls 1.6 to 14 s (published benchmarks), so a remote check costs a few percent per step;
`local` removes it.

## Examples

All examples use the same client: `const unprice = new Unprice({ token })`. Definitions are
idempotent upserts and usually live in a deploy script or `unprice.config.ts`.

### Outside Unprice (no plans, no invoices)

```ts
// 1. Hard cap per end customer of an AI app; the builder bills elsewhere
await unprice.budgets.upsert({ key: "customer:acme", unit: "USD", limits: [{ amount: 50, window: "month" }] })
// ... or per billing cycle from the signup date, and a trial that ends on a date
await unprice.budgets.upsert({ key: "customer:acme", unit: "USD", closesAt: "2026-11-14T00:00:00Z",
  limits: [{ amount: 50, window: "month", anchor: "2026-10-15T00:00:00Z" }] })
const { budget, history } = await unprice.budgets.get({ key: "customer:acme" })   // history: ended cycles
const acme = unprice.budget("customer:acme")
const answer = await acme.spend({ estimate: 0.05 }, async () => {
  const r = await generateText({ model: openai("gpt-4.1"), prompt })
  return { value: r.text, actual: costOf(r.usage) }
})

// 2. Cap per API key under the customer, $10 a day, funded by the customer budget
await unprice.budgets.upsert({ key: "key:k_1", parent: "customer:acme", limits: [{ amount: 10, window: "day" }] })

// 3. Agent run that stops at $2, checked locally inside the loop, with a priced tool
const run = await acme.child({ key: `run:${runId}`, limits: [{ amount: 2 }], ttl: "15m", mode: "local" })
const search = tool({
  inputSchema: z.object({ q: z.string() }),
  execute: run.wrap({ amount: 0.01 }, ({ q }) => searchApi(q)),       // $0.01 per search
})
await generateText({ model: withBudget(openai("gpt-4.1"), run), tools: { search }, stopWhen: stepCountIs(20) })
await run.close()                                                      // unused lease back to acme

// 4. Orchestrator and sub-agents: a child of the run
const sub = await run.child({ key: `run:${runId}/sub:${i}`, limits: [{ amount: 0.5 }], ttl: "5m" })

// 5. Free-tier abuse guard: a counter, no money
await unprice.budgets.upsert({ key: `user:${userId}`, unit: "units:generations", limits: [{ amount: 100, window: "day" }] })
const { allowed } = await unprice.budget(`user:${userId}`).charge({ amount: 1 })

// 6. Team LLM spend inside a company: org → team → key, every layer applies
await unprice.budgets.upsert({ key: "org:acme", unit: "USD", limits: [{ amount: 5000, window: "month" }] })
await unprice.budgets.upsert({ key: "team:search", parent: "org:acme", limits: [{ amount: 800, window: "month" }] })
await unprice.budgets.upsert({ key: "key:ci-bot", parent: "team:search", limits: [{ amount: 20, window: "day" }] })

// 7. Credits sold through the builder's own Stripe: the builder approves each chunk
await unprice.budgets.upsert({
  key: "customer:acme", unit: "credits:app",
  funding: { webhook: { url: "https://app.example.com/unprice/funding" } },   // 2 s deadline, deny on timeout
})
```

### Inside Unprice

```ts
// 8. Free plan: 1,000 API calls a month, no price
{ key: "acme/api_calls", unit: "units:api_calls", limits: [{ amount: 1000, window: "month" }] }

// 9. Pro plan: 5,000 credits a month, packs on top, every feature and model priced in credits
{
  key: "customer:acme", unit: "credits:app",
  funding: [{ grant: { amount: 5000, every: "month" } }, { wallet: {} }],          // grant first, then packs
  pricing: [
    { feature: "model_call", match: { model: "gpt-4.1" }, components: [
      { property: "input_tokens", rate: 2, per: 1000 },
      { property: "output_tokens", rate: 8, per: 1000 } ] },
    { feature: "model_call", match: { model: "claude-haiku-4-5" }, components: [
      { property: "input_tokens", rate: 1, per: 1000 },
      { property: "output_tokens", rate: 5, per: 1000 } ] },
    { feature: "image", rate: 40 },                                               // 40 credits per image
  ],
  limits: [{ feature: "image", unit: "units:image", amount: 50, window: "day" }],  // sub-limit
}
const hold = await acme.authorize({ usage: { feature: "model_call",
  properties: { model: "gpt-4.1", input_tokens: 1200, output_tokens: 1000 } } })   // max output as estimate
await hold.settle({ usage: { feature: "model_call",
  properties: { model: "gpt-4.1", input_tokens: 1200, output_tokens: 412 } } })    // consumes 5.7 credits

// 10. Postpaid with a $200 cap and an alert at 80%: priced from the rate card, accrued to the receivable
{ key: "customer:acme", unit: "USD", pricing: { rateCard: "pro-usd" }, funding: { creditLine: {} },
  limits: [{ amount: 200, window: "month", enforce: "hard" }], events: [{ threshold: 0.8 }] }

// 11. Prepaid with auto top-up: below $5, charge the card up to $50, at most $500 a month
{ key: "customer:acme", unit: "USD",
  funding: { wallet: { autoTopUp: { below: 5, to: 50, maxPerMonth: 500 } } } }

// 12. Trial: $5 that expires on day 14
{ key: "customer:acme", unit: "USD", funding: { grant: { amount: 5, expiresAt: trialEnd } } }

// Event ingestion records usage that already happened; it is never denied by a limit.
// occurredAt is the event's own time and bounds acceptance (7 days); the same key and amount
// count once within 8 days.
await unprice.budget("customer:acme").record({ usage: { feature: "image", properties: {} },
  idempotencyKey: eventId, occurredAt: event.timestamp })
```

## Prototype and iteration

| Step | Scope | Done when |
| --- | --- | --- |
| 0. Core | Pure state machine for holds and funding intents, amounts at scale 8, `authorize`/`settle`/`release`/`charge`, one `month` limit, funding `none`, conservation assertions | Property tests: conservation after every random command sequence; one event equals the same usage split; replays return the stored result |
| 1. BudgetDO and API | Durable Object around the core (SQLite: config, holds, entries, idempotency, outbox), expiry alarm, `POST /v1/budgets`, the five verbs, `GET` balance, the B9 SDK (`upsert`, `budget(key)`, `spend`) | A script caps `customer:acme` at $50, 100 parallel authorizes never exceed it, a changed payload returns 409 |
| 2. Pricing and units | Inline rows: unit, graduated, package, multi-component; `credits:` and `units:` budgets; several windows; feature sub-limits | A credits budget prices two models per token and per call in one Durable Object |
| 3. Events | Outbox, signed webhooks, threshold and exhausted events | A webhook arrives once per crossing, with retries |
| 4. Funding | B5 protocol generalized from `EntitlementWindowDO`, `grant`, `wallet`, `creditLine`, all nine defects fixed | Deterministic simulation with crashes at every `await` shows no lost or duplicated money |
| 5. Hierarchy | `parent` source, leases with epochs, `webhook` source, auto top-up | Children of one parent never exceed it under parallel load |
| 6. Unprice on budgets | Subscriptions create budgets; pricing at write time; invoices from the ledger; `EntitlementWindowDO` and `RunBudgetDO` deleted (ADR-0005) | An invoice equals the ledger accruals plus recurring fees |
| 7. Local mode | B10 `local` lease over a hibernating WebSocket, buffered settles, snapshots | 10 processes spending one budget never exceed it; killing one leaves the cap intact |
| 8. AI SDK wrapper | `withBudget(model, budget)`: `authorize { usage }` before each model call and step, `settle` on finish | A Claude and a GPT call are capped per customer and per run, in a tool loop |

Steps 0 to 3 are the first release: a budget a builder can adopt without any other part of Unprice.

## Consequences

### Positive

- One concept (budget) and one relation (funding) cover caps, credits, wallets, postpaid limits,
  runs, and API keys.
- A builder can adopt budgets without plans, features, invoices, or an Unprice customer.
- A credits product with many features and models keeps one balance in one Durable Object.
- Conservation is an invariant checked on every transition, not a property of careful code.

### Negative

- One budget key is bounded by one Durable Object's throughput (Cloudflare's planning figure is 500
  to 1,000 requests per second, unmeasured for this workload). The escape is a child budget per hot
  key; splitting one feature across Durable Objects would need tier ranges and is not designed.
- Chunks strand capacity in children; near a limit the protocol shrinks chunks and loses throughput.
- No volume pricing; builders who want it get graduated tiers.
- Latency numbers in B10 are estimates or third-party figures until the Worker → Durable Object hop
  and the hibernated wake are measured.
- Rewriting the funding loop touches the wallet code that `EntitlementWindowDO` depends on today.

## Guardrails

- Never expose a Durable Object id, a parent, or a funding source in the public API. The key is the
  address.
- Never price a usage without a row at zero. Deny it.
- Never drop usage that happened inside retention: late settles and late reports consume.
- Never accept a settle the store can no longer deduplicate. A retired hold returns 409.
- Never release capacity that a pending capture still covers.
- Never `await` between a check and the debit it guards.
- Never put a funding call on the request path while local capacity remains.
- Never change a limit between hard and soft without an audit entry.
- Never mix units in a budget or across a parent and child.

## Related Documents

- [ADR-0005: Rate cards and pricing at write time](./2026-10-14-adr-0005-rate-cards-and-budget-runtime.md)
- [ADR-0003: Wallet Reservation And Grant Lifecycle](../adr/ADR-0003-wallet-reservation-grant-lifecycle.md)
- [Budget problem space](./2026-10-13-budget-primitive-problem-space.md) (persona and market;
  sections 6 and 8 are replaced by this ADR)
- [Independent review, 2026-10-15](./2026-10-15-rate-cards-budget-review-feedback.md)
- RFC 4006, 3GPP TS 32.299 section 6.5.2, TigerBeetle two-phase transfers, Stripe Issuing real-time
  authorizations, Marqeta JIT funding, Google Doorman design, Standard Webhooks
