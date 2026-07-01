# Unprice Brand Identity

Date: 2026-07-01

## Brand Core

Unprice is open-source PriceOps infrastructure for usage-based SaaS. It helps developer-led teams
authorize paid usage before it runs, then explain why every event was allowed, denied, charged,
credited, or invoiced from the same money path.

The wedge is commercial authorization with evidence: decide whether paid usage is commercially
allowed before cost is created, and preserve the evidence needed to explain the charge or denial
after the fact.

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

- Never show the wordmark cold. Pair it with the category line ("open-source PriceOps infrastructure
  for usage-based SaaS") or the headline on first impression: homepage hero, OG cards, README,
  social avatars in context, conference slides.
- Let the bracket mark carry the meaning the word cannot. The brackets read as code containment —
  pricing pulled into one inspectable place, with the gated value held inside — which is exactly
  what "un-price your codebase" means.
- The first line of any cold surface should pre-empt the misread by stating the authorization and
  evidence promise, not by explaining the name. Explain the name only where there is room (about
  pages, docs, this doc).

## Positioning Statement

Canonical source: [`positioning-and-messaging.md`](positioning-and-messaging.md).

For developer-led usage-based SaaS teams — CTOs, founding engineers, and platform engineers — who
ship paid product actions that can create cost before the invoice exists, Unprice is the open-source
PriceOps runtime that authorizes usage in the request path: checking entitlement, budget, credits,
and meter rules before work runs, then preserving the evidence that explains every allow, deny,
charge, credit, and invoice line from one inspectable money path.

Unlike billing platforms that primarily rate, invoice, and collect after usage, entitlement layers
that gate access, or workflow and AI infrastructure that runs the work, Unprice ties the commercial
decision and the after-the-fact explanation together in one open money path.

## Brand Promise

Paid usage you can authorize, explain, and change safely.

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
Ruler energy — "authorize paid usage before it runs," "put a budget and evidence trail around the
expensive action," the bracket logo, the name's promise of control. Ruler opens because the buying
trigger is a loss of control over paid usage. Sage then carries the close: once Unprice has made the
commercial decision, its durable value is explaining and inspecting the money path. So lead with
Ruler authorization in the wedge, and win and retain on Sage explainability. The two are not in
conflict — control is exactly what Sage's evidence makes safe.

Avoid a Magician posture. Do not present billing as invisible magic. The product wins when it makes
the money path visible.

## Personality

- Precise: use exact nouns, states, and examples.
- Open: prefer inspectability, source evidence, and clear failure modes.
- Fast: emphasize runtime decisions and short developer paths.
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
- Do: use concrete business terms once and precisely: runaway usage, over-budget, margin.
- Avoid: stacked fear adjectives and hype ("catastrophic margin bleed", "explosive", "magical",
  "effortless"). Let the cost-before-invoice reality do the work.

## Messaging Pillars

Pillar order is the message hierarchy. Lead with commercial authorization plus evidence; spend
safety is the first concrete wedge, not the whole story. Keep this aligned with the message
hierarchy in `positioning-and-messaging.md`.

### Commercial Authorization With Evidence (Wedge)

Usage-based products need a commercial decision before a paid action creates cost, and an evidence
trail after that action becomes a charge, credit, denial, replay, or invoice line.

Proof points:

- Access checks and synchronous usage consumption.
- Invoice explanation from plan versions, billing periods, pricing rules, rated usage events when
  present, wallet movement, and ledger captures.
- Ingestion status and replay.

### Spend Safety For Expensive Workloads

AI/API products, workflow apps, and other usage-based products need to prevent a customer, job,
workflow, tool, or custom run from turning into uncapped cost. Real-time budgets reject over-budget
work in the request path, before it runs.

Proof points:

- Budgeted runs.
- Workload attribution.
- Run-level budget rejection.

### Versioned PriceOps Model

Pricing experiments should not rewrite subscriptions or silently move existing customers.
Subscriptions, entitlements, plan versions, meters, budgets, credits, and invoices stay separate but
connected.

Proof points:

- Plan versions.
- Entitlements derived from published plan versions.
- Usage features with explicit meter configuration.

### Explainable Money Flow

Customers, engineers, and operators need evidence for why something was charged or blocked.

Proof points:

- Invoice charge explanation.
- Ingestion status and replay.
- Ledger-backed wallet balances and credit attribution.

### Open PriceOps Infrastructure

Revenue logic should not be trapped in a black box.

Proof points:

- Open-source codebase (AGPL-3.0 core plus a commercial license).
- Explicit schemas for plans, plan versions, features, meters, entitlements, wallets, and runs.
- Generated SDK surface from OpenAPI contracts.

### Pricing Flexibility

Teams should change pricing models without rewriting the product request path.

Proof points:

- Plan versions.
- Flat, tier, package, and usage feature configuration.
- Meter configuration attached to usage features.

### Bring Your Own Payments

Unprice owns the runtime money path; the payment provider still captures payment. Stripe-first
today, provider-extensible by design.

Proof points:

- Payment-provider abstraction.
- Stripe integration today.
- Provider model designed to extend to Paddle, Lemon Squeezy, and others.

## Claims Policy

Use only code-backed claims unless a benchmark, customer result, or integration test exists.

Allowed now:

- "Open-source PriceOps infrastructure."
- "Authorize paid usage before it runs."
- "Explain every allow, deny, charge, credit, and invoice line from one money path."
- "Meter usage, enforce entitlements, reserve credits, budget workloads, and explain invoices."
- "Budgeted runs for agents, workflows, jobs, tools, and custom workloads."
- "Plan versions keep customers on the pricing they bought while new pricing experiments ship."
- "Stripe-first today, provider-extensible by design."
- "Designed for request-path usage enforcement."

Avoid until proven:

- Exact latency claims such as "<100ms".
- Exact throughput claims such as "100k+ events/sec".
- Live Paddle, Lemon Squeezy, or Square integrations (the provider model is extensible by design,
  but Stripe is the only supported provider today).
- Enterprise revenue recognition, tax, or accounting replacement.
- "AI agent platform" or ownership of prompts, tools, memory, traces, or deployments.

## Vocabulary

Use:

- Authorize paid usage before it runs
- Prove every charge after it bills
- Spend safety
- Commercial authorization
- Versioned PriceOps
- Open PriceOps infrastructure
- Usage enforcement
- Budgeted runs
- Spend-safe metering
- Explainable usage billing
- Wallet credits
- Invoice evidence
- Entitlement decision

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
flow, with the authorization decision and the invoice explanation as the hero moments. Reuse it as
the recurring system across hero, docs, empty states, and explainers. The brand's distinctiveness is
legibility of real state — product state, monospace facts, and the money-path diagram — not
decoration or a color trick. This is what keeps Unprice from looking like a generic dev-tool
template.

Use:

- Neutral surfaces and high-legibility text.
- Semantic status colors: green for accepted, orange for warning, red for blocked or failed, blue
  for live request paths. Amber is the brand/`primary` accent, not a status color.
- Dense but calm layouts with clear groupings.
- Monospace accents for IDs, slugs, event names, run IDs, amounts, and ledger facts.
- Diagrams that connect request, pricing, entitlement, budget, wallet, and invoice.
- Version markers when a pricing decision depends on a specific plan version.

Avoid:

- Decorative gradient blobs.
- Abstract "growth" dashboards.
- Overly dark cyberpunk visuals.
- Purple-dominant AI styling.
- Illustrations that hide product state instead of explaining it.

## Brand Experience Rules

Every important screen or page should answer at least one of these questions:

- What happened?
- Who did it affect?
- Was it allowed, denied, accepted, replayed, captured, or invoiced?
- What limit, budget, or wallet balance was involved?
- What should the operator or developer do next?

If a screen cannot answer one of those questions, it is probably decoration or premature surface
area.
