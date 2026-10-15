# Budget Primitive: Problem Space, Persona, and Definition

Date: 2026-10-13 (revised the same day with the persona research and design Q&A)
Status: proposal. Persona is evidence-based, not interview-validated. Replaces `docs/brand/jobs-to-be-done.md`.
Builds on: `2026-08-24-sdk-reservation-facade-design.md`, `../plans/budgeted-runs.md`,
`../plans/unprice-phase-08-financial-guardrails.md`, `../plans/unprice-phase-09-outcome-pricing.md`

## 1. The decision in one paragraph

The primitive is a **Budget**: a dollar or credit cap on any id the builder names (customer,
agent, run), funded from outside Unprice, enforced in memory by one Durable Object per subject,
driven by `authorize` before paid work, `settle` after, and `release` on abandonment. A budget
needs no plan, no plan version, no subscription, no payment-provider row, and no Unprice customer.
Everything Unprice already has (plans, entitlements, wallets, rate cards, invoices) becomes a layer
that funds, prices, or exports budgets, so adoption is a ladder and nothing written on the first
rung changes on the last. The focus is **AI products and agents**. The first release is one thing:
a hard cap per customer and per run, enforced before the model call, installed as AI SDK middleware
(section 3). Outcomes, customer pricing, statements export, and the local-evaluation tier are
designed here so the primitive supports them later, and are not in the first release.

## 2. The problem

The buyer is an engineer at a developer-led AI product that sells credits, metered model usage, or
agent runs, with Stripe already in place. Their fix today is a Redis counter, a gateway cap on
their own provider key, or nothing. Four facts define the problem space:

1. **The check-then-call race is the bug everyone ships.** A naive limiter over-admitted by 113 to
   161 requests against a cap of 500 in a published test. LiteLLM's reservation path leaked (Redis
   at $50 while the database said $0.001) and the fix was an opt-out flag. A single-integer credit
   balance went to -1 the day refunds started.
2. **Usage is known hours after the money is spent.** Stripe meter summaries are "eventually
   consistent", credits "apply to invoices only at the time of finalization", alerts "notify".
   Simon Willison's "hard budget caps need to be the default" drew 651 HN points on 2026-10-03.
3. **Nobody sells reserve-then-settle against the customer's budget.** Gateways (LiteLLM,
   OpenRouter, Vercel, Cloudflare AI Gateway) reserve against the operator's provider bill. Billing
   products (Metronome, Orb, Lago) have no synchronous authorization; Lago says "enforcement logic
   belongs in your own system". Stigg is closest: bring-your-own-billing, a sidecar cache, "reserve
   and settle" listed but undocumented, hard limits in private beta, closed source.
4. **Nobody can adopt Unprice without a billing migration.** Every entitlement requires a published
   plan version, an active payment-provider config, and a subscription
   (`internal/db/src/schema/entitlements.ts` makes `featurePlanVersionId` NOT NULL; sign-up fails
   without a provider row in `use-cases/payment-provider/availability.ts`). `access.check` needs an
   Unprice customer id; the external-id lookup is commented out in
   `apps/api/src/routes/entitlements/verifyV1.ts`. Runs need an active subscription and wallet
   funds, expire in 24 hours, and hit Postgres on every event.

The white space is precise: **a budget-authorized unit of work, keyed by the builder's own ids,
enforced in memory, that later settles to any rail.** Cloudflare's Monetization Gateway beta
(2026-09-30) already asks sellers for "the maximum price a single request could cost" and settles
actual consumption. The seller-side runtime that produces those numbers does not exist as an
open-source product.

## 3. The one thing for the first release

**A hard cap per customer and per run, enforced before the model call, installed as AI SDK
middleware, with no plan, no subscription, and no change to Stripe.**

What ships:

- `budgets.create` from the dashboard or the API, keyed by the builder's own customer id, with an
  optional child budget per run.
- `authorize`, `settle`, `release`, and the one-shot `charge`.
- `@unprice/ai-sdk` rewritten as `unpriceBudget()` middleware: authorize before `doGenerate` with
  an estimate from the model price catalog, cut the stream when remaining hits zero, settle on
  finish, release on error.
- The model price catalog, synced daily from a public source, so estimates and provider cost need
  no configuration.
- `mode: shadow` first, `mode: enforce` second.
- Webhooks for `budget.threshold`, `budget.exhausted`, `authorization.expired`,
  `authorization.unfunded`.
- The evidence trail: every entry lands in the DO, in Tinybird, and in the R2 lakehouse through
  the reporting path that already exists.

Why this one and not another:

- Per-run cap requests are open and unanswered where the persona lives: OpenHands issue 5561
  (2026-10-07, triaged ready-for-dev, proposing "reserve each call's worst-case cost before
  sending it"), Cursor forum requests in March and June 2026, Together "coming soon", Replicate
  removed account caps in July 2025.
- Gateways cap the operator's provider key, never the operator's customer. This is the gap.
- Seed-stage builders will not switch billing to solve one problem (Autumn's 30 founder
  interviews). A budget asks for no switch.
- The model call is where the money is created, and the repo already owns a middleware at that
  point. The "one afternoon" promise becomes literally true for AI products.
- It produces the evidence trail for free, which is the only answer to the disputed-usage
  incident later.

Explicitly not in the first release: outcome pricing (lifecycle reserved in section 6.3),
customer-facing rate cards, statements beyond a CSV export, the Stripe meter sink, the local
lease tier, and rate limits (dropped from scope entirely).

## 4. Persona: AI products and agents

Evidence basis: four web research passes on 2026-10-13 (overlay buyers, selling-side incidents,
excluded cohorts, roles and channels) plus the market pass in section 5. No Unprice customer
interviews have been run. The former `jobs-to-be-done.md` assumed a "margin-responsible founding
engineer at a 2 to 20 person pre-seed company" and was never validated; this section replaces it.

### 4.1 Who

An engineer at a developer-led AI product company that charges its own customers for model usage,
credits, or agent runs, and keeps Stripe for invoicing. At 2 to 15 people this is the founder or
founding engineer who wrote the credits table. At 20 to 80 people it is the engineer who still owns
that table, or the billing or monetization engineer they are about to hire. The company's paid
work runs in its own backend against OpenAI, Anthropic, or a gateway, usually through the Vercel
AI SDK or a raw provider SDK. Its customers are keyed by a user id, a workspace id, or an API key,
and its expensive unit is a run, a session, or a model call.

In the words a founder could use to DM them: a two-to-six person team selling an agent (coding,
research, ops, or voice) to other businesses, built in TypeScript on the Vercel AI SDK or the
Claude Agent SDK, calling Anthropic or OpenAI directly or through Vercel AI Gateway or OpenRouter.
They already have Stripe and a `plans` table. What they do not have is a hard stop before the
model call. They tried `max_turns`, a toast at $50, a Postgres `spend_usd` column checked after
the run, and a gateway key cap that turned out to be account-wide and blind to their own keys. The
moment of need is the first invoice or GitHub issue reading "a run that loops spends until its
iteration cap" or "free tier customers rack up $500 bills", usually weeks after the first paying
customers. They key on `customerId` plus `runId`, want per-customer-per-month and per-run at the
same time, and want the check to hold across parallel subagents. They will try it from a GitHub
issue or a Discord reply, pay nothing until about Series A, and leave if a check adds visible
latency.

### 4.2 Sub-segments

Ranked by fit with the first release (section 3). Acuteness and reachability come from 2026
issue threads and posts; ability to pay from funding and vendor tiering.

| Sub-segment | What they sell | Natural subject ids | Where paid work runs | Acuteness | Reachability | Pays | Middleware fit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Teams selling agents built on frameworks | The agent, to their own customers | tenant or customer id, run or attempt id, session id | AI SDK to provider or Vercel AI Gateway; OpenRouter; Claude Agent SDK | High: five 2026 issues across OpenAI Agents, LangChain deepagents, Mastra, Claude Agent SDK, Vercel AI, all closed stale or low priority | High: the issue threads themselves | Low to medium | Best: in-process, keyed on tenant and run, covers the "second client bypasses the hook" case when it lives in the model wrapper |
| Agent products selling per run or per task | Runs, sessions, tasks, minutes | customer id, run or task id, call id | Own backend, Vapi or Retell pass-through, Durable Objects, Claude Agent SDK | High: four repos shipped a run cap in one to three days in October 2026 (ProPR, Lore, Sweny, AgentDock); OpenHands, Devin, Cursor requests | Medium: GitHub, HN | Low, except voice agencies with many clients; OpenHands and Cursor class are Series B and later | Good for TypeScript; Python coding agents need the Claude Agent SDK hook |
| AI infra and API companies | Per-call credits behind API keys | API key, organization | Own backend (scrape, search, sandbox) with embedded model calls; the balance check is already synchronous in their request path | Medium: ledger rot (Firecrawl's 800-line SQL balance function), then per-key caps shipped by Exa, Firecrawl, Vercel AI Gateway in 2026 | Medium: a few hundred companies, warm intro | High at Series A and later; Autumn already has Firecrawl and Mintlify | Weak: the paid work is not a model call. Entry point is `charge` on `subject {type: "api_key"}`, not the middleware |
| AI apps selling prepaid credits to prosumers and SMBs | Credits per message, generation, or document | user id, site id, conversation id | Own Next.js or Supabase backend calling OpenAI directly or via the AI SDK | Medium: double charges and refunds after the first payments | High density, low quality (dev.to, Indie Hackers) | Very low; solo to five people, under $5K MRR | Good technically, but they want a credit ledger plus Stripe, not a budget |

The middleware wedge reaches the first two rows. The paying tier in 4.3 is the third row plus the
Series A and later members of the second, and for them the entry point is the same budget keyed on
an API key or a customer id, called from their own request path.

Adapter build order follows adoption. Weekly npm downloads for the week of 2026-10-05 and GitHub
stars on 2026-10-13: `ai` 31.0M and 27.3K; `@anthropic-ai/claude-agent-sdk` 12.1M;
`@langchain/langgraph` 3.8M; `@openai/agents` 2.3M; `@mastra/core` 2.2M and 28.8K; Cloudflare
`agents` 2.0M. The AI SDK middleware ships first, the Claude Agent SDK hook second, the rest as
community adapters.

### 4.3 Two-stage funnel, not one hybrid avatar

| Stage | Who | Trigger | Role in the business |
| --- | --- | --- | --- |
| Top of funnel: free and open source | Founder-engineer at a 2 to 15 person AI product already selling credits | Their own balance code leaked or raced; an agent over-drew a customer; a pricing change they cannot ship | Proof assets, bugs found, word of mouth on X. Will not pay. Every overlay vendor's free tier is designed for them (Autumn up to $8K a month of billing volume, Schematic up to $5K, Stigg 10K entities) |
| Paying tier | The engineer who owns the credits table at a 20 to 80 person Series A to B AI infra or agent product, or the first billing engineer | An enterprise prospect asks for per-team or per-agent caps before signing; margin monitoring is in their job description; Stripe refunds no longer reconcile with usage | Design partners and revenue. Paying starts near $50K a month of billing volume at $375 to $499 a month across comparables |

Three overlays aimed only at the top of the funnel died (Tier, Lotus, Kable). Autumn retreated from
seed to day-zero builders because "moving upmarket from seed is hard". The paying tier is where
design partners are recruited.

### 4.4 Triggers, ranked by frequency in the evidence

1. **A pricing change needs a deploy.** The most frequent purchase trigger at every stage (Jeli,
   Automox, Syrto, Replit, Pickleheads, Firecrawl with 16 pricing updates in four months).
2. **An enterprise prospect asks for per-team, per-agent, or per-key caps.** Firecrawl, Cursor,
   Devin, and OpenHands all built it after that ask. This is the trigger the budget primitive fits
   exactly.
3. **Revenue leaked through unenforced limits or a broken balance.** Zep: "revenue lost to
   untracked usage and unenforced limits". A solo founder: an agent "reserved about 1,000 credits'
   worth of tokens, then crashed mid-flight" and the credits stayed locked. A duplicate Stripe
   webhook granted credits three times. A cron burned 463 of a customer's 500 credits.
4. **The builder's own agent ran away.** A $38K Bedrock bill from a coding agent, a $200 loop
   found the next morning. These readers convert to gateways unless the message says
   customer-keyed.
5. **A customer disputes usage.** Public cases are at Cursor, Replit, Lovable, v0, Manus, Intercom,
   handled by the CEO and support. Below Series B this incident is not public and should not lead.

### 4.5 What they have tried

Stripe for invoices. A Redis or Postgres counter with a cron reset. Stripe credit grants (which
burn at invoice finalization, not in real time). A gateway spend cap on their own provider key
(LiteLLM, Vercel AI Gateway, Cloudflare AI Gateway, OpenRouter). Hand reconciliation when a
customer complains.

### 4.6 Objections, in the order they raise them

1. **Bypass.** "any path that builds a second client bypasses the hook" (OpenAI Agents issue
   3353); subagents, retries, and title-generation calls escape the main loop (Mastra 23242,
   Claude Agent SDK 1273). Answer: the subject lives server-side in one DO, so every client and
   every subagent that names the same subject shares one atomic counter; the wrapper is the
   convenience, the DO is the enforcement.
2. **Estimate versus actual.** Caps fire on a local price table that drifts with caching and
   proxied models; Anthropic's own session cap uses list price. Answer: settle is the truth, the
   catalog is synced daily, overrides exist per project.
3. **Between-call enforcement overshoots.** "checking between calls isn't a strict spending
   ceiling"; in-flight requests finish past the cap. Answer: authorize reserves the worst case
   before the call, and the stream is cut when remaining hits zero.
4. **Already covered by the gateway or provider.** OpenRouter per-key limits, Vercel API-key
   budgets, LiteLLM key and team budgets, OpenAI org hard limits. Counter: those are account-level
   and exclude bring-your-own-key, so "per end customer" means one gateway key per customer kept
   by hand.
5. **Price and latency for a free-tier team.** A synchronous network call before every model call
   is "costly when the check gates every AI call" (Autumn); indies pay nothing and self-host.
   Answer: Tier 1 is one DO hop and the number is published; Tier 2 removes the hop for long-lived
   processes; the core is open source.
6. **Lock-in, exit cost, and "will you get acquired like the rest"**, plus AGPL confusion (every
   open-source billing thread on HN raises it; Autumn chose Apache).

Latency with an SLA was "non-negotiable number one" in the one vendor-selection write-up found
(AssemblyAI). Measured numbers beat claims.

### 4.7 Channels

Worked for comparables: X at 2 to 5 posts a day, warm YC and founder email, hands-on migration help
for the first design partners, and a single credibility Show HN. Did not work or has no evidence:
cold DM design partners, LinkedIn founder mode for devtools, AI-engineering Discords and Slacks,
Lenny's. Budget and billing Show HNs in 2026 scored 1 to 9 points; Autumn's front-page day brought
traffic and "mostly negative comments". Outbound to 2026 billing-engineer postings (Comfy, Glean,
Deepgram, Render, Supabase, E2B, Tavily, Perplexity, Nebius) and to the filers of the OpenHands
and Cursor per-run-cap requests is the concrete lead list for the paying tier.

### 4.8 Voice of the persona (sourced, market evidence, never Unprice customer proof)

- "no way to check a customer's balance before they use the product, no way to enforce spend
  caps" (HackerNoon teardown of Stripe usage-based billing, 2026)
- "Billing systems are a nightmare for engineers." (Lago, HN item 31424450)
- "revenue lost to untracked usage and unenforced limits" (Zep CEO via Schematic, 2025-05-15)
- "Why do I have 37 credits? I bought 500 and I've barely touched this." (dev.to, 2026-06)
- "Budget alerts are not a kill switch." (HN item 47933355, 2026-04-28)
- "A dashboard that can't stop a launch is a suggestion. This is a cap." (dev.to, 2026-10-11)
- "reserving each call's worst-case cost before sending it, making the check atomic per
  conversation" (OpenHands issue 5561, 2026-10-07)
- "Credits without real-time enforcement are a suggestion, not a system." (Stigg engineer,
  2026-03-19)
- "Observability tells me after. I need before." (Cycles CTO after "$153 in 30 minutes", dev.to,
  2026-03-18)
- "Once the request has gone out, you cannot cancel the cost." (AIO Helper founder, dev.to,
  2026-10-06)
- "too late; the runaway already happened" and "one bad run can still exhaust the cap" (OpenAI
  Agents issue 3353, 2026-05-11)
- "a run that loops spends until its iteration cap" (re-cinq/lore issue 2395, 2026-10-01)
- "Free tier customers rack up $500 bills." (voice-agent builder on Vapi, dev.to, 2025-12-30)
- "every support ticket starts with a number your database cannot explain." (Velobase, dev.to,
  2026-06-25)
- "The unpredictability is worse than the absolute cost." (HN item 47362375, 2026-03-13)
- "a required reservation step before each provider call" plus "settlement of actual usage after
  each call" (Mastra issue 23242, 2026-09-07, labelled low priority)

### 4.9 Disqualifiers

Seat-based SaaS whose need is packaging UI and invoicing (Stigg and Schematic territory, densest
competition, now including Stripe credits). Enterprises wanting rev-rec, tax, or accounting
replacement. Internal AI chargeback and FinOps (caps are a free gateway feature; the artifacts
they lack, statements and per-agent lineage, fall out of this primitive as a side effect and need
no GTM). Outcome-priced vertical agents at Series C and later (owners are pricing and deal-desk
ops, not engineers).

## 5. Market evidence summary

| Source class | What it says | Consequence |
| --- | --- | --- |
| Market surveys (Poyar 2026, ICONIQ 2026, Orb cohort) | Hybrid is primary for 37 to 48 percent; pure outcome stays at 4 to 5 percent and fell in Orb's agent cohort; credits live at 29 percent with 33 percent planning | Outcomes sit on top of a budget and credit layer. Budgets must be expressible in money or credits |
| Shipping outcome products (Intercom, Zendesk, Salesforce, Sierra, HubSpot) | Terminal event, quiet period (24 h Intercom, 72 h Zendesk), exclusion list, at most once per unit, reversal on reopen even across periods, second verifier, evidence table | Outcome is a state machine with three numbers per type |
| Gateways (LiteLLM, OpenRouter, Solo, Cycles) | Reserve-then-settle is default at the gateway layer, against the operator's provider spend | Reserve/settle alone is table stakes. The subject, the price, and the export are the difference |
| Distributed counters (Doorman, Envoy RLQS, Kong, Cloudflare rate limit) | Lease an allowance with TTL from one authority; enforce locally; report on interval; publish overshoot as rate × sync interval × replicas | The local tier is a lease, not a query |
| Capability tokens (macaroons, L402, AAIF 402) | A token carries a ceiling and lineage, never remaining balance | Child agents get attenuated ceilings; the DO holds remaining |
| Card networks (Stripe capture-later, multicapture, overcapture) | Expiry auto-voids; partial capture releases the rest; bounded over-capture; idempotency on both verbs | Reservation is a first-class object |
| BYO-billing exports (Stigg, OpenMeter, Orb, Metronome) | Push finalized statements before the provider finalizes; one-way; never read the provider back | Export statements, not events |
| Agent frameworks (Claude Agent SDK, OpenAI Agents SDK, Mastra, AI SDK) | Every framework has a before hook that can deny and an after hook for results | Adapters are hook functions over one API |

## 6. The primitive

### 6.1 Object: Budget

```text
Budget
  id
  subject            { type: string, id: string, parentId?: string }   // builder's own ids
  unit               "minor:<currency>" | "credits"
  cap                integer per window
  window             { kind: none | fixed | rolling, period: day | week | month | <iso duration> }
  mode               shadow | enforce
  onUnavailable      deny | allow | safeCapacity(n)                     // local tier only
  overcaptureRatio   number, default 0
  funding            external | wallet:<walletId> | plan:<planVersionId> // external in v1
  pricing            { source: catalog, markup: 1.0 } | rateCardId | inline   // catalog default for AI budgets
  outcomeTypes?      { [type]: { price, quietPeriod, lockPeriod, maxPerUnit: 1, exclusions } }   // later
  thresholds         [0.5, 0.8, 1.0]
  entries            append-only (authorize, settle, release, fund, reverse, expire, lease)
```

Decisions:

- **Subject is the builder's id.** `type` is free-form. An Unprice customer may link to a subject
  later and is never required.
- **Funding is external by default.** The builder asserts the cap; the money stays in their
  Stripe. Unprice records what was authorized and settled and hands the numbers back.
- **Entries, not an integer.** Remaining is derived from an append-only list.
- **Hierarchy is attenuation.** A child (run under agent under customer) leases from its parent
  chain and cannot exceed the parent's remaining. Lineage travels in the SDK context; remaining
  never does.

### 6.2 Verbs

```text
authorize  { subject, estimate: { amount } | { usage }, idempotencyKey, ttl?, metadata? }
        -> { authorizationId, allowed, remaining, deniedReason?, wouldDeny? (shadow) }

settle     { authorizationId, amount | usage, final?: boolean, idempotencyKey }
        -> { funded, unfunded, remaining, priced? }

release    { authorizationId }

charge     { subject, amount | usage, idempotencyKey }            // authorize + settle in one hop
        -> { allowed, remaining, funded, unfunded }

fund       { budgetId, amount, source, idempotencyKey }            // public, no provider needed

outcomes.report { subject, outcomeType, unitId, state: pending | confirmed | reversed,
                  evidenceRef?, idempotencyKey }                    // later
```

Semantics:

- `authorize` is the gate; `settle` is the truth. Estimates miss by an order of magnitude on the
  same prompt, so the gate holds the estimate and settlement replaces it.
- Idempotency keys on every verb. Identical replay returns the original result; a different
  payload on the same key is an error.
- TTL default 1 h, maximum 24 h; expiry auto-releases; `extend` is allowed while open.
- Partial settles up to a bounded count; `final: true` closes and releases the remainder. A settle
  above `estimate × (1 + overcaptureRatio)` is funded up to that ceiling and the rest is recorded
  as `unfunded` with an event.
- Late settles after expiry are rejected; the caller re-authorizes.
- `mode: shadow` evaluates and records everything, denies nothing, and returns `wouldDeny`.
- Every response carries `remaining` so an agent can plan instead of looping into a wall.

### 6.3 Outcomes are long-lived authorizations (designed, not in the first release)

```ts
outcomeTypes: {
  resolution: { price: 99, quietPeriod: "72h", lockPeriod: "30d", maxPerUnit: 1,
                exclusions: ["escalated", "negative_feedback", "abandoned"] }
}
```

Four moments. The builder's system reports `pending` for a conversation id: the DO opens a $0.99
authorization, remaining drops immediately so caps hold, and a second report for the same unit id
is rejected. A reopen inside 72 hours reports `reversed`: the hold is released and nothing was
charged. The quiet period ends without a reversal: a DO alarm settles it, writes a `confirmed`
entry, fires `outcome.confirmed`, and the line lands on the next statement. A reversal after
confirmation but inside the lock period writes a negative entry. After the lock, corrections are
new entries. Hybrid pricing is the same budget debited by usage settles and outcome confirms; the
statement lists them as separate lines. The builder asserts the outcome and supplies the evidence
reference; Unprice supplies the window, the once-per-unit rule, and the entries list that answers
"why was this charged". This collapses the planned `OutcomeAggregationDO` into the same lifecycle
as a run.

### 6.4 Pricing: the model price catalog is in, customer rate cards are later

AI budgets need an estimate before the call and a cost after it. Both come from a `model_prices`
table synced daily from a public catalog. Verified on 2026-10-13: models.dev publishes per-provider
cost for input, output, cache read and cache write with release and last-updated dates and context
limits; LiteLLM's `model_prices_and_context_window.json` publishes per-token input, output and
cache-read costs with the provider name. OpenRouter's models endpoint did not expose pricing in the
same check. Design:

- `model_prices (provider, model, input, output, cacheRead, cacheWrite, reasoning, effectiveFrom)`
  with a per-project override table.
- `pricing: { source: "catalog", markup: 1.0 }` is the default for AI budgets. The middleware sends
  `{ provider, modelId, inputTokens, outputTokens, cachedInputTokens, reasoningTokens }`; the
  Worker rates it before calling the DO; the DO receives an amount plus the usage facts.
- Estimate for authorize is `(promptTokens + maxOutputTokens) × catalog rate`.
- Customer-facing rate cards (`../plans/penging/credit-rate-card-implementation-plan.md`) plug in
  as a second `pricing.source` later. Caveats for docs: sync lag on provider price changes, BYOK
  and fine-tuned models need overrides, batch and priority tiers are separate rows.

### 6.5 Fast path: two tiers, one contract

**Tier 1, hosted (first release).** One DO per budget subject, pinned to the existing EU
placement. Budget config and funding events are pushed to the DO at write time; the hot path never
reads Postgres. Counters live in memory with SQLite behind them; the DO writes the entry to SQLite
before it responds, so nothing is lost. "In memory" means the decision needs no database
round-trip, not that it is volatile. One hop from the Worker. This is the shape of `RunBudgetDO`
with the Postgres summary write and the synchronous wallet call removed from the request path.

**Tier 2, local lease (later, contract fixed now).** For a long-lived process (Node server, agent
runner, container), never for Workers callers. The SDK asks the DO for a lease: "spend up to 500 of
this subject's budget for 30 seconds". The DO debits the lease up front, exactly like the
wallet-to-DO allocation in the reservation pattern. The SDK authorizes and settles in process with
no network calls, buffers entries, reports consumption every few seconds or at half the lease, and
renews. If the process dies, the cap is safe because the lease was pre-debited and the DO releases
the unreported remainder at expiry. What can be lost is the buffered entries since the last flush:
under-reporting, never over-spending. Mitigations are the usual client-batcher ones: short flush
interval, flush on exit signals, flush when the buffer fills, small leases for tight budgets. Zero
loss means Tier 1. The builder picks the tier per budget.

### 6.6 Webhooks

Each event carries an id, a type, the subject, the budget state after the event, and the entry that
caused it, signed with an HMAC, retried with backoff, delivered at least once (the id is the dedupe
key). These are the first outbound webhooks in the product.

```json
{ "id": "evt_01J...", "type": "budget.exhausted",
  "subject": { "type": "agent", "id": "agent_7", "parentId": "acme" },
  "budget": { "cap": 5000, "remaining": 0, "window": "month" },
  "entry": { "kind": "settle", "amount": 180, "authorizationId": "auth_..." } }
```

Event types: `budget.threshold`, `budget.exhausted`, `authorization.expired`,
`authorization.unfunded`, `outcome.confirmed`, `outcome.reversed`, `statement.finalized`,
`sink.failed`.

### 6.7 Statements

Entries are the journal, one row per authorize, settle, release, fund, reverse. A statement is the
periodic summary of one subject's entries for one period, finalized and immutable. It carries the
subject, period, unit, opening balance when funded, funded in, open authorizations, settled
charges, reversals, closing balance, lines grouped by feature or outcome type with count, quantity
and amount, a hash of the underlying entries, and a version. Until the period closes a running
statement is readable for display. At close it finalizes before the builder's own billing run
(Stripe needs at least one hour of grace). A correction after finalization is a new version that
references the old one. Without a price attached, the statement is in the budget's unit.

### 6.8 Sinks (export destinations)

A sink is a configured destination that receives finalized statements automatically: a webhook, a
Stripe meter-event push, a CSV drop, and later Unprice's own invoicing. Each sink maps subject id
to external customer id and feature to meter name, sends at finalization with the statement id as
the idempotency key, and retries with a dead letter and a `sink.failed` event. Sinks are one-way.
Nothing a sink does feeds back into enforcement. First release: webhook and CSV only.

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

Third, the AI SDK middleware, on the same `LanguageModelMiddleware` hooks from `ai ^7` that
`packages/ai-sdk` uses today.

```ts
const model = wrapLanguageModel({
  model: anthropic("claude-sonnet-5-5"),
  middleware: unpriceBudget({
    client: unprice,
    subject: { type: "run", id: runId, parentId: customerId },
  }),
})
```

Inside the middleware: `transformParams` authorizes with an estimate of prompt tokens plus
`maxOutputTokens` times the catalog rate for `model.provider` and `model.modelId`. `wrapStream`
wraps the provider stream in a `TransformStream` that counts output tokens and aborts the stream
when remaining hits zero. The `finish` part settles with real usage. An error releases. Agent
frameworks get the same two calls as hook functions: Claude Agent SDK `PreToolUse` returns deny when
authorize fails and `PostToolUse` settles; OpenAI tool-input guardrails and Mastra `beforeToolCall`
do the same. Non-gated facts keep the async path that exists today: queue, then the DO applies a
batch.

## 8. The entire path, in pseudo-code

The evidence path reuses what exists: `INGESTION_REPORTING_QUEUE` → reporting consumer → meter
facts to Tinybird, audit records to `PIPELINE_EVENTS` → R2 Data Catalog (Iceberg, table
`events`), status events to Tinybird (`apps/api/src/ingestion/reporting/consumer.ts`,
`audit-record-publisher.ts`). Budget entries become audit records and meter facts on that path.

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
  W->>W: rate estimate via model_prices if usage given
  W->>DO: authorize({config, amount, key, ttl})
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
  amount  = input.estimate.amount
         ?? rate(input.estimate.usage, config.pricing, modelPrices.cached())   // Worker rates, DO stays pure
  stub    = env.BUDGET_DO.get(idFor(env.APP_ENV, project, input.subject), { locationHint: "eu" })
  res     = await stub.authorize({ config, amount, idempotencyKey, ttl, metadata })
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
  auth = { id, amount: req.amount, settled: 0, expiresAt: now + ttl }
  openAuths.set(auth.id, auth); reservedOpen += auth.amount
  if parentLease: parentLease.remaining -= auth.amount
  return commit([Entry.authorize({ auth, allowed: true })], { allowed: true, authorizationId, remaining })

settle(req):
  if idempotency.has(req.key) return idempotency.get(req.key)
  auth = openAuths.get(req.authorizationId) ?? sql.auth(req.authorizationId)
  if !auth or auth.expiresAt < now: return reject(AUTH_EXPIRED)
  ceiling  = auth.amount * (1 + config.overcaptureRatio) - auth.settled
  funded   = min(req.amount, ceiling); unfunded = req.amount - funded
  auth.settled += funded; consumedInWindow += funded
  entries  = [Entry.settle({ auth, funded, unfunded, usage: req.usage })]
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
local = unprice.budgets.local({ subject, lease: { amount: 500, ttl: "30s", refresh: "10s" }, onUnavailable: "deny" })
local.authorize(estimate):  if local.remaining >= estimate: hold locally else await refillLease() or deny
local.settle(auth, amount): local.consumed += amount; buffer.push(entry)
every refresh | buffer >= 100 | process exit:  POST /v1/budgets/report { leaseId, entries }  -> DO.report
on DO unreachable: apply onUnavailable; on lease expiry DO releases unreported remainder
```

What is durable where: the DO's SQLite holds entries, authorizations, idempotency, and the
statement for the retention window (7 days today for runs). Tinybird holds meter facts for
analytics and dashboards. The R2 lakehouse holds the audit record of every entry as the long-term
evidence. Postgres holds budget config, finalized statements, webhook endpoints, and delivery
state. The hot path touches only the DO.

## 9. Runs become budgets

A run is a child budget with `subject { type: "run", parentId: customerId }`, a TTL, and funding
inherited from the parent.

| Today | Budget equivalent |
| --- | --- |
| `runs.start` | create child budget, optionally authorize the whole ceiling |
| `runs.consume` | `charge` on the child |
| `runs.settle` | `settle` |
| `runs.end` | close the child, release remaining to the parent |
| `budget_runs` Postgres mirror | summary written through the reporting queue |
| `reservations.reserve` facade | `authorize` with the same shape; thin alias |

The child reserves from the parent's DO, and only the customer-level budget talks to the wallet, so
the synchronous wallet call in `runs.start` leaves the hot path. The `/v1/runs/*` routes stay as
thin aliases during migration, then go. `startUnpriceRun` in the AI SDK becomes "create a run
budget".

## 10. The migration ladder

| Rung | What the builder does | What Unprice owns | Exit cost |
| --- | --- | --- | --- |
| 0 Shadow | Create a budget in shadow mode on their own ids, wrap the model call with the middleware | A decision log and the evidence trail | Delete one line |
| 1 Enforce | Flip `mode` to `enforce`, choose `onUnavailable` | The cap | Delete one line |
| 2 Price | Attach a rate card; statements flow to their Stripe meter or webhook | Rating and statements | Stop the export |
| 3 Fund | Switch `funding` to a wallet; customers prepay credits through Unprice | Prepaid balance | Refund and switch funding back |
| 4 Bill | Subscribe customers to plans; entitlements become plan-funded budgets; invoices roll up statements | The full money path | Existing exit |

The code written on rung 0 is unchanged on rung 4. Every design change must pass that test.

## 11. How existing concepts compose on budgets

| Today | On the primitive |
| --- | --- |
| `customerEntitlement` (needs plan version) | A budget with `subject = {customer}`, a `featureSlug`, `funding = plan` |
| `creditLinePolicy: capped` + `creditLineAmount` | A customer-scoped budget with `window = period`, `funding = wallet` |
| Budget run (`/v1/runs/*`) | A child budget (section 9) |
| Wallet reservation in `EntitlementWindowDO` | Tier 1 lease from wallet to DO, unchanged |
| Rate card plan | `pricing.source` on a budget |
| Phase 8 spending limits | Budgets with `thresholds` and `mode` |
| Phase 9 outcome DO | `outcomeTypes` plus long-lived authorizations (section 6.3) |
| AI SDK `modelMiddleware` | `unpriceBudget()` middleware (section 7) |
| Paid MCP tool | A per-call price on the tool's rule; the agent's budget is the subject |

## 12. Non-goals

- Invoicing, tax, payment collection, or any payment-provider dependency in rungs 0 to 2.
- Rate limits (requests or tokens per minute). Dropped. The Workers Rate Limiting binding exists
  for anyone who needs an approximate one in front.
- Per-event Postgres ledger writes. Entries land in the DO and ship to Tinybird and R2; Postgres
  sees config, statements, and funding events.
- Exact global counting in the local lease tier. The bound is published instead.
- Agent-to-agent payment rails (x402, MPP, AP2). Buyer-side; the primitive settles to them later as
  sinks.
- Disputes as a product surface. The entries list is the evidence; a dispute UI is later.
- Seat-based SaaS packaging UI, internal FinOps chargeback, outcome-priced vertical agents as a
  target (section 4.9).

## 13. What has to change in the repo

| Gap (verified 2026-10-13) | Change |
| --- | --- |
| Entitlements require `featurePlanVersionId`; no grant without plan, provider, subscription | New `budgets` and `budget_entries` config tables keyed by project and subject, no FK to plan or subscription; hot entries live in the DO |
| `access.check` requires an Unprice customer id | Budgets and `authorize` key on `subject`; optional link to an Unprice customer |
| No public grant or top-up API | `budgets.fund` with sources `external`, `manual`, `promo`; wallet top-up later |
| `RunBudgetDO` calls Postgres and the wallet synchronously, expires in 24 h | Generalize into `BudgetDO`: persistent subjects, config pushed in, summary writes on the reporting queue, wallet capture only when `funding = wallet` |
| `usage.consume` drops price, remaining, `value_after` | Every budget response returns `remaining`, `funded`, `unfunded`, `priced` |
| No outbound webhooks | `webhook_endpoints`, `webhook_deliveries`, `WEBHOOK_QUEUE`, dispatcher Worker, HMAC signing |
| No model price catalog | `model_prices` plus a daily sync cron from models.dev with LiteLLM fallback; per-project overrides |
| AI SDK has no pre-call check or mid-stream cut-off and never throws on exhaustion | `unpriceBudget()` middleware on `authorize`/`settle`; configurable throw on deny |
| No outcome primitive | `outcomeTypes` and `outcomes.report` on the same DO lifecycle (later) |
| No local evaluation | `lease` and `report` on the DO and a Tier 2 SDK mode (later) |

Ownership follows ADR-0001: budget rules in a `budgets` service and use cases under
`internal/services/src/use-cases/budgets/`, routes thin under `apps/api/src/routes/budgets/`,
Zod contracts in `internal/db/src/validators/budgets.ts`, SDK generated from OpenAPI. Reporting
consumer, pipeline, lakehouse registry, and Tinybird datasources are reused, with a new lakehouse
event type for budget entries.

## 14. Risks and open questions

- **Two enforcement engines for a while.** `EntitlementWindowDO` stays for plan-funded
  entitlements until entitlements are re-expressed as budgets. Accept it; do not fork a third.
- **Stigg speed.** Stigg 2.0 hard limits could leave private beta any week. Defensible
  differences: open source, builder-owned subjects, published consistency bounds, measured latency,
  the ladder.
- **The free tier is the whole top of the funnel.** Revenue depends on the paying tier in
  section 4.3 being reachable through the lead list, not through Show HN.
- **The primitive itself is untested with buyers.** One solo founder and one OpenHands issue
  explicitly describe needing pre-authorization. Design partners from the paying tier are the test.
- **Agent-native is a bet.** Outcome and agent-run buyers are thin in the public record; credits
  and per-key caps are the observed demand. The first release serves both.
- **Builder-declared caps without prices** mean statements in budget-only mode are in the
  builder's unit. Correct, and it must be stated plainly.
- **Marketing truth.** The canon says the first integration is two calls (`signUp`, then
  `check`). With budgets it becomes `budgets.create` then the middleware. Update `docs/brand` when
  the primitive ships.
- **Compliance.** Subject ids should be opaque; `evidenceRef` is a pointer, never a payload; EU DO
  placement and the append-only entries plus the R2 audit record give the trail. Keep end-customer
  PII out of budgets, entries, and statements.

## 15. Sources

Sub-segments and voice: dev.to posts by Velobase (2026-06-25), Sayyed Amaan Ali (2026-07-12),
AIO Helper (2026-10-06), Cycles CTO (2026-03-18), Vapi voice-agent builder (2025-12-30); GitHub
issues openai-agents-python 2848 and 3353, langchain-ai/deepagents 6209, mastra 23242,
claude-agent-sdk-python 1024 and 1273, vercel/ai 21701, cloudflare/agents 1083, firecrawl-docs
PR 1416, integry/propr 2734, re-cinq/lore 2395, swenyai/sweny 449, AndreyBegma/AgentDock 28;
HN items 47362375 and 47787042; Exa, E2B, Tavily billing docs; Autumn Firecrawl (2026-09-03) and
AI billing infrastructure (2026-07-16) posts; Vercel AI Gateway API-key budgets (2026-06-09);
Anthropic Managed Agents budgets; npm download counts (api.npmjs.org, week of 2026-10-05) and
GitHub stars (2026-10-13); Datadog State of AI Engineering 2026; Vercel State of AI survey.

Persona and buyers: Schematic case studies (Zep 2025-05-15, Flashnet 2026-02-09, Syrto
2026-08-31, Pickleheads 2026-08-24, Plotly 2026-03-19); Stigg customers and Miro AI-credits post
(2026-06-02); Autumn "talking about billing with 30 YC founders" (2025-01-22), "how we made our
first sale" (2025-01-23), marketing and HN posts (2025-06), Firecrawl and T3 Chat posts (2026);
Lago Blacksmith (2026-04-06) and "monetization engineer" (2026-07-29); vendor pricing pages
(Stigg, Schematic, Autumn, 2026-10); HN threads 44365620, 46048252, 47933355, 46991656, 49949235;
job postings at Comfy (2026-09-12), Glean, LaunchDarkly, Supabase, Deepgram, Render, Relevance AI,
Replit, Perplexity (2026-04-24), Tavily, E2B (2026-09-22), Nebius (2026-07-06), Kong (2026-10-10);
Cursor spend-limit docs and forum (2026-03-24, 2026-06-10); OpenHands issue 5561 (2026-10-07);
Apify, fal, Ellipsis, Together, Replicate, Firecrawl, OpenRouter billing docs; Metronome AssemblyAI
vendor-selection post (2025-01-27); Bain per-seat pricing (2025-10-09); Growth Unhinged state of
B2B monetization (2026-05-13); FinOps Foundation Tokenomics (2026-06-03).

Market and outcome pricing: Intercom Fin outcomes; Zendesk automated-resolution tiers (2026-05-18)
and Relate 2026; Salesforce Help Agent (2026-06-25); Sierra Horizon (2026-07); Bessemer AI pricing
playbook (2026-02-10); Orb state of AI agent pricing 2026; ICONIQ state of AI 2026.

Budget primitives: Vercel AI Gateway budgets (2026-09-10); Cloudflare AI Gateway spend limits
(2026-06-05); OpenRouter limits; LiteLLM budgets, issue 27639 (2026-05-11), PR 33543; Anthropic
Managed Agents session budgets (2026-08-07); Stigg 2.0 governance (2026-06-30, 2026-07-09); Autumn
docs; Lago entitlements; OpenMeter and Kong.

Patterns: Google Doorman; Envoy rate limit quota filter; Cloudflare Workers rate limiting and
Durable Objects rules; Kong rate-limiting-advanced sync_rate; Stripe capture-later, multicapture,
overcapture, meter event adjustments; AWS Marketplace MeterUsage; SatGate macaroons; Lightning L402
for agents (2026-03-11); AAIF 402 Payment Required (2026-09-22); Cloudflare Monetization Gateway
beta (2026-09-30) and Wallets (2026-08-04); Claude Agent SDK hooks; OpenAI Agents SDK guardrails;
Mastra tool hooks (2026-07-14); Vercel AI SDK middleware; models.dev API; LiteLLM model prices JSON.

Developer pain: "Your AI spend cap probably has a race condition" (dev.to, 2026-07); "I stored AI
SaaS credits as a single integer" (dev.to, 2026-06); "Why we built our own credit ledger" (dev.to,
2026); Simon Willison, default hard budget caps (2026-10-03); TechCrunch "the token bill comes due"
(2026-06-05); Mandiant AI risk report coverage (2026-09-16); Zendesk community thread on disputed
resolutions (2025-08).

Repo facts: `apps/api/src/ingestion/run-budget/processor.ts`,
`apps/api/src/ingestion/entitlements/processor.ts`, `apps/api/src/ingestion/reporting/consumer.ts`,
`apps/api/src/ingestion/reporting/audit-record-publisher.ts`,
`apps/api/src/routes/entitlements/verifyV1.ts`, `internal/db/src/schema/entitlements.ts`,
`internal/services/src/use-cases/runs/start-run.ts`,
`internal/services/src/use-cases/payment-provider/availability.ts`, `internal/lakehouse/src`,
`packages/api/src/reservations.ts`, `packages/ai-sdk/src/index.ts`.
