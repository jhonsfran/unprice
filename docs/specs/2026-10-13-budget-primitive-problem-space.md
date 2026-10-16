# Budget: problem space, persona, and definition

Date: 2026-10-13. Revised the same day with the persona research and the design answers, and on 2026-10-14 with the Polar Outpost read.
Updated 2026-10-14 by [ADR-0005](./2026-10-14-adr-0005-rate-cards-and-budget-runtime.md): pricing comes from rate cards, rating happens in the BudgetDO, the model catalog is a cost table, and the BudgetDO replaces both existing enforcement DOs (sections 3, 6.1, 6.2, 6.4, 6.5, 7, 8, 11, 13, 14).
Superseded in part on 2026-10-16 by [ADR-0006](./2026-10-16-adr-0006-budget-primitive.md): the budget object, verbs, funding, hierarchy, and Durable Object design (sections 6 and 8, including the pseudocode, which has known bugs) follow ADR-0006. The persona, market, and positioning sections still stand.
Status: proposal. The persona is evidence-based and not interview-validated. Replaces `docs/brand/jobs-to-be-done.md`.
Builds on `2026-08-24-sdk-reservation-facade-design.md`, `../plans/budgeted-runs.md`, `../plans/unprice-phase-08-financial-guardrails.md`, and `../plans/unprice-phase-09-outcome-pricing.md`.

## 1. The decision

A **Budget** is a money or credit cap on an id the builder names: a customer, an agent, a run. The builder funds it outside Unprice. One Durable Object per subject enforces it in memory. The builder calls `authorize` before paid work, `settle` after it, and `release` when the work is abandoned. A budget needs no plan, no plan version, no subscription, no payment-provider row, and no Unprice customer. Plans, entitlements, wallets, rate cards, and invoices become layers that fund, price, or export budgets. A builder adopts Unprice in steps, and the code from the first step still runs unchanged at the last.

The focus is AI products and agents. The first release is one thing: a hard cap per customer and per run, enforced before the model call, installed as AI SDK middleware (section 3). Outcomes, customer pricing, statement export, and the local lease tier are designed here so the budget supports them later. They are not in the first release.

## 2. The problem

The buyer is an engineer at a developer-led AI product that sells credits, metered model usage, or agent runs, with Stripe already in place. Their fix today is a Redis counter, a gateway cap on their own provider key, or nothing. Four facts define the problem:

1. **Everyone ships the check-then-call race.** A naive limiter over-admitted 113 to 161 requests against a cap of 500 in a published test. LiteLLM's reservation path leaked (Redis said $50, the database said $0.001). A single-integer credit balance went to -1 the day refunds started.
2. **Usage is known hours after the money is spent.** Stripe meter summaries are "eventually consistent", credits "apply to invoices only at the time of finalization", and alerts "notify". Simon Willison's "hard budget caps need to be the default" drew 651 HN points on 2026-10-03.
3. **Nobody sells reserve-then-settle against the customer's budget.** Gateways (LiteLLM, OpenRouter, Vercel, Cloudflare AI Gateway) reserve against the operator's provider bill. Billing products (Metronome, Orb, Lago) have no synchronous authorization. Stigg is closest: bring-your-own-billing, a sidecar cache, "reserve and settle" listed but undocumented, hard limits in private beta, closed source.
4. **Nobody can adopt Unprice without a billing migration.** Every entitlement needs a published plan version, a payment-provider config, and a subscription (`internal/db/src/schema/entitlements.ts` makes `featurePlanVersionId` NOT NULL). `access.check` needs an Unprice customer id. Runs need a subscription and wallet funds, expire in 24 hours, and hit Postgres on every event.

The gap is precise: a budget-authorized unit of work, keyed by the builder's own ids, enforced in memory, that later settles to any rail. Cloudflare's Monetization Gateway beta (2026-09-30) already asks sellers for "the maximum price a single request could cost". No open-source product produces that number on the seller side.

## 3. The first release

A hard cap per customer and per run, enforced before the model call, installed as AI SDK middleware, with no plan, no subscription, and no change to Stripe.

What ships:

- `budgets.create` from the dashboard or the API, keyed by the builder's customer id, with an optional child budget per run.
- `authorize`, `settle`, `release`, and the one-shot `charge`.
- `@unprice/ai-sdk` rewritten as the `unpriceBudget()` middleware. It authorizes before `doGenerate` with an estimate from the bound rate card, cuts the stream when remaining reaches zero, settles on finish with the usage vector, and releases on error.
- The model cost catalog, synced every six hours from public sources, and a catalog rate card (cost × markup), so estimates, prices, and provider cost need no configuration (ADR-0005 D3).
- Manual rate card rows for custom features, so a non-AI feature is priced the same way (ADR-0005 D1).
- `mode: shadow` first, `mode: enforce` second.
- Webhooks for `budget.threshold`, `budget.exhausted`, `authorization.expired`, and `authorization.unfunded`.
- The evidence trail. Every entry lands in the DO, in Tinybird, and in the R2 lakehouse through the reporting path that exists today.

Why this one:

- Per-run cap requests are open where the persona lives: OpenHands issue 5561 (2026-10-07) proposes "reserve each call's worst-case cost before sending it", Cursor forum requests in March and June 2026, Together "coming soon", Replicate removed account caps in July 2025.
- Gateways cap the operator's provider key, never the operator's customer.
- Seed-stage builders will not switch billing to solve one problem (Autumn's 30 founder interviews). A budget asks for no switch.
- The model call is where the money is created, and the repo already owns a middleware at that point.
- It produces the evidence trail for free, which is the only answer to a disputed-usage incident later.

Not in the first release: outcome pricing (lifecycle reserved in section 6.3), plan-funded budgets and plan rate card bindings on subscriptions (ADR-0005 step 4), statements beyond a CSV export, the Stripe meter sink, the local lease tier, and rate limits (dropped from scope).

## 4. Persona: AI products and agents

Evidence: four web research passes on 2026-10-13 plus the market pass in section 5. No Unprice customer interviews have been run. The former `jobs-to-be-done.md` assumed a "margin-responsible founding engineer at a 2 to 20 person pre-seed company" and was never validated. This section replaces it.

### 4.1 Who

An engineer at a developer-led AI product that charges its own customers for model usage, credits, or agent runs, and keeps Stripe for invoicing. At 2 to 15 people, the founder or founding engineer who wrote the credits table. At 20 to 80 people, the engineer who still owns that table, or the billing engineer they are about to hire. Paid work runs in their backend against OpenAI, Anthropic, or a gateway, usually through the Vercel AI SDK or a raw provider SDK. Customers are keyed by user id, workspace id, or API key. The expensive unit is a run, a session, or a model call.

In one DM: a two-to-six person team selling an agent (coding, research, ops, or voice) to other businesses, in TypeScript on the Vercel AI SDK or the Claude Agent SDK. They have Stripe and a `plans` table but no hard stop before the model call. They tried `max_turns`, a toast at $50, a Postgres `spend_usd` column checked after the run, and a gateway key cap that turned out to be account-wide. The moment of need is the first invoice or GitHub issue that reads "a run that loops spends until its iteration cap", weeks after the first paying customers. They key on `customerId` plus `runId`, want per-customer-per-month and per-run at the same time, and want the check to hold across parallel subagents. They pay nothing until about Series A and leave if a check adds visible latency.

### 4.2 Sub-segments

Ranked by fit with the first release. Acuteness comes from 2026 issue threads and posts, and ability to pay from funding and vendor tiering.

| Sub-segment | Sells | Subject ids | Acuteness | Pays | Middleware fit |
| --- | --- | --- | --- | --- | --- |
| Teams selling agents built on frameworks | The agent, to their own customers | Tenant id, run id, session id | High. Five 2026 issues across OpenAI Agents, LangChain deepagents, Mastra, Claude Agent SDK, and Vercel AI, all closed stale or low priority | Low to medium | Best. In process, keyed on tenant and run, covers the "second client bypasses the hook" case |
| Agent products selling per run or task | Runs, sessions, tasks, minutes | Customer id, run id, call id | High. Four repos shipped a run cap in one to three days in October 2026 (ProPR, Lore, Sweny, AgentDock); OpenHands, Devin, and Cursor requests | Low, except voice agencies and Series B products | Good in TypeScript. Python coding agents need the Claude Agent SDK hook |
| AI infra and API companies | Per-call credits behind API keys | API key, organization | Medium. Ledger rot (Firecrawl's 800-line SQL balance function), then per-key caps at Exa, Firecrawl, and Vercel AI Gateway in 2026 | High at Series A and later. Autumn has Firecrawl and Mintlify | Weak. The paid work is not a model call. The entry point is `charge` on an `api_key` subject |
| AI apps selling prepaid credits to prosumers and SMBs | Credits per message, generation, or document | User id, site id, conversation id | Medium. Double charges and refunds after the first payments | Very low. Solo to five people, under $5K MRR | Good technically, but they want a credit ledger plus Stripe |

The middleware reaches the first two rows. The paying stage in 4.3 is the third row plus the Series A and later members of the second, entering through the same budget keyed on an API key or a customer id from their own request path.

Adapter order follows adoption. Weekly npm downloads for the week of 2026-10-05: `ai` 31.0M, `@anthropic-ai/claude-agent-sdk` 12.1M, `@langchain/langgraph` 3.8M, `@openai/agents` 2.3M, `@mastra/core` 2.2M, Cloudflare `agents` 2.0M. The AI SDK middleware ships first, the Claude Agent SDK hook second, the rest as community adapters.

### 4.3 Two stages, not one avatar

| Stage | Who | Trigger | Role |
| --- | --- | --- | --- |
| Free and open source | Founder-engineer at a 2 to 15 person AI product already selling credits | Their balance code leaked or raced, or an agent over-drew a customer | Proof assets, bugs found, word of mouth on X. Will not pay. Every overlay vendor's free tier targets them (Autumn up to $8K a month of billing volume, Schematic up to $5K, Stigg 10K entities) |
| Paying | The engineer who owns the credits table at a 20 to 80 person Series A to B AI infra or agent product, or the first billing engineer | An enterprise prospect asks for per-team or per-agent caps before signing, or Stripe refunds no longer reconcile with usage | Design partners and revenue. Paying starts near $50K a month of billing volume at $375 to $499 a month across comparables |

Three overlays aimed only at the free stage died (Tier, Lotus, Kable). Autumn retreated from seed to day-zero builders because "moving upmarket from seed is hard". Design partners come from the paying stage.

### 4.4 Triggers, by frequency in the evidence

1. **A pricing change needs a deploy.** The most frequent trigger at every stage (Jeli, Automox, Syrto, Replit, Pickleheads, Firecrawl with 16 pricing updates in four months).
2. **An enterprise prospect asks for per-team, per-agent, or per-key caps.** Firecrawl, Cursor, Devin, and OpenHands built it after that ask. This is the trigger the budget fits.
3. **Revenue leaked through unenforced limits or a broken balance.** Zep: "revenue lost to untracked usage and unenforced limits". An agent "reserved about 1,000 credits' worth of tokens, then crashed mid-flight" and the credits stayed locked. A duplicate Stripe webhook granted credits three times.
4. **The builder's own agent ran away.** A $38K Bedrock bill, a $200 loop found the next morning. These readers convert to gateways unless the message says customer-keyed.
5. **A customer disputes usage.** Public cases at Cursor, Replit, Lovable, v0, Manus, and Intercom. Below Series B this incident is not public and should not lead.

### 4.5 What they have tried

Stripe for invoices. A Redis or Postgres counter with a cron reset. Stripe credit grants, which burn at invoice finalization, not in real time. A gateway spend cap on their own provider key. Hand reconciliation when a customer complains.

### 4.6 Objections, in the order they raise them

1. **Bypass.** "any path that builds a second client bypasses the hook" (OpenAI Agents issue 3353). Subagents, retries, and title-generation calls escape the main loop (Mastra 23242, Claude Agent SDK 1273). Answer: the subject lives in one DO, so every client and subagent that names the same subject shares one atomic counter. The wrapper is the convenience. The DO is the enforcement.
2. **Estimate versus actual.** Local price tables drift with caching and proxied models. Answer: settle is the truth, the catalog syncs daily, overrides exist per project.
3. **Between-call enforcement overshoots.** Answer: authorize reserves the worst case before the call, and the stream is cut when remaining reaches zero.
4. **The gateway already covers it.** OpenRouter per-key limits, Vercel API-key budgets, LiteLLM key and team budgets, OpenAI org hard limits. Answer: those are account-level and exclude bring-your-own-key, so "per end customer" means one gateway key per customer kept by hand.
5. **Price and latency for a free-tier team.** A synchronous call before every model call is "costly when the check gates every AI call" (Autumn). Answer: Tier 1 is one DO hop and the number is published, Tier 2 removes the hop for long-lived processes, and the core is open source.
6. **Lock-in, exit cost, acquisition risk, and AGPL.** Every open-source billing thread on HN raises AGPL. Autumn chose Apache.

Latency with an SLA was "non-negotiable number one" in the one vendor-selection write-up found (AssemblyAI). Measured numbers beat claims.

### 4.7 Channels

Worked for comparables: X at 2 to 5 posts a day, warm YC and founder email, hands-on migration help for the first design partners, one credibility Show HN. No evidence for cold DMs, LinkedIn, AI-engineering Discords, or Lenny's. Budget and billing Show HNs in 2026 scored 1 to 9 points. The lead list for the paying stage is the 2026 billing-engineer postings (Comfy, Glean, Deepgram, Render, Supabase, E2B, Tavily, Perplexity, Nebius) and the filers of the OpenHands and Cursor per-run-cap requests.

### 4.8 Voice of the persona

Market evidence, never Unprice customer proof.

- "no way to check a customer's balance before they use the product, no way to enforce spend caps" (HackerNoon teardown of Stripe usage-based billing, 2026)
- "Budget alerts are not a kill switch." (HN item 47933355, 2026-04-28)
- "reserving each call's worst-case cost before sending it, making the check atomic per conversation" (OpenHands issue 5561, 2026-10-07)
- "Credits without real-time enforcement are a suggestion, not a system." (Stigg engineer, 2026-03-19)
- "Observability tells me after. I need before." (Cycles CTO after "$153 in 30 minutes", dev.to, 2026-03-18)
- "Once the request has gone out, you cannot cancel the cost." (AIO Helper founder, dev.to, 2026-10-06)
- "a run that loops spends until its iteration cap" (re-cinq/lore issue 2395, 2026-10-01)
- "every support ticket starts with a number your database cannot explain." (Velobase, dev.to, 2026-06-25)
- "a required reservation step before each provider call" plus "settlement of actual usage after each call" (Mastra issue 23242, 2026-09-07, labelled low priority)

### 4.9 Disqualifiers

Seat-based SaaS whose need is packaging UI and invoicing (Stigg and Schematic territory). Enterprises that want rev-rec, tax, or accounting replacement. Internal AI chargeback and FinOps, where caps are a free gateway feature. Outcome-priced vertical agents at Series C and later, where the owners are pricing and deal-desk ops, not engineers.

## 5. Market evidence

| Source class | What it says | Consequence for the budget |
| --- | --- | --- |
| Market surveys (Poyar 2026, ICONIQ 2026, Orb cohort) | Hybrid pricing is primary for 37 to 48 percent. Pure outcome stays at 4 to 5 percent. Credits are at 29 percent with 33 percent planning | Outcomes sit on top of a budget and credit layer. Budgets must be expressible in money or credits |
| Shipping outcome products (Intercom, Zendesk, Salesforce, Sierra, HubSpot) | Terminal event, quiet period (24 h Intercom, 72 h Zendesk), exclusion list, at most once per unit, reversal on reopen, evidence table | An outcome is a state machine with three numbers per type |
| Gateways (LiteLLM, OpenRouter, Solo, Cycles) | Reserve-then-settle is the default, against the operator's provider spend | Reserve and settle are table stakes. The subject, the price, and the export are the difference |
| Distributed counters (Doorman, Envoy RLQS, Kong, Cloudflare rate limit) | Lease an allowance with a TTL from one authority, enforce locally, report on an interval, publish overshoot as rate × interval × replicas | The local tier is a lease, not a query |
| Polar Outpost (code read 2026-10-14, section 5.1) | A client-side meter cache fed by server snapshots. `cold_until` plus `version` hand the count from server to client. No reservation, no enforcement, no event forwarding | Take the handoff and the push for Tier 2. Keep the pre-debited lease, because a count is not a cap |
| Capability tokens (macaroons, L402, AAIF 402) | A token carries a ceiling and lineage, never remaining balance | Child agents get attenuated ceilings. The DO holds remaining |
| Card networks (Stripe capture-later, multicapture, overcapture) | Expiry auto-voids, partial capture releases the rest, bounded over-capture, idempotency on both verbs | A reservation is a first-class object |
| BYO-billing exports (Stigg, OpenMeter, Orb, Metronome) | Push finalized statements before the provider finalizes, one-way | Export statements, not events |
| Agent frameworks (Claude Agent SDK, OpenAI Agents SDK, Mastra, AI SDK) | Every framework has a before hook that can deny and an after hook for results | Adapters are hook functions over one API |

### 5.1 Polar Outpost, read from the code on 2026-10-14

Polar's 2026-10-08 post promised "zero network latency metering". The code landed by 2026-10-14 as Outpost: server reducers and buckets (PRs 15230, 15322, 15352, 15385), a WebSocket at `/v1/outpost/` (15223), snapshot messages (15293, 15411, 15448, 15462), and an `Outpost` class in the TypeScript and Python SDKs (15417) that replaced a standalone sidecar (15160, closed). A metering-v2 flag gates it per organization. The docs do not mention it. The explainer video in `~/repos/tutorials/outpost-vs-budget-explained` walks through it next to the budget.

How it works:

- **Server.** Every meter has a reducer (a filter plus an aggregation). Ingestion folds each event into a 5-minute bucket per reducer per customer. The current and previous buckets roll up in Redis synchronously, and a debounced task copies a bucket into Postgres when it closes.
- **Sealing.** Billing takes advisory locks in one global key order, splits the first and last bucket at the exact billing boundary, stamps `sealed_at`, and opens a new `generation` for late events. Billed totals never change, and late usage counts next time.
- **Snapshot.** The WebSocket sends the reducer configuration and, per customer per meter, a snapshot with `version` (database time in microseconds), `cold_until` (the end of the last bucket synced to Postgres, at most one hour back), count, sum, min, max, and `credited_units`. A Redis pub/sub event on every bucket sync pushes a fresh snapshot without a request.
- **Client.** The merchant runs their own Redis. Three Lua scripts own it atomically: read state, write bucket, apply snapshot. Polar owns everything before `cold_until`, and the client counts its own buckets after it. Applying a snapshot deletes local buckets older than the cutoff and never moves the cutoff backwards. A write older than the cutoff is dropped. A read is cold totals plus local buckets, then `balance = credited − consumed`, with no network call. Per process: a 1024-entry LRU, a 30-second full resync, 5-second timeouts, fail closed until restart.

Where it stops, observed from the code:

- The SDK never forwards the event to Polar. The merchant still makes a separate ingest call, so the local count and Polar's record diverge until the cutoff catches up.
- There is no reservation and no enforcement. It answers "what is the balance now", not "may this request spend X", so concurrent requests race past zero. That is the bug class in section 2.
- Local sums are floats (`HINCRBYFLOAT`). The SDK never deduplicates. Credits are a "temporary" read from customer meters with a known gap at renewal. The one-hour lookback makes a long-offline instance stale by design.

What the budget takes: the cutoff plus version handoff for Tier 2 state, on top of the pre-debited lease (section 6.5); push over a Durable Object WebSocket instead of polling; a process-local and a shared-Redis store, with their Lua scripts as the template; `sealedAt` plus `generation` for statements (section 6.7); their double-read validation against the old path and a multi-process end-to-end harness (section 14); and a configurable `onUnavailable`, because fail-closed-only is a sharp edge.

Competitive read: Outpost is a client-side meter cache with a server handoff, and Polar will market it as zero-latency metering. It is not an authorization step and it does not bound overspend, so the gap in section 2 is still open. The message collides, so our numbers have to say "authorize before the call, bounded overshoot, one DO hop" rather than "fast".

## 6. The budget

### 6.1 Object

```text
Budget
  id
  subject            { type: string, id: string, parentId?: string }   // builder's own ids
  scope              all | { features: [featureSlug] }                  // what this cap counts
  unit               "minor:<currency>" | "credits" | "units:<featureSlug>" // spend cap or unit limit
  cap                integer per window
  window             { kind: none | fixed | rolling, period: day | week | month | <iso duration> }
  mode               shadow | enforce
  onUnavailable      deny | allow | safeCapacity(n)                     // local tier only
  overcaptureRatio   number, default 0
  funding            external | wallet:<walletId> | plan:<planVersionId> // external in v1
  binding            { rateCardId, mode: follow | pinned, asOf? }      // ADR-0005 D1; a catalog card for AI budgets
  outcomeTypes?      { [type]: { price, quietPeriod, lockPeriod, maxPerUnit: 1, exclusions } }   // later
  thresholds         [0.5, 0.8, 1.0]
  entries            append-only (authorize, settle, release, fund, reverse, expire, lease)
```

Decisions:

- **The subject is the builder's id.** `type` is free-form. An Unprice customer may link to a subject later and is never required.
- **Funding is external by default.** The builder asserts the cap, and the money stays in their Stripe. Unprice records what was authorized and settled and hands the numbers back.
- **Entries, not an integer.** Remaining is derived from an append-only list.
- **A unit limit and a spend cap are the same object.** "1,000 API calls a month" is a budget with `unit: "units:api-calls"`. "$50 a month" is a budget with `unit: "minor:USD"` and `scope: all`. Both live in the subject's one DO (ADR-0005 D4).
- **Hierarchy is attenuation.** A child (a run under an agent under a customer) leases from its parent chain and cannot exceed the parent's remaining. Lineage travels in the SDK context. Remaining never does.

### 6.2 Verbs

```text
authorize  { subject, estimate: { amount } | { feature, dimensions, usage }, idempotencyKey, ttl?, metadata? }
        -> { authorizationId, allowed, remaining, deniedReason?, wouldDeny? (shadow) }

settle     { authorizationId, amount | { usage }, final?: boolean, idempotencyKey }
        -> { funded, unfunded, remaining, lines: [{ rateRowId, quantityKey, units, amount }] }

release    { authorizationId }

charge     { subject, amount | usage, idempotencyKey }            // authorize + settle in one hop
        -> { allowed, remaining, funded, unfunded }

fund       { budgetId, amount, source, idempotencyKey }            // public, no provider needed

outcomes.report { subject, outcomeType, unitId, state: pending | confirmed | reversed,
                  evidenceRef?, idempotencyKey }                    // later
```

Semantics:

- `authorize` is the gate and `settle` is the truth. Estimates miss by an order of magnitude on the same prompt, so the gate holds the estimate and settlement replaces it.
- `authorize` locks the rate rows it resolved, and `settle` prices with the locked rows, so a price change between the two never changes what one call costs. `usage` is a vector of named, non-overlapping quantities (ADR-0005 D2). Usage that matches no row is denied with `NOT_PRICED`.
- Every verb takes an idempotency key. An identical replay returns the original result. A different payload on the same key is an error.
- The TTL defaults to 1 hour, maximum 24 hours. Expiry auto-releases. A settle after expiry is rejected, and the caller re-authorizes.
- `final: true` closes the authorization and releases the remainder. A settle above `estimate × (1 + overcaptureRatio)` is funded up to that ceiling, and the rest is recorded as `unfunded` with an event.
- `mode: shadow` evaluates and records everything, denies nothing, and returns `wouldDeny`.
- Every response carries `remaining`, so an agent can plan instead of looping into a wall.

### 6.3 Outcomes are long-lived authorizations (designed, not in the first release)

```ts
outcomeTypes: {
  resolution: { price: 99, quietPeriod: "72h", lockPeriod: "30d", maxPerUnit: 1,
                exclusions: ["escalated", "negative_feedback", "abandoned"] }
}
```

Four moments. The builder reports `pending` for a conversation id, and the DO opens a $0.99 authorization, so remaining drops at once and a second report for the same unit id is rejected. A reopen inside 72 hours reports `reversed`, which releases the hold. If the quiet period ends without a reversal, a DO alarm settles it, writes a `confirmed` entry, fires `outcome.confirmed`, and the line lands on the next statement. A reversal inside the lock period writes a negative entry, and later corrections are new entries. Hybrid pricing is the same budget debited by usage settles and outcome confirms, as separate statement lines. The builder asserts the outcome and supplies the evidence reference. Unprice supplies the window, the once-per-unit rule, and the entries list that answers "why was this charged". This replaces the planned `OutcomeAggregationDO`.

### 6.4 Pricing: rate cards, with the model catalog as the cost layer

Decided in [ADR-0005](./2026-10-14-adr-0005-rate-cards-and-budget-runtime.md). A budget prices through its `binding` to a rate card. AI budgets and custom features use the same object.

- **Rate card rows** are immutable and effective-dated: `{ featureId, match: { model, ... }, quantityKey, price, unitSize, effectiveFrom, effectiveTo }`. A price change closes a row and inserts a successor, and never needs a plan version. `follow` bindings pick up new rows at their `effectiveFrom`. `pinned` bindings resolve the rows effective at `asOf`.
- **The model catalog is a cost table, not a price.** `model_costs` is synced every six hours from models.dev (primary), with LiteLLM filling batch, one-hour cache write, web search, request, and image rates. A catalog rate card (`source: catalog`, `markup`) turns each cost row into rate rows (cost × markup), applied automatically or held for review with a notice period. Rating never reads the catalog. Every catalog line carries `costRowId` for margin.
- **Rating happens in the BudgetDO.** The Worker resolves which rows apply (cached) and passes them in. The DO runs `rate()`, because tiered prices need the period position the DO holds. This replaces the earlier "Worker rates, DO stays pure" design.
- **Usage vectors.** The middleware sends `{ provider, modelId, usage: { input, cache_read, cache_write_5m, cache_write_1h, output, reasoning } }` with non-overlapping buckets. The server never subtracts one total from another.
- **The estimate** for authorize is `rate()` over `{ input: promptTokens, output: maxOutputTokens }` at the highest context tier the prompt can reach.
- **An unknown model** is denied at authorize with `MODEL_NOT_PRICED`, before any spend, unless the card has an explicit default row.
- Sync lag, BYOK and fine-tuned models (project overrides), batch and priority tiers (separate cost rows), and errors in public catalogs (review mode) need documenting.

### 6.5 Fast path: two tiers, one contract

**Tier 1, hosted (first release).** One DO per budget subject, pinned to the existing EU placement. Budget config and funding events are pushed to the DO at write time, so the hot path never reads Postgres. Counters live in memory with SQLite behind them. The DO writes the entry to SQLite before it responds, so nothing is lost. "In memory" means the decision needs no database round-trip, not that it is volatile. One hop from the Worker. This is `RunBudgetDO` with the Postgres summary write and the synchronous wallet call removed from the request path. The BudgetDO replaces both `RunBudgetDO` and `EntitlementWindowDO` (ADR-0005 D4): one writer per subject, holding every budget, unit limit, and boolean flag for that subject, plus the bound rate rows, all pushed at write time.

**Tier 2, local lease (later, contract fixed now).** For a long-lived process (a Node server, an agent runner, a container), never for Workers callers. The SDK asks the DO for a lease: "spend up to 500 of this subject's budget for 30 seconds". The DO debits the lease up front, like the wallet-to-DO allocation in the reservation pattern. The SDK authorizes and settles in process with no network calls, buffers entries, reports every few seconds or at half the lease, and renews. If the process dies, the cap holds because the lease was pre-debited, and the DO releases the unreported remainder at expiry. What can be lost is the buffer since the last flush: under-reporting, never over-spending. Short flush intervals, a flush on exit signals, and small leases for tight budgets limit that loss. Zero loss means Tier 1. The builder picks the tier per budget.

Three details come from Polar Outpost (section 5.1):

- **State handoff by cutoff and version.** Every snapshot the DO sends carries `version` (the DO's commit sequence) and `coldUntil` (the last entry id the DO has applied). The SDK keeps only entries after `coldUntil`. Applying a snapshot deletes older local entries and never moves the cutoff backwards. A late local entry older than the cutoff is reported, never counted twice. Local remaining is `snapshot.remaining − local entries after coldUntil`.
- **Push over a Durable Object WebSocket.** The SDK holds one hibernating WebSocket per subject. The DO pushes the lease grant, every snapshot, and config changes, and the SDK sends reports on the same socket. No polling and no 30-second resync. A reconnect asks for the snapshot once.
- **Two local stores.** `store: "memory"` for one process. `store: "redis"` for many replicas that share one lease, with atomic read, write, and apply-snapshot scripts. In both, sums are integers in minor units or credits, entries carry ids, and the DO deduplicates reports by entry id.

`onUnavailable` stays configurable (`deny`, `allow`, `safeCapacity(n)`). Outpost's fail-closed-only behavior is the edge to avoid.

### 6.6 Webhooks

Each event carries an id, a type, the subject, the budget state after the event, and the entry that caused it. It is signed with an HMAC, retried with backoff, and delivered at least once, with the id as the dedupe key. These are the first outbound webhooks in the product.

```json
{ "id": "evt_01J...", "type": "budget.exhausted",
  "subject": { "type": "agent", "id": "agent_7", "parentId": "acme" },
  "budget": { "cap": 5000, "remaining": 0, "window": "month" },
  "entry": { "kind": "settle", "amount": 180, "authorizationId": "auth_..." } }
```

Event types: `budget.threshold`, `budget.exhausted`, `authorization.expired`, `authorization.unfunded`, `outcome.confirmed`, `outcome.reversed`, `statement.finalized`, `sink.failed`.

### 6.7 Statements

Entries are the journal, one row per authorize, settle, release, fund, or reverse. A statement is the finalized, immutable summary of one subject's entries for one period: subject, period, unit, opening balance, funded in, open authorizations, settled charges, reversals, closing balance, lines grouped by feature or outcome type, a hash of the entries, and a version. A running statement is readable until the period closes. At close it finalizes before the builder's own billing run (Stripe needs at least one hour of grace). Without a price attached, the statement is in the budget's unit.

Finalization follows Polar's sealing. The statement stamps `sealedAt`, and the entries it covers get `generation = n`. An entry that arrives for a sealed period gets `generation = n + 1` and lands on the next statement. A correction is a new version that references the old one.

### 6.8 Sinks

A sink is a configured destination for finalized statements: a webhook, a Stripe meter-event push, a CSV drop, and later Unprice's own invoicing. It maps subject id to external customer id and feature to meter name, sends at finalization with the statement id as the idempotency key, and retries with a dead letter and a `sink.failed` event. Sinks are one-way and never feed back into enforcement. First release: webhook and CSV only.

## 7. How events reach a budget

Three shapes. First, the hold.

```ts
const auth = await unprice.budgets.authorize({
  subject: { type: "customer", id: "acme" },      // your id, never ours
  estimate: { amount: 250 },                      // ceiling in minor units ($2.50)
  idempotencyKey: `report:${reportId}:auth`,
  ttl: "15m",
})
if (!auth.allowed) {
  return res.status(402).json({ reason: auth.deniedReason, remaining: auth.remaining })
}
try {
  const out = await generateReport(input)
  await unprice.budgets.settle({
    authorizationId: auth.id,
    amount: out.costMinor,                        // or `usage: {...}` when pricing is attached
    final: true,
    idempotencyKey: `report:${reportId}:settle`,
  })
} catch (err) {
  await unprice.budgets.release({ authorizationId: auth.id })
  throw err
}
```

Second, the one-shot charge for work that cannot or need not be gated.

```ts
await unprice.budgets.charge({
  subject: { type: "customer", id: "acme" },
  usage: { feature: "pdf_pages", quantity: 12 },
  idempotencyKey: `doc:${docId}`,
})
```

Third, the AI SDK middleware, on the same `LanguageModelMiddleware` hooks from `ai ^7` that `packages/ai-sdk` uses today.

```ts
const model = wrapLanguageModel({
  model: anthropic("claude-sonnet-5-5"),
  middleware: unpriceBudget({
    client: unprice,
    subject: { type: "run", id: runId, parentId: customerId },
  }),
})
```

Inside the middleware, `transformParams` authorizes with the usage estimate `{ input: promptTokens, output: maxOutputTokens }` and the dimension `model: provider/modelId`, and the DO prices it from the bound rate card. `wrapStream` wraps the provider stream in a `TransformStream` that counts output tokens and aborts the stream when remaining reaches zero. The `finish` part settles with the real usage vector, split into non-overlapping buckets (`input`, `cache_read`, `cache_write_5m`, `output`, `reasoning`). An error releases. Agent frameworks get the same two calls as hook functions: Claude Agent SDK `PreToolUse` returns deny when authorize fails and `PostToolUse` settles, and OpenAI tool-input guardrails and Mastra `beforeToolCall` do the same. Non-gated facts keep today's async path: queue, then the DO applies a batch.

## 8. The entire path, in pseudo-code

The evidence path reuses what exists. `INGESTION_REPORTING_QUEUE` feeds the reporting consumer, which writes meter facts to Tinybird, audit records to `PIPELINE_EVENTS` and on to the R2 Data Catalog (Iceberg, table `events`), and status events to Tinybird (`apps/api/src/ingestion/reporting/consumer.ts`, `audit-record-publisher.ts`). Budget entries become audit records and meter facts on that path.

```mermaid
sequenceDiagram
  participant SDK as App / AI SDK middleware
  participant W as Worker route + use case
  participant DO as BudgetDO (subject)
  participant P as Parent BudgetDO
  participant Q as Reporting queue
  participant TB as Tinybird
  participant R2 as Pipeline -> R2 Iceberg
  participant WH as Webhook dispatcher

  SDK->>W: POST /v1/budgets/authorize {subject, estimate, key}
  W->>W: parse, bouncer (api key -> project), SWR cache budget config
  W->>W: resolve bound rate rows for the feature and dimensions (SWR)
  W->>DO: authorize({config, rows, estimate, key, ttl})
  DO->>P: lease(chunk) only when child allowance is low
  P-->>DO: {granted}
  DO->>DO: SQLite tx: authorization + entry + idempotency; memory counters
  DO-->>W: {allowed, authorizationId, remaining, entries[]}
  W->>Q: envelope {auditRecords, meterFacts}  (awaited, as today)
  W-->>SDK: {allowed, authorizationId, remaining}
  SDK->>SDK: provider call; stream cut when remaining hits 0
  SDK->>W: POST /v1/budgets/settle {authorizationId, usage|amount, final, key}
  W->>DO: settle(...)
  DO->>DO: tx: entry(settle), close auth, consumed += funded; outbox events on thresholds
  DO-->>W: {funded, unfunded, remaining, entries[]}
  W->>Q: envelope
  Q->>TB: meter facts, status events
  Q->>R2: audit records (evidence)
  DO->>WH: alarm flushes outbox -> signed POST, retries
```

```ts
// ---------- Worker: route (thin) ----------
POST /v1/budgets/authorize
  input   = authorizeInputSchema.parse(body)                // Zod at the boundary
  project = bouncer(apiKey)                                 // ACL cache, as today
  result  = useCases.budgets.authorize({ project, input })
  return toHttp(result)                                     // UnpriceApiError mapping

// ---------- Worker: use case ----------
authorize({ project, input }):
  config  = cache.swr(`budget:${project}:${input.subject.type}:${input.subject.id}`,
                      () => db.budgets.find(project, input.subject))
  if (!config) return Err(NO_BUDGET)                        // no implicit budgets
  rows    = input.estimate.usage
            ? rateCards.resolve(config.binding, input.estimate.feature, input.estimate.dimensions, now)
            : []                                            // cached rows; never the model catalog
  if (input.estimate.usage && rows.length == 0) return Err(NOT_PRICED)   // before any spend
  stub    = env.BUDGET_DO.get(idFor(env.APP_ENV, project, input.subject), { locationHint: "eu" })
  res     = await stub.authorize({ config, rows, estimate: input.estimate, idempotencyKey, ttl, metadata })
  await env.INGESTION_REPORTING_QUEUE.send(envelopeFrom(res.entries))   // evidence, awaited
  return Ok(shape(res))

// ---------- BudgetDO (single-threaded; one per subject) ----------
state (memory, rebuilt from SQLite on start):
  consumedInWindow, reservedOpen, openAuths: Map<id, Auth>, parentLease?: { remaining, expiresAt }
  idempotency: Map<key, Result>   (lazy hydrate, same as EntitlementWindowDO)
  outbox: pending events

onStart():
  migrate(); load counters; scheduleAlarm(nextOf(windowEnd, earliestAuthExpiry, flushDue))

authorize(req):
  if idempotency.has(req.key) return idempotency.get(req.key)
  rollWindowIfPassed(now)
  req.amount = req.estimate.amount ?? rate({ usage: req.estimate.usage, rows: req.rows,
                                             counters, at: now }).total      // DO rates: tiers need counters
  evaluation = evaluate(req.amount)                         // remaining = cap - consumed - reserved
  if config.mode == "shadow":
    entry = Entry.authorize({ amount, allowed: true, shadow: true, wouldDeny: !evaluation.ok })
    return commit([entry], { allowed: true, wouldDeny: !evaluation.ok, remaining })
  if config.subject.parentId and parentLease.remaining < req.amount:
    granted = await env.BUDGET_DO.get(parentId).lease({ child: subject, amount: chunk(req.amount) })
    if !granted.ok: return commit([Entry.authorize({ allowed: false, reason: PARENT_EXHAUSTED })], deny)
    parentLease.remaining += granted.amount
  if !evaluation.ok:
    return commit([Entry.authorize({ allowed: false, reason: BUDGET_EXHAUSTED })], deny(remaining))
  auth = { id, amount: req.amount, settled: 0, expiresAt: now + ttl, lockedRows: req.rows }
  openAuths.set(auth.id, auth); reservedOpen += auth.amount
  if parentLease: parentLease.remaining -= auth.amount
  return commit([Entry.authorize({ auth, allowed: true })], { allowed: true, authorizationId, remaining })

settle(req):
  if idempotency.has(req.key) return idempotency.get(req.key)
  auth = openAuths.get(req.authorizationId) ?? sql.auth(req.authorizationId)
  if !auth or auth.expiresAt < now: return reject(AUTH_EXPIRED)
  priced   = req.usage ? rate({ usage: req.usage, rows: auth.lockedRows, counters, at: now }) : null
  amount   = priced ? priced.total : req.amount             // locked rows: a price change mid-call never applies
  ceiling  = auth.amount * (1 + config.overcaptureRatio) - auth.settled
  funded   = min(amount, ceiling); unfunded = amount - funded
  auth.settled += funded; consumedInWindow += funded; counters = priced?.counters ?? counters
  entries  = [Entry.settle({ auth, funded, unfunded, usage: req.usage, lines: priced?.lines })]   // lines carry rateRowId
  if req.final: release = auth.amount - auth.settled; reservedOpen -= auth.amount; openAuths.delete(auth.id)
               if parentLease: parentLease.remaining += max(0, release)
  if unfunded > 0: outbox.push(Event.authorizationUnfunded(auth, unfunded))
  for t in thresholdsCrossed(before, after): outbox.push(Event.threshold(t))   // 1.0 => budget.exhausted
  return commit(entries, { funded, unfunded, remaining })

release(req): close auth, reservedOpen -= (auth.amount - auth.settled), Entry.release, commit

charge(req): authorize(req) then settle({ final: true }) inside one commit        // one hop, no hold

lease(req):            // called by a child DO, or by the SDK in Tier 2
  same as authorize, but the "auth" is a lease with kind=lease; expiry releases the unreported part

report(req):           // Tier 2 batched consumption against a lease
  for e in req.entries (dedupe by e.id): apply as settle against the lease
  commit(entries)

commit(entries, result):
  sql.transaction: insert entries; upsert auths; insert idempotency(req.key, result)
  idempotency.set(req.key, result)
  scheduleAlarm(...)
  return { ...result, entries }                             // Worker ships them to the reporting queue

alarm():
  for auth in openAuths where expiresAt <= now:
    release(auth); entries += Entry.expire(auth); outbox.push(Event.authorizationExpired(auth))
  if windowEnd + grace <= now:
    statement = buildStatement(entriesForPeriod); sql.insert(statement)
    outbox.push(Event.statementFinalized(statement)); roll window
  for pending outcomes past quietPeriod: settle(outcome) ; outbox.push(Event.outcomeConfirmed)   // later
  flushOutbox(): env.WEBHOOK_QUEUE.send(outbox events)      // at-least-once; event id dedupes
  scheduleAlarm(nextOf(...))

// ---------- Reporting consumer (exists today) ----------
consumeBatch(envelopes):
  auditRecords -> PIPELINE_EVENTS.send(parseLakehouseEvent("events", record))   // R2 Data Catalog, Iceberg
  meterFacts   -> Tinybird (entitlement meter facts datasource)
  statusEvents -> Tinybird (ingestion events)
  ack

// ---------- Webhook dispatcher (new) ----------
consume(event):
  endpoints = db.webhookEndpoints.forProject(event.project, event.type)
  for ep in endpoints:
    body = JSON(event); sig = hmac(ep.secret, timestamp + body)
    POST ep.url with Unprice-Signature; on non-2xx retry with backoff; after N failures -> dead letter + Event.sinkFailed

// ---------- Tier 2 SDK (later) ----------
local = unprice.budgets.local({ subject, lease: { amount: 500, ttl: "30s", refresh: "10s" }, store: "memory", onUnavailable: "deny" })
on socket message { kind: "snapshot", version, coldUntil, remaining }: drop local entries <= coldUntil; local.base = remaining
local.authorize(estimate):  if local.remaining >= estimate: hold locally else await refillLease() or deny
local.settle(auth, amount): local.consumed += amount; buffer.push(entry)
every refresh | buffer >= 100 | process exit:  send { kind: "report", leaseId, entries } on the socket -> DO.report
on DO unreachable: apply onUnavailable; on lease expiry DO releases unreported remainder
```

What is durable where: the DO's SQLite holds entries, authorizations, idempotency, and the statement for the retention window (7 days today for runs). Tinybird holds meter facts for analytics and dashboards. The R2 lakehouse holds the audit record of every entry as the long-term evidence. Postgres holds budget config, finalized statements, webhook endpoints, and delivery state. The hot path touches only the DO.

## 9. Runs become budgets

A run is a child budget with `subject { type: "run", parentId: customerId }`, a TTL, and funding inherited from the parent.

| Today | Budget equivalent |
| --- | --- |
| `runs.start` | Create a child budget, optionally authorize the whole ceiling |
| `runs.consume` | `charge` on the child |
| `runs.settle` | `settle` |
| `runs.end` | Close the child, release remaining to the parent |
| `budget_runs` Postgres mirror | Summary written through the reporting queue |
| `reservations.reserve` facade | `authorize` with the same shape, as a thin alias |

Only the customer-level budget talks to the wallet, so the synchronous wallet call in `runs.start` leaves the hot path. The `/v1/runs/*` routes stay as thin aliases during migration, then go.

## 10. Migration steps

| Step | What the builder does | What Unprice owns | Exit cost |
| --- | --- | --- | --- |
| 0 Shadow | Create a budget in shadow mode on their own ids, wrap the model call with the middleware | A decision log and the evidence trail | Delete one line |
| 1 Enforce | Flip `mode` to `enforce`, choose `onUnavailable` | The cap | Delete one line |
| 2 Price | Attach a rate card. Statements flow to their Stripe meter or webhook | Rating and statements | Stop the export |
| 3 Fund | Switch `funding` to a wallet. Customers prepay credits through Unprice | The prepaid balance | Refund and switch funding back |
| 4 Bill | Subscribe customers to plans. Entitlements become plan-funded budgets, and invoices roll up statements | The full money path | The existing exit |

The code written at step 0 is unchanged at step 4. Every design change must pass that test.

## 11. How existing concepts compose on budgets

| Today | On the budget |
| --- | --- |
| `customerEntitlement` (needs a plan version) | A budget with `subject = {customer}`, a feature scope, `funding = plan`, and the plan item's rate card binding |
| Price in `plan_versions_features.config` | Rate card rows bound by the plan item (`follow` or `pinned`). The plan version keeps the package only (ADR-0005 D1) |
| Boolean feature | A flag in the subject config the DO holds, with no counter |
| `creditLinePolicy: capped` + `creditLineAmount` | A customer-scoped budget with `window = period`, `funding = wallet` |
| Budget run (`/v1/runs/*`) | A child budget (section 9) |
| Wallet reservation in `EntitlementWindowDO` | A Tier 1 lease from wallet to DO, unchanged |
| Credit rate card plan (unbuilt) | A rate card whose `unit` is credits, bound to a budget |
| Phase 10 `cost_tables` (unbuilt) | `model_costs` plus project overrides (ADR-0005 D3) |
| Phase 8 spending limits | Budgets with `thresholds` and `mode` |
| Phase 9 outcome DO | `outcomeTypes` plus long-lived authorizations (section 6.3) |
| AI SDK `modelMiddleware` | The `unpriceBudget()` middleware (section 7) |
| Paid MCP tool | A per-call price on the tool's rule. The agent's budget is the subject |

## 12. Non-goals

- Invoicing, tax, payment collection, or any payment-provider dependency in steps 0 to 2.
- Rate limits (requests or tokens per minute). Dropped. The Workers Rate Limiting binding exists for anyone who needs an approximate one in front.
- Per-event Postgres ledger writes. Entries land in the DO and ship to Tinybird and R2. Postgres sees config, statements, and funding events.
- Exact global counting in the local lease tier. The bound is published instead.
- Agent-to-agent payment rails (x402, MPP, AP2). They are buyer-side. The budget settles to them later as sinks.
- Disputes as a product surface. The entries list is the evidence. A dispute UI is later.
- Seat-based SaaS packaging UI, internal FinOps chargeback, and outcome-priced vertical agents as a target (section 4.9).

## 13. What has to change in the repo

| Gap (verified 2026-10-13) | Change |
| --- | --- |
| Entitlements require `featurePlanVersionId`, a provider, and a subscription | New `budgets` and `budget_entries` config tables keyed by project and subject, no FK to plan or subscription. Hot entries live in the DO |
| `access.check` requires an Unprice customer id | Budgets and `authorize` key on `subject`, with an optional link to an Unprice customer |
| No public grant or top-up API | `budgets.fund` with sources `external`, `manual`, `promo`. Wallet top-up later |
| `RunBudgetDO` calls Postgres and the wallet synchronously and expires in 24 h | Generalize into `BudgetDO`: persistent subjects, config pushed in, summary writes on the reporting queue, wallet capture only when `funding = wallet` |
| `usage.consume` drops price, remaining, `value_after` | Every budget response returns `remaining`, `funded`, `unfunded`, and priced `lines` with `rateRowId` |
| Price lives in the plan version, so a price change needs a new version and change-plan per subscription | `rate_cards` and immutable, effective-dated `rate_card_rows`, `follow` and `pinned` bindings, and `computeConfigHash` without price (ADR-0005 D1) |
| One `aggregationField` per meter, and usage priced in four places | Usage vectors with dimension and quantity keys, and one pure `rate()` run in the BudgetDO and reused by the estimate, statements, `explain-charge`, and backtests (ADR-0005 D2) |
| `EntitlementWindowDO` and `RunBudgetDO` both enforce | `BudgetDO` replaces both. Plan subscriptions, runs, and wallets become producers and funding sources of budgets (ADR-0005 D4) |
| No outbound webhooks | `webhook_endpoints`, `webhook_deliveries`, `WEBHOOK_QUEUE`, a dispatcher Worker, HMAC signing |
| No model price catalog | `model_costs` and `model_aliases` synced every six hours (models.dev primary, LiteLLM enrichment, etag-gated), per-project overrides, and catalog rate cards that write cost × markup rows (ADR-0005 D3) |
| The AI SDK has no pre-call check or mid-stream cut-off | The `unpriceBudget()` middleware on `authorize` and `settle`, with a configurable throw on deny |
| No outcome step | `outcomeTypes` and `outcomes.report` on the same DO lifecycle (later) |
| No local evaluation | `lease` and `report` on the DO and a Tier 2 SDK mode (later): snapshots with `version` and `coldUntil`, one hibernating WebSocket per subject, `store: memory` or `store: redis`, report dedupe by entry id |
| No proof that the new engine matches the old one | A double-read harness that runs `BudgetDO` beside `EntitlementWindowDO` on recorded and synthetic traffic and logs disagreements, as a test gate before `EntitlementWindowDO` is deleted (never two engines enforcing in production), plus a multi-process test for Tier 2 with restarts, snapshots, and a tolerance |

Ownership follows ADR-0001: use cases under `internal/services/src/use-cases/budgets/`, thin routes under `apps/api/src/routes/budgets/`, Zod contracts in `internal/db/src/validators/budgets.ts`, the SDK generated from OpenAPI. The reporting consumer, the pipeline, and the lakehouse registry are reused with a new event type for budget entries.

## 14. Risks and open questions

- **One engine, replaced in one step.** Superseded by ADR-0005 D4: with no customers, `BudgetDO` replaces `EntitlementWindowDO` and `RunBudgetDO` instead of running beside them. The double-read harness (section 13) gates the deletion. The cost is a larger single change.
- **One DO per subject caps a hot subject.** All of a subject's budgets share one writer, which removes fan-in for subject-wide caps and supersedes the April 2026 per-meter DO choice. A single very hot subject is bounded by one DO's throughput, and Tier 2 leases are the escape.
- **`follow` bindings change what existing subjects pay.** Notice periods, review mode for catalog changes, and pending rows shown in the dashboard are the mitigation (ADR-0005).
- **Stigg speed.** Stigg 2.0 hard limits could leave private beta any week. Defensible differences: open source, builder-owned subjects, published consistency bounds, measured latency, the migration steps.
- **Polar's "zero-latency metering" message.** Outpost reads locally and Polar will sell it as fast, but it does not reserve or enforce (section 5.1). Our claim has to be the measured one: authorize before the call, one DO hop, overshoot bounded by the lease.
- **Proving the engine.** Polar validated Outpost with a double-read against the old path and a multi-process harness. Without the same for `BudgetDO` against `EntitlementWindowDO`, and for Tier 2 under restarts, the published bounds are claims.
- **The free stage is the whole top of the funnel.** Revenue depends on reaching the paying stage through the lead list in 4.7, not through Show HN.
- **The budget is untested with buyers.** One solo founder and one OpenHands issue describe needing pre-authorization. Design partners from the paying stage are the test.
- **Agent-native is a bet.** Credits and per-key caps are the observed demand. The first release serves both.
- **Caps without prices** mean statements in budget-only mode are in the builder's unit. State it plainly.
- **Marketing truth.** The canon says the first integration is two calls (`signUp`, then `check`). With budgets it becomes `budgets.create` then the middleware. Update `docs/brand` when the budget ships.
- **Compliance.** Subject ids should be opaque. `evidenceRef` is a pointer, never a payload. EU DO placement, the append-only entries, and the R2 audit record give the trail. Keep end-customer PII out of budgets, entries, and statements.

## 15. Sources

Sub-segments and voice: dev.to posts by Velobase (2026-06-25), Sayyed Amaan Ali (2026-07-12), AIO Helper (2026-10-06), Cycles CTO (2026-03-18), and a Vapi voice-agent builder (2025-12-30); GitHub issues openai-agents-python 2848 and 3353, langchain-ai/deepagents 6209, mastra 23242, claude-agent-sdk-python 1024 and 1273, vercel/ai 21701, cloudflare/agents 1083, firecrawl-docs PR 1416, integry/propr 2734, re-cinq/lore 2395, swenyai/sweny 449, AndreyBegma/AgentDock 28; HN items 47362375 and 47787042; Exa, E2B, and Tavily billing docs; Autumn posts on Firecrawl (2026-09-03) and AI billing infrastructure (2026-07-16); Vercel AI Gateway API-key budgets (2026-06-09); Anthropic Managed Agents budgets; npm download counts (api.npmjs.org, week of 2026-10-05) and GitHub stars (2026-10-13); Datadog State of AI Engineering 2026; Vercel State of AI survey.

Persona and buyers: Schematic case studies (Zep 2025-05-15, Flashnet 2026-02-09, Syrto 2026-08-31, Pickleheads 2026-08-24, Plotly 2026-03-19); Stigg customers and the Miro AI-credits post (2026-06-02); Autumn "talking about billing with 30 YC founders" (2025-01-22), "how we made our first sale" (2025-01-23), marketing and HN posts (2025-06), Firecrawl and T3 Chat posts (2026); Lago Blacksmith (2026-04-06) and "monetization engineer" (2026-07-29); vendor pricing pages (Stigg, Schematic, Autumn, 2026-10); HN threads 44365620, 46048252, 47933355, 46991656, 49949235; job postings at Comfy (2026-09-12), Glean, LaunchDarkly, Supabase, Deepgram, Render, Relevance AI, Replit, Perplexity (2026-04-24), Tavily, E2B (2026-09-22), Nebius (2026-07-06), Kong (2026-10-10); Cursor spend-limit docs and forum (2026-03-24, 2026-06-10); OpenHands issue 5561 (2026-10-07); Apify, fal, Ellipsis, Together, Replicate, Firecrawl, and OpenRouter billing docs; Metronome's AssemblyAI vendor-selection post (2025-01-27); Bain per-seat pricing (2025-10-09); Growth Unhinged state of B2B monetization (2026-05-13); FinOps Foundation Tokenomics (2026-06-03).

Market and outcome pricing: Intercom Fin outcomes; Zendesk automated-resolution tiers (2026-05-18) and Relate 2026; Salesforce Help Agent (2026-06-25); Sierra Horizon (2026-07); Bessemer AI pricing playbook (2026-02-10); Orb state of AI agent pricing 2026; ICONIQ state of AI 2026.

Budget products: Vercel AI Gateway budgets (2026-09-10); Cloudflare AI Gateway spend limits (2026-06-05); OpenRouter limits; LiteLLM budgets, issue 27639 (2026-05-11), PR 33543; Anthropic Managed Agents session budgets (2026-08-07); Stigg 2.0 governance (2026-06-30, 2026-07-09); Autumn docs; Lago entitlements; OpenMeter and Kong.

Polar Outpost (read 2026-10-14): "The next evolution of Polar" (polar.sh blog, 2026-10-08); polarsource/polar PRs 15160, 15223, 15293, 15352, 15385, 15411, 15417, 15448, 15462; `server/polar/outpost`, `server/polar/reducer`, `server/polar/models/reducer_bucket.py`, `sdk/typescript/src/outpost`, `sdk/e2e`; Polar customer-state and event-ingestion docs. Explainer video: `~/repos/tutorials/outpost-vs-budget-explained`.

Patterns: Google Doorman; Envoy rate limit quota filter; Cloudflare Workers rate limiting and Durable Objects rules; Kong rate-limiting-advanced sync_rate; Stripe capture-later, multicapture, overcapture, and meter event adjustments; AWS Marketplace MeterUsage; SatGate macaroons; Lightning L402 for agents (2026-03-11); AAIF 402 Payment Required (2026-09-22); Cloudflare Monetization Gateway beta (2026-09-30) and Wallets (2026-08-04); Claude Agent SDK hooks; OpenAI Agents SDK guardrails; Mastra tool hooks (2026-07-14); Vercel AI SDK middleware; models.dev API; LiteLLM model prices JSON.

Developer pain: "Your AI spend cap probably has a race condition" (dev.to, 2026-07); "I stored AI SaaS credits as a single integer" (dev.to, 2026-06); "Why we built our own credit ledger" (dev.to, 2026); Simon Willison on default hard budget caps (2026-10-03); TechCrunch "the token bill comes due" (2026-06-05); Mandiant AI risk report coverage (2026-09-16); Zendesk community thread on disputed resolutions (2025-08).

Repo facts: verified on 2026-10-13 in the files named in sections 2, 8, and 13.
