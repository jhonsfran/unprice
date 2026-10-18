# ADR-0006: The Budget Primitive

## Status

Accepted

Amended on 2026-10-17. An estimate is a maximum authorization, not an expected cost.
Hard limits cannot accept excess consumption. An unresolved hold is settled at its full amount
when it expires, never released. This amendment replaces the earlier overrun and timeout
reclamation rules.

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

The lifecycle follows these patterns, but automatic timeout reclamation and overcapture do not
apply to hard budgets. A timer cannot prove that external work stopped or consumed nothing.

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
  closesAt   epoch ms?                                       // one-time end: no new spend after it
  pricing    none | rows (inline) | rateCard { id }            // ADR-0005 rows; one pure rate()
  funding    none | grant | wallet | creditLine { limit } | parent { key } | webhook { url }
  refill     { target?, lowWater?, maxOutstanding? }           // adaptive by default
  holds      { defaultTtl: "15m", maxTtl: "24h" }
  onUnavailable  deny                                       // no permission without authorization
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
- An upsert replaces the whole definition: an omitted field takes its default. Whoever spends
  under a cap must not be able to lift it, so a runtime key may create a budget, resend it, or
  tighten it, and only a config key may loosen it: remove, raise, or soften a hard limit, or clear
  or postpone `closesAt`. A runtime key's loosening upsert returns 403 and changes nothing. Soft
  limits and hold TTLs never deny, so either key may change them.
- Adding or lowering a hard limit, including a change from soft to hard, must preserve
  `consumed + held <= amount`. Otherwise upsert returns 409 `LIMIT_BELOW_USAGE` and keeps the
  previous configuration. A hard limit that recorded usage already passed may keep or raise its
  amount, so the rest of the configuration stays editable.
- A window is a UTC calendar window (`hour`, `day`, `week` from Monday, `month`, `never`) or an
  anchored one: `window: "month", anchor: Date.parse("2026-10-15T00:00:00Z")` repeats every month from the
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
- A limit's id fixes its window id. An upsert may change a limit's `amount` and `enforce`, so a
  plan upgrade raises the cap and keeps the period's usage, but moving an id to another window or
  anchor returns 409 `LIMIT_WINDOW_IMMUTABLE`. A move would restart an anchored count at zero and
  hand out a fresh period without anyone seeing it; a new window takes a new id, which shows the
  reset as `limit.added`.
- `closesAt` is the one-time end of a budget, such as a trial or a campaign. An upsert may set,
  move, or clear it, and the change is audited like any other. From `closesAt` on, `authorize` and
  `charge` return 409 `BUDGET_CLOSED` with `closedAt`. `settle` and `release` of holds placed
  before the close keep working, and `record` is accepted for one more retention period (24
  hours) so usage that ran before the close can still arrive. Nothing is deleted at close: the
  balance, the counters, and the window history stay readable, and every snapshot reports
  `closesAt` and `closed`. Thirty days after `closesAt`, once no row is left to settle, purge, or
  replay, the budget deletes its storage: the key then answers like one never upserted, and an
  upsert creates it anew at version 1. A budget without `closesAt` is kept until it is deleted
  explicitly, so a per-run budget should set one.

### B2. Five verbs; consumption happens at settle, charge, or record

