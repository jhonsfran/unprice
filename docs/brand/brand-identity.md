# Unprice Brand Identity

Date: 2026-07-06

Status: pre-validation refresh (July 2026 market audit). Lock after the customer interviews in
`jobs-to-be-done.md`.

## Brand Core

Unprice is the open-source customer money path for usage-based SaaS. It helps developer-led teams
sell credits and usage-based plans without eating over-budget customer work: authorize in the
request path, explain on the invoice, and own the money logic in open source.

The wedge is customer spend authorization with invoice evidence: decide whether a customer's paid
work is commercially allowed before cost is created, and preserve the evidence needed to explain the
charge, credit, denial, or invoice line after the fact.

PriceOps means operating pricing as versioned commercial infrastructure — plan versions,
subscriptions, entitlements, meters, budgets, credits, usage evidence, and invoice evidence stay
separate but connected. Entitlements do not live inside a subscription blob; customers can stay on
the plan version they bought while new pricing experiments ship safely for future customers.

## What "Unprice" Means

Unprice does not mean removing price. It means un-hardcoding pricing: decoupling plan logic,
counters, and limits from application code and moving them into one inspectable runtime. You
"un-price" your codebase so pricing can change without a rewrite. The name signals control and
separation of pricing from product code, not the absence of pricing.

Reconciles with the Ruler archetype: order, control, and auditability over revenue logic.

### Name Risk And Disambiguation Rule

"Unprice" reads, on first contact, like "remove price" or "make it free" — the opposite of what the
product does. Treat this as a standing brand risk, not a solved problem. The name plus the coined
category ("PriceOps") are two new concepts at once, so every first touch must do the disambiguation
work immediately:

- Never show the wordmark cold. Pair it with the public frame ("open-source customer money path for
  usage-based SaaS") or the headline on first impression: homepage hero, OG cards, README, social
  avatars in context, conference slides.
- Let the bracket mark carry the meaning the word cannot. The brackets read as code containment —
  pricing pulled into one inspectable place, with the gated value held inside — which is exactly
  what "un-price your codebase" means.
- The first line of any cold surface should pre-empt the misread by stating the authorization and
  evidence promise, not by explaining the name. Explain the name only where there is room (about
  pages, docs, this doc).

## Positioning Statement

Canonical source: [`positioning-and-messaging.md`](positioning-and-messaging.md).

For developer-led usage-based SaaS teams — CTOs, founding engineers, and platform engineers — who
sell credits, usage, or hybrid plans, Unprice is the open-source customer money path that authorizes
customer spend in the request path: checking entitlement, customer budget, wallet credits, and meter
rules before work runs, then preserving the evidence that explains every allow, deny, charge,
credit, and invoice line.

Unlike billing platforms that rate and invoice after usage and are consolidating into payment
processors, AI gateways that cap provider cost, closed usage runtimes that cannot be inspected or
forked, and open-source billing engines that do not authorize in the request path, Unprice keeps
the customer spend decision, the double-entry ledger, and the invoice explanation in one open money
path you can read, fork, and run in your own account.

## Brand Promise

Customer spend you can authorize, explain, and change safely.

## Terminology

- "team", "builder", or "you" = the developer-led SaaS team using Unprice (the buyer).
- "customer" or "account" = that team's end customer, the economic actor that holds subscriptions,
  budgets, wallets, and invoices.
- Runs, jobs, workflows, tools, and agents = workload labels under a customer.

Never call the Unprice buyer "the customer." The buyer is the team or builder; the customer is the
buyer's economic actor.

## Brand Archetype

Primary: Sage. Unprice's enduring promise is understanding — help engineers see exactly why a
customer was allowed, blocked, charged, credited, or replayed. Sage is the trust and retention
layer.

Secondary: Ruler. The product is about control, order, auditability, and operational trust around
money-adjacent workflows.

Archetype division of labor (resolve the lead-message tension deliberately): the wedge leads with
Ruler energy — "authorize customer spend before paid work runs," "put a budget and evidence trail
around the expensive action," the bracket logo, the name's promise of control. Ruler opens because
the buying trigger is a loss of control over customer spend. Sage then carries the close: once
Unprice has made the customer money decision, its durable value is explaining and inspecting the
money path. So lead with Ruler authorization in the wedge, and win and retain on Sage explainability. The two are not in
conflict — control is exactly what Sage's evidence makes safe.

Avoid a Magician posture. Do not present billing as invisible magic. The product wins when it makes
the money path visible.

## Personality

- Precise: use exact nouns, states, and examples.
- Open: prefer inspectability, source evidence, and clear failure modes.
- Fast: emphasize request-path decisions and short developer paths.
- Calm: serious infrastructure, not hype. Calm urgency, not alarm: name the risk plainly and let
  the mechanism carry the weight.
- Opinionated: clear mental model around events, meters, entitlements, wallets, and invoices.

## Voice

Use direct engineering language. Prefer concrete outcomes over category adjectives.

Good:

- "Cap a customer run before it spends more credits."
- "Explain an invoice line from rated usage events."
- "Retry with the same idempotency key."
- "A run labels workload spend; the customer remains the economic actor."

Bad:

- "Unlock growth."
- "Billing made simple."
- "Magically monetize AI agents."
- "All-in-one revenue platform."

### Tone: Calm Urgency

The wedge is urgent (over-budget work runs before billing can catch it), but the brand is calm.
Resolve the tension by creating urgency with mechanism, not adjectives.

- Do: state the failure plainly. "Over-budget work runs before the invoice exists" is calm and
  urgent because it is literally true.
- Do: use concrete business terms once and precisely: customer budget, over-budget work, credits,
  margin.
- Avoid: stacked fear adjectives and hype ("catastrophic margin bleed", "explosive", "magical",
  "effortless"). Let the cost-before-invoice reality do the work.

## Messaging Pillars

Pillar order is the message hierarchy. Lead with customer spend authorization plus invoice evidence;
spend safety is the first concrete trigger, not the whole story. Keep this aligned with the message
hierarchy in `positioning-and-messaging.md`. 2026-07 refresh: spend safety (budgeted workloads)
holds second position and open, independent infrastructure moves ahead of the versioned model,
matching the canonical hierarchy.

### Customer Spend Authorization With Evidence (Wedge)

Usage-based products need a customer budget and credit decision before paid work creates cost, and
an evidence trail after that action becomes a charge, credit, denial, replay, or invoice line.

Proof points:

- Access checks and synchronous usage consumption.
- Invoice explanation from plan versions, billing periods, pricing rules, rated usage events when
  present, wallet movement, and ledger captures.
- Ingestion status and replay.

### Spend Safety For Expensive Workloads

AI/API products, workflow apps, and other usage-based products need to prevent a customer, job,
workflow, tool, or custom run from burning past the customer's plan, credits, or budget. Real-time
budgets reject over-budget work in the request path, before it runs.

Boundary, stated positively: not an agent platform — the budget, wallet, and authorization layer
for products whose customers burn credits, including when an agent triggers the spend.

Proof points:

- Budgeted runs with up-front wallet reservation.
- Workload attribution.
- Run-level budget rejection.

### Explainable Money Flow

Customers, engineers, and operators need evidence for why something was charged or blocked.

Proof points:

- Invoice charge explanation.
- Ingestion status and replay.
- Ledger-backed wallet balances and credit attribution.

### Open, Independent Money-Path Infrastructure

Revenue logic should not be trapped in a black box — or subject to a vendor's acquisition or
sunset (see the market context in `positioning-and-messaging.md`).

Proof points:

- Open-source codebase (AGPL-3.0 core plus a commercial license) you can read, fork, and run in
  your own Cloudflare account — or have your agent read — before you trust it.
- Double-entry wallet ledger.
- Explicit schemas for plans, plan versions, features, meters, entitlements, wallets, and runs.
- Generated SDK surface from OpenAPI contracts.

### Versioned PriceOps Model

Pricing experiments should not rewrite subscriptions or silently move existing customers.
Subscriptions, entitlements, plan versions, meters, budgets, credits, and invoices stay separate but
connected.

Proof points:

- Plan versions.
- Entitlements derived from published plan versions.
- Usage features with explicit meter configuration.

### Pricing Flexibility

Teams should change pricing models without rewriting the product request path.

Proof points:

- Plan versions.
- Flat, tier, package, and usage feature configuration.
- Meter configuration attached to usage features.

### Bring Your Own Payments

Unprice owns the customer money path; the payment provider still captures payment. Stripe-first
today, provider-extensible by design.

Proof points:

- Payment-provider abstraction.
- Stripe integration today.
- Provider model designed to extend to Paddle, Lemon Squeezy, and others.

## Claims Policy

Use only code-backed claims unless a benchmark, customer result, or integration test exists.

Allowed now:

- "Open-source customer money path for usage-based SaaS."
- "Authorize customer spend before paid work runs."
- "Explain every allow, deny, charge, credit, and invoice line from one money path."
- "Meter usage, enforce entitlements, reserve credits, budget workloads, and explain invoices."
- "Budgeted runs for agents, workflows, jobs, tools, and custom workloads."
- "Plan versions keep customers on the pricing they bought while new pricing experiments ship."
- "Stripe-first today, provider-extensible by design."
- "Designed for request-path usage enforcement."
- "AI gateways cap provider spend; Unprice governs customer spend and invoice evidence."
- "Wallet credits ride a double-entry ledger."
- "The money path is yours to read, fork, and run in your own Cloudflare account — it cannot be
  acquired out from under you."
- "Read the code that guards your money — or have your agent read it."
- "Every reserve, capture, refund, and settlement is a paired entry on an append-only,
  double-entry ledger."
- "Invoice lines are ledger projections — explain a charge from stored evidence, not a
  reconstruction."
- "Both gates say no; only a ledger proves why." (competitor contrast; see the Autumn discipline
  note below)

Avoid until proven:

- Exact latency claims such as "<100ms".
- Exact throughput claims such as "100k+ events/sec".
- Live Paddle, Lemon Squeezy, or Square integrations (the provider model is extensible by design,
  but Stripe is the only supported provider today).
- Enterprise revenue recognition, tax, or accounting replacement.
- "AI agent platform" or ownership of prompts, tools, memory, traces, or deployments.
- "Balances are never stored" or "balances are recomputed from entries on every read" — the
  ledger is append-only and entries pair by construction, but account balances are materialized
  running totals. Claim "append-only double-entry ledger," nothing stronger.
- Live Square support. The provider interface and capability table include Square scaffolding, but
  no adapter exists; shipped adapters are Stripe and the sandbox test double.

### Competitor Claim Discipline: Autumn (2026-07-06 Code Audit)

Autumn (useautumn/autumn) was source-code audited on 2026-07-06. Never claim it lacks:
request-path checks, atomic deduction, credit reservation (its lock/finalize primitive), spend
limits, plan versioning with pinned customers, or concurrency testing — the code shows all of
them, and a strawman burns trust with the exact engineer Unprice sells to. Contrast only on the
four code-verified differences owned by `positioning-and-messaging.md`: double-entry accounting vs
mutable balances, stored invoice explanation vs reconstruct-by-join, processor independence vs
Stripe-required persistence, and budgeted workload runs vs per-call locks. Re-verify all four
before each external use; their code moves fast.

## Vocabulary

Use:

- Authorize customer spend before paid work runs
- Prove every charge after it bills
- Spend safety
- Customer spend authorization
- Versioned PriceOps
- Open money-path infrastructure
- Customer money path
- Usage enforcement
- Budgeted runs
- Spend-safe metering
- Explainable usage billing
- Wallet credits
- Invoice evidence
- Entitlement decision
- Credit reservation (pre-authorization for paid work)
- Budget envelope
- Independent money path

Avoid:

- Growth platform
- Magic billing
- Stripe replacement
- No-code pricing
- AI agent monetization platform
- Revenue OS
- Effortless billing

## Visual Direction

The brand should feel like operational infrastructure, not a glossy SaaS template.

Signature visual (the one ownable idea): the money path. Render request -> plan version -> pricing
rule -> meter -> entitlement -> budget -> wallet -> ledger -> invoice as a literal, inspectable
flow, with customer spend authorization and invoice explanation as the hero moments. Reuse it as
the recurring system across hero, docs, empty states, and explainers. The brand's distinctiveness is
legibility of real state — product state, monospace facts, and the money-path diagram — not
decoration or a color trick. This is what keeps Unprice from looking like a generic dev-tool
template.

Use:

- Neutral surfaces and high-legibility text.
- Semantic status colors: green for accepted, orange for warning, red for blocked or failed, blue
  for live request paths. Amber is the brand/`primary` accent, not a status color.
- Elevation as material (2026-07-08): the page is a desk, panels are receipts lying on it — three
  surface tiers, tight contact shadows in light, lit top edges in dark. Tokens and laws in
  `design-tokens.md`.
- Ledger paper: the faint dot grid, hairline rails, and `+` registration marks — the receipt
  vocabulary at page scale.
- Dense but calm layouts with clear groupings.
- Monospace accents for IDs, slugs, event names, run IDs, amounts, and ledger facts. The mono is
  where the brand voice lives — every fact the product asserts renders in it.
- Display type that is bigger and *lighter* (Geist variable weight ≈540), with two-tone
  muted-to-ink emphasis. Boldness comes from the concept, never from heavier type.
- Diagrams that connect request, pricing, entitlement, budget, wallet, and invoice.
- Version markers when a pricing decision depends on a specific plan version.

Avoid:

- Decorative gradient blobs.
- Abstract "growth" dashboards.
- Overly dark cyberpunk visuals.
- Purple-dominant AI styling.
- Illustrations that hide product state instead of explaining it.

The avoid list is also a competitive moat (2026-07-06): Autumn — the closest competitor — brands
in dark cyberpunk purple, pixel-dither texture, and code-comment section labels. Every purple
gradient or dithered panel now reads as "another Autumn." The counter-position is receipt-grade
legibility: neutral surfaces, monospace money facts, semantic status color, and the money path
rendered literally. Look like financial infrastructure, not an AI-era dev tool — the aesthetic is
the trust argument.

Typeface stance (2026-07-09, from the measured Linear/Dub/Autumn teardown): Geist + Geist Mono
stay. The 2026-07 glow-up proved the typeface was never the weakness — the same Geist reads
world-class once the display scale runs bigger-and-lighter (weight ≈540) instead of small-and-
extrabold. Two facts to hold together: (1) Autumn ships the *identical* Geist/Geist Mono stack,
so the typeface cannot carry differentiation — the warm sand ground, amber scarcity, and receipt
grammar do; (2) because the mono renders every fact the brand asserts, the mono is the voice. If
one typographic investment is ever made, it is replacing Geist Mono with a licensed characterful
mono (e.g. Berkeley Mono) — a deliberate, doc-first decision, not a drive-by. Never swap the sans
by reflex; identity-preservation wins.

What the references are for (2026-07-09): Linear renders *momentum*, Dub renders *growth*, Autumn
renders *hacker energy* — Unprice renders *evidence*. Steal light from them (surface tiers, motion
tokens, one loud button, numbered indices), never temperament (pills, blue-black neutrals, curved
notches, icon-tile eyebrows, neon). The full teardown with measurements lives in the 2026-07-08
decision-log entry of `design-tokens.md`.

## Brand Experience Rules

Every important screen or page should answer at least one of these questions:

- What happened?
- Who did it affect?
- Was it allowed, denied, accepted, replayed, captured, or invoiced?
- What customer budget, limit, or wallet balance was involved?
- What should the operator or developer do next?

If a screen cannot answer one of those questions, it is probably decoration or premature surface
area.
