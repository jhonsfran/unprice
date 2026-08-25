# AI-first positioning design

Date: 2026-08-25

Status: approved direction, pending written-spec review

## Objective

Position Unprice for developer-led AI products that sell credits, agent runs, and paid workflows.
Lead with the commercial outcome: teams can sell AI usage without paying for unfunded customer work.
Use request-to-invoice authorization as the product's distinct mechanism.

This is a positioning change, not a product-boundary change. Unprice remains useful for non-AI
usage-based products, but public marketing leads with the AI use case.

## Audience

The primary buyer is a CTO, founding engineer, or platform engineer at an AI product company. The
company sells prepaid credits, metered AI usage, agent runs, or workflows that create marginal cost.

The buyer has two connected problems:

- A customer can start an agent or workflow that costs more than the customer's remaining credits
  or budget.
- Billing records usage after the work runs, so the team cannot connect the original commercial
  decision to the later charge without reconstructing it from logs.

## Public category

Canonical category line:

> Open-source billing for AI credits and agent usage.

The existing phrase "customer money path" remains available as the name for the connected product
mechanism. It should not be the first category phrase a cold visitor must decode.

## Hero

Canonical headline:

> Sell AI credits and usage. Keep the margin.

Canonical subheadline:

> Authorize every agent run and paid workflow before it creates cost. Reserve customer credits up
> front, then trace the decision through usage and the invoice.

Primary CTA:

> Start with one paid action

The CTA remains unchanged because it gives the buyer a small first step and matches the existing
one-afternoon offer.

## Positioning statement

For developer-led AI products that sell credits, agent runs, or paid workflows, Unprice is the
open-source billing system that authorizes customer spend before work runs and traces accepted usage
to the invoice. AI gateways control what the team spends with model providers. Unprice controls
what each end customer may spend with the AI product.

## Message hierarchy

1. Sell AI credits and usage.
2. Stop unfunded agent work before it creates cost.
3. Give agents and workflows explicit customer budgets.
4. Trace each invoice line to the decision that allowed the work.
5. Keep the runtime open source and payments in the buyer's Stripe account.

The landing page must not state all five messages in the hero. The hero owns the outcome and the
mechanism. Later sections supply proof, adoption steps, objections, and the offer.

## Request-to-invoice narrative

The product story follows one ordered commercial path:

```text
customer request
      ↓
authorize plan, credits, and budget
      ↓
agent or workflow runs
      ↓
settle actual usage
      ↓
invoice line traces to the authorization
```

Use the line "Every AI charge starts with an authorization" as the narrative bridge below the
hero. Do not say "the authorization is the invoice." Authorization precedes usage and settlement.
The invoice records settled usage and links it to the decision that allowed the work.

## Competitive contrast

AI gateways control the buyer's provider spend, model routing, and virtual keys. Unprice controls
what the buyer's customer may spend and connects that decision to credits, usage, and invoice
evidence.

Stripe captures payment. Unprice authorizes the customer spend that happens before payment capture
and keeps the evidence needed for the invoice.

After-the-fact metering records what happened. Unprice can reserve credits or budget before the
work runs, then settle the actual usage.

## Product boundary

Unprice is not an agent platform, model gateway, orchestration system, payment processor, tax
engine, or accounting system.

Agents, tools, jobs, and workflows are billable workloads under a customer account. The customer
remains the economic owner of credits, budgets, subscriptions, and invoices. Unprice owns the
commercial decision and its evidence. It does not own agent execution.

## Vocabulary

Lead with these terms:

- AI credits
- agent run
- paid workflow
- customer budget
- authorize before work runs
- reserve credits
- settle actual usage
- invoice evidence

Use "usage-based SaaS," "customer money path," and "PriceOps" after the reader understands the AI
billing problem. Do not add "AI" to copy that describes a product fact with no AI-specific meaning.

## Surface rollout

Update canonical sources before dependent copy:

1. `docs/brand/strategic/positioning-and-messaging.md`
2. `docs/brand/PRODUCT.md`
3. `docs/brand/README.md`
4. `docs/brand/brand-narrative.md`
5. `docs/brand/language-and-vocabulary.md`
6. `docs/brand/jobs-to-be-done.md`
7. `docs/brand/marketing-framework.md`

Then update public surfaces:

- landing hero and the authorization-to-invoice narrative
- landing problem, mechanism, demo, FAQ, and offer copy where the AI-first frame changes context
- page title, description, Open Graph card, and footer copy
- root README and package descriptions
- docs homepage and public concept introductions
- manifesto copy

Historical ADRs, completed implementation plans, changelogs, and dated research records stay
unchanged.

## Acceptance criteria

A visitor should answer these questions from the first screen:

- Who is it for? AI products that sell credits, agent runs, or paid workflows.
- What does it do? It authorizes customer spend before work creates cost.
- Why does that matter? The team keeps its margin and can explain the later invoice.

The completed rollout must also satisfy these checks:

- The canonical headline, subheadline, category, and positioning statement agree across brand
  sources and public surfaces.
- AI gateways remain clearly separate from customer spend authorization.
- The copy never presents Unprice as an agent platform.
- The request-to-invoice sequence remains technically accurate: authorize, run, settle, invoice.
- No latency, savings, customer, or conversion claims are added without evidence.
- The existing primary CTA and one-afternoon offer remain intact.

## Out of scope

- Product behavior, API, schema, or pricing changes
- A visual redesign of the landing page
- New agent orchestration or model-gateway features
- Changes to the payment-provider boundary
- New testimonials, metrics, or competitive claims