```text
authorize { key, estimate: { amount } | { usage }, ttl?, idempotencyKey }
          -> { holdId, allowed, remaining, blockedBy?, final? }
settle    { key, holdId, actual: { amount } | { usage } }                  // closes the hold
release   { key, holdId }                                                 // nothing consumed
charge    { key, amount | usage, idempotencyKey }   // gated one-shot: denied if it does not fit
record    { key, amount | usage, idempotencyKey, occurredAt }   // deduplicated debit; always counts
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
  A hold's row is kept for 24 hours after it closes. After that the hold is retired, and
  settle and release return 409 `HOLD_RETIRED` (B3).
- `authorize` holds the maximum permitted amount against every limit on the key. The caller must
  bound the underlying operation to this amount before work starts. If `usage` is passed, the budget's
  pricing turns it into an amount first; a usage without a price row is denied (`NOT_PRICED`), never
  priced at zero.
- `settle` is final in the first release: it consumes the actual amount and releases the rest of the
  hold in one transaction, exactly once. Long work uses several holds. (A non-final settle, the
  telecom CCR-Update, is a later addition with a cumulative-total contract.)
- When the actual amount exceeds the hold, settle returns 409 `HOLD_AMOUNT_EXCEEDED`. The hold
  and balance stay unchanged.
  The server never clamps usage or accepts debt. More work requires another authorization before
  that work starts. Settlement is final, so the caller must stop the operation before releasing
  its unused reservation.
- `charge` is for cheap work that is gated before it runs. It rejects a debit that would exceed a
  hard limit, including outstanding reservations. `record` is for usage that already happened. It
  always counts, even past a hard limit, because refusing it would lose the count, not the spend.
  `crossed` names each limit it passes, the limit then denies `authorize` and `charge` until it
  resets or rises, and open holds keep their reservation. A hard cap therefore bounds what the
  budget gates; a report after work cannot grant permission retroactively. Use authorization
  before work when the operation needs a spending guarantee. `record` carries `occurredAt`, the
  epoch milliseconds the usage happened; the window rules are in B3.
- When a counter's period ends, the next accepted command (or alarm sweep) rolls it and, if the
  period had usage and a limit used that window when it ended, writes a `{ windowId, start, end,
  consumed }` period to the window history. A counter keeps its period's start, so the period is
  the same however late the next command comes, and nothing wakes at a boundary. An idle gap of
  many periods writes one, for the last period with usage. `get` returns the last 12 per window
  that has a limit, newest first, and the store keeps no more than that.
- Equivalent anchored schedules share one counter. Identity uses UTC time of day for daily
  schedules, position within the week for weekly schedules, and day plus time for monthly
  schedules. Monthly days 30 and 31 remain distinct. Anchored and calendar counters also remain
  distinct because they can have different tracking start times.
- Keep at most 32 retained anchored schedules, in addition to the five calendar counters. Removing
  a limit retains its counter until the period ends. A configuration that adds a distinct schedule
  beyond the bound returns 409 `WINDOW_CAPACITY_EXCEEDED`; it never deletes live usage to fit.
- A limit reports `crossed` when actual consumption moves from at most its amount to above it: a
  soft limit through any consumption, a hard limit only after recorded usage took its room. A
  reservation or its release does not trigger a consumption crossing. Replays preserve the
  original crossing result.
- Every response carries `remaining` for each limit, and the HTTP adapter copies it into response
  headers. A denial is always HTTP 402 with `blockedBy` (the limit or the funding source) and a
  remedy.

### B3. An unresolved hold settles at its full amount when it expires

- Every hold has a TTL (default 15 minutes, maximum 24 hours). Expiry tells the caller that work
  must stop. A timer cannot prove the work stopped, so expiry never returns capacity: the alarm
  settles a hold still open at its `expiresAt` at its full amount. The cap holds, because the
  hold counted that amount already, and the capacity returns when the window rolls instead of
  never. One crashed worker therefore costs at most its estimate for one period.
- A settlement of an open hold after `expiresAt` but before the alarm settles it is accepted
  within its reserved maximum. It counts against the window it arrives in. The reservation still
  counts in that window, so settlement replaces reserved capacity with consumption without
  increasing the total commitment. Once the alarm settled it, a settle of the full amount replays
  and any other settle or release returns 409 `HOLD_CLOSED` with status `expired`.
- Release asserts that no usage occurred and the operation cannot continue. A timeout or callback
  exception does not establish either fact. Settle known final partial usage instead.
- A closed hold's retention ends 24 hours after settlement or release, by the budget's
  clock and however late the alarm purges the row. After that the row is retired, and a retired
  row cannot tell a first settle from a retry of one that committed.
  Accepting it would count a retried settle twice, so the hold is retired: settle and release
  return 409 `HOLD_RETIRED`. A failed settlement of an unresolved hold can still be retried with
  its hold id until it expires, because open holds do not enter retention.
- Holds and settles carry the authorization timestamp. Prices are resolved at that timestamp
  (ADR-0005), so a price change between authorize and settle never changes what one call costs.
- `record` accepts usage whose `occurredAt` is within the last 7 days and at most 5 minutes
  ahead. Older usage returns 409 `TOO_LATE`; a future time returns 400 `INVALID_OCCURRED_AT`.
  `occurredAt` only bounds acceptance: the amount counts against the window it arrives in, like a
  late settle.
- A record's row is kept 8 days, longer than the 7-day accept window plus the skew. For those 8
  days the same key and amount replay with the original response, and another amount, or another
  verb, under the same key is a 409 conflict. After them, a replay is already too late.
  `occurredAt` is not part of what a retry must repeat: a retry is the same event even if the
  caller stamps it again. It must still be the event's own time, because the 7-day `TOO_LATE`
  bound is what stops a retry once its row is gone; the SDK requires it and never defaults it to
  the time of the call.

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
- Every grant is a lease with an epoch. The child stops spending at expiry. The parent keeps
  unreported capacity reserved until final usage is known; elapsed time cannot return it.
  A final report consumes at most the grant and releases its unused remainder.
- Limits stack: the child's own limits apply, and its capacity can never exceed what the parent
  granted. A denial names which layer blocked.
- Near the parent's limit, chunks shrink, and the last capacity is served pass-through.
- Parent and child must have the same unit.

### B7. Durable Object rules

1. Check and debit in one synchronous block. An `await` on another Durable Object or on Postgres
   lets other requests interleave, so no check survives an `await`.
2. Persist intent before any remote call; use deterministic ids; a replay returns the same answer.
3. Idempotency is the key plus the request it was first used with: the verb, the amount, and an
   authorize's requested TTL, compared field by field. The same key with a different request
   returns 409.
4. Alarms purge terminal receipts in bounded batches and re-arm for the next due row. A sweep
   failure schedules a retry. A failure to schedule the next alarm propagates so the platform
   can retry it.
5. Every transition asserts `funded = available + held + consumed + grantedToChildren`.
6. Webhook events leave through an outbox table written in the same transaction as the change.
7. The ledger row is the balance, and the operation rows are the only other state: each verb
   returns the rows it writes and its held and consumed deltas, and nothing keeps a journal to
   rebuild state from. Each transition checks every row step against the hold lifecycle (open to
   settled or released), the reserved maximum, and the ledger deltas. Time alone never returns
   a reservation: expiry turns it into consumption.
8. Window history is written in the same transaction as the roll: a period inserts a
   `budget_window_history` row and deletes that window's periods beyond the 12 `get` returns. A
   roll happens only inside an accepted command or the alarm's sweep, so a denial still writes
   nothing. Each transition checks per counter that a counter that kept its period grew by what
   the rows consumed, and one that rolled reported its old period when it had usage on a limited
   window.
9. The alarm wakes for an open hold's `expiresAt` and for a terminal row whose retention ended.
   A budget with neither sleeps until a command writes one, and window boundaries need no wake
   (B2). The sweep first moves the budget's clock to now and settles expired holds, then purges in
   bounded batches: a command clamps its clock to the budget's, so a purge never runs ahead of a
   later command's clock and a replay cannot count twice.
10. A Durable Object gets its storage on its budget's first upsert. Any other verb on a key that
    was never upserted answers `BUDGET_NOT_FOUND` without writing. A closed budget's alarm wakes
    30 days after `closesAt` and deletes the storage and the alarm once no row is due, so no
    object stays billed forever.
11. An operation row stores its payload without `kind` and `id`, which have their own columns.
    Exact key lookup uses the payload's idempotency key through an expression index, and one due
    index orders every row by when the alarm must next visit it: an open hold's expiry, or a
    closed row's end of retention.
12. One sweep settles at most 256 expired holds and cleanup removes at most 2,048 terminal rows
    per alarm, with a one-second continuation while more are due. Retiring an anchored counter
    deletes its window history in the same transaction.

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

The surface separates definition from use. In this example, `runBoundedOperation` is application
code that enforces its `maximumCost` and stops before returning final usage.

```ts
const unprice = new Unprice({ token: process.env.UNPRICE_TOKEN! })

