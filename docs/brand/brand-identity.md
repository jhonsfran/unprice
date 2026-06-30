# Unprice Brand Identity

Date: 2026-06-30

## Brand Core

Unprice is open-source PriceOps infrastructure for usage-based SaaS. It helps developer-led teams
meter usage, enforce entitlements, reserve credits, cap expensive workloads, and explain invoices
without hardcoding revenue logic into product code.

## Positioning Statement

For developer-led SaaS and AI/API teams who need pricing flexibility without runaway usage cost,
Unprice is an open-source PriceOps runtime that turns product events into access decisions, budget
controls, wallet movements, and invoice evidence.

Unlike broad billing platforms or black-box metering vendors, Unprice is built around the request
path: price, meter, gate, budget, and invoice usage from one inspectable system.

## Brand Promise

Revenue logic you can inspect, enforce, and change safely.

## Brand Archetype

Primary: Sage. Unprice should help engineers understand exactly why a customer was allowed,
blocked, charged, credited, or replayed.

Secondary: Ruler. The product is about control, order, auditability, and operational trust around
money-adjacent workflows.

Avoid a Magician posture. Do not present billing as invisible magic. The product wins when it makes
the money path visible.

## Personality

- Precise: use exact nouns, states, and examples.
- Open: prefer inspectability, source evidence, and clear failure modes.
- Fast: emphasize runtime decisions and short developer paths.
- Calm: serious infrastructure, not hype.
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

## Messaging Pillars

### Runtime Control

Pricing is not only a billing-cycle calculation. For usage-based products, pricing is a runtime
decision.

Proof points:

- Access checks and synchronous usage consumption.
- Budgeted runs with remaining spend and allow/deny decisions.
- Wallet reservations before usage is captured.

### Explainable Money Flow

Customers, engineers, and operators need evidence for why something was charged or blocked.

Proof points:

- Invoice charge explanation.
- Ingestion status and replay.
- Ledger-backed wallet balances and credit attribution.

### Open PriceOps Infrastructure

Revenue logic should not be trapped in a black box.

Proof points:

- Open-source codebase.
- Explicit schemas for features, meters, entitlements, wallets, and runs.
- Generated SDK surface from OpenAPI contracts.

### Pricing Flexibility

Teams should change pricing models without rewriting the product request path.

Proof points:

- Plan versions.
- Flat, tier, package, and usage feature configuration.
- Meter configuration attached to usage features.

### Spend Safety For Expensive Workloads

AI/API products need to prevent a customer, job, workflow, tool, or custom run from turning into
uncapped cost.

Proof points:

- Budgeted runs.
- Workload attribution.
- Run-level budget rejection.

## Claims Policy

Use only code-backed claims unless a benchmark, customer result, or integration test exists.

Allowed now:

- "Open-source PriceOps infrastructure."
- "Meter usage, enforce entitlements, reserve credits, and explain invoices."
- "Budgeted runs for agents, workflows, jobs, tools, and custom workloads."
- "Stripe-first payment-provider integration."
- "Designed for request-path usage enforcement."

Avoid until proven:

- Exact latency claims such as "<100ms".
- Exact throughput claims such as "100k+ events/sec".
- Broad provider freedom across Stripe, Paddle, Square, and others.
- Enterprise revenue recognition, tax, or accounting replacement.
- "AI agent platform" or ownership of prompts, tools, memory, traces, or deployments.

## Vocabulary

Use:

- Runtime pricing control
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

Use:

- Neutral surfaces and high-legibility text.
- Semantic status colors: green for accepted, amber for warning, red for blocked or failed, blue
  or cyan for live request paths.
- Dense but calm layouts with clear groupings.
- Monospace accents for IDs, slugs, event names, run IDs, amounts, and ledger facts.
- Diagrams that connect request, pricing, entitlement, budget, wallet, and invoice.

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