// Define: idempotent upsert, from a deploy script or `unprice.config.ts` + CLI push
await unprice.budgets.upsert({ key: "customer:acme", unit: "USD", limits: [{ amount: 50, window: "month" }] })

// Use: a handle is local and cheap; it never creates or changes a budget
const acme = unprice.budget("customer:acme")
const hold = await acme.authorize({ amount: 0.05, idempotencyKey: request.id })
await hold.settle({ amount: 0.031 })                    // or hold.release()

// The provider operation must enforce the authorized maximum.
const text = await acme.spend({ estimate: 0.05, idempotencyKey: operationId }, async (hold) => {
  const r = await runBoundedOperation({ maximumCost: hold.amount })
  return { value: r.text, actual: costOf(r.usage) }
})
```

- `spend` throws `BudgetExceededError { blockedBy, remaining, remedy }`; `authorize` returns
  `allowed: false` instead.
- An unavailable authorization denies work. A per-request fail-open allowance cannot preserve a
  shared hard cap under concurrent requests.
- Manual `authorize` and `charge` require a caller-owned idempotency key. The caller keeps that
  key before sending and reuses it after an uncertain response.
- `spend` keeps one stable idempotency key. Replayed authorization does not run the callback again.
  A callback failure retains the hold and returns recovery access. A settlement failure preserves
  the callback result, actual amount, hold, and key. Neither failure releases capacity.
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
- **Overshoot**: none. Every call stays within its authorized maximum, and every process spends inside its own
  pre-debited lease. The price is stranded capacity: at most the sum of unused leases.
- **A crash loses the buffer, not the cap.** At lease expiry the unreported remainder stays counted
  against capacity until final reconciliation. A timer or window reset cannot prove that the
  capacity is unused. This future lease mode must preserve the same rule as unresolved holds.
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
await unprice.budgets.upsert({ key: "customer:acme", unit: "USD", closesAt: Date.parse("2026-11-14T00:00:00Z"),
  limits: [{ amount: 50, window: "month", anchor: Date.parse("2026-10-15T00:00:00Z") }] })
const { budget, history } = await unprice.budgets.get({ key: "customer:acme" })   // history: ended cycles
const acme = unprice.budget("customer:acme")
const answer = await acme.spend({ estimate: 0.05, idempotencyKey: operationId }, async (hold) => {
  const r = await runBoundedOperation({ maximumCost: hold.amount })
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
const { allowed } = await unprice.budget(`user:${userId}`).charge({ amount: 1, idempotencyKey: request.id })

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

// Event ingestion always counts the debit; `crossed` names any limit it passed.
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
- Unresolved holds retain storage and capacity until the caller confirms a final result. This
  cost is required to protect the cap without guessing the usage after a timeout.
- No volume pricing; builders who want it get graduated tiers.
- Latency numbers in B10 are estimates or third-party figures until the Worker → Durable Object hop
  and the hibernated wake are measured.
- Rewriting the funding loop touches the wallet code that `EntitlementWindowDO` depends on today.

## Guardrails

- Never expose a Durable Object id, a parent, or a funding source in the public API. The key is the
  address.
- Never price a usage without a row at zero. Deny it.
- Never accept actual usage above the authorized maximum. Never refuse a `record` over a hard
  limit: count it, report the crossing, and deny the next gated spend.
- Never return an unresolved reservation because a timeout passed.
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
