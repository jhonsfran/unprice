# Jobs To Be Done

Date: 2026-06-30

This document translates the Unprice brand and product positioning into Jobs-to-Be-Done language.
Use it when creating marketing campaigns, reviewing page copy, writing launch content, or checking
whether a message speaks to the real switching moment.

## Evidence Base

Source: internal brand docs plus founder clarification on 2026-06-30.

Inputs:

- [`PRODUCT.md`](PRODUCT.md)
- [`brand-identity.md`](brand-identity.md)
- [`positioning-and-messaging.md`](positioning-and-messaging.md)
- [`design-system-guidelines.md`](design-system-guidelines.md)

Evidence limits:

- Treat this as internal positioning, not customer research.
- Do not write or imply customer quotes until real interviews, support threads, or sales calls are
  available.
- The sharpest current trigger is cost spikes from expensive AI/API usage.
- The measurable outcome to emphasize is preventing runaway usage above the customer budget.

## Core Job

When a developer-led AI/API SaaS product has expensive per-request usage and customer-level budgets,
the team wants to enforce usage, budgets, credits, and invoice evidence at runtime so it can stop
over-budget work before it costs money and explain every charge from the same usage trail.

## Job Statement

When my AI/API SaaS product risks runaway usage above a customer budget, I want to meter the event,
check entitlement, check budget, reserve or capture credits, and preserve invoice evidence in the
request path, so I can protect gross margin and show why a request was allowed, denied, charged, or
replayed.

## Primary Actor

Best-fit early actors:

- CTOs, founding engineers, heads of platform, and product engineers.
- Developer-led SaaS teams with 5-50 employees, Seed to Series A.
- B2B SaaS, API, infrastructure, automation, data, or AI products where usage affects gross margin.
- Engineering teams that own billing, metering, entitlements, or request-path usage enforcement.

The customer account is the economic actor. Runs, jobs, workflows, tools, and agents are workload
labels that help control and explain spend.

## Trigger Events

Primary trigger:

- AI or API costs spike because a customer, job, workflow, tool, agent, or custom workload overuses
  the product.

Secondary triggers:

- A new usage-based pricing model is blocked by hardcoded plan logic.
- The team needs credits, prepaid balances, or per-run spend caps.
- Support cannot explain a disputed invoice line.
- A customer wants usage limits before signing a larger contract.

## Current Workaround

Teams usually combine:

- Stripe for invoices.
- Custom usage tables.
- Redis or database counters for limits.
- Cron jobs for billing reconciliation.
- Manual debugging when customers dispute usage.
- Hardcoded plan logic inside product code.

What hurts: the money path is split across tools and code paths, so the team cannot reliably stop
expensive work before it runs or explain a charge from one inspectable trail.

## Desired Outcome

The customer or workload cannot spend above its configured budget unless the team explicitly allows
it.

A successful implementation should let the team:

- Reject over-budget calls before they create cost.
- Change packaging without rewriting the application money path.
- Explain invoice lines from rated usage events, ledger captures, and wallet movements.
- Distinguish wallet credits, entitlement grants, usage quantities, and invoices.
- Recover from ingestion failures with evidence and replay paths.

## Switch Forces

### Push

The current setup combines billing tools, usage tables, counters, cron reconciliation, and manual
support debugging. It does not give enough runtime control when usage can create real cost before
the billing cycle ends.

### Pull

Unprice connects product requests, meter events, entitlement decisions, budget checks, wallet
movements, ingestion state, and invoice evidence in one inspectable runtime system.

### Habit

Teams already have Stripe, custom counters, billing scripts, and plan logic embedded in product
code. These pieces may work well enough until a cost spike, pricing change, or invoice dispute
forces the team to trace the full money path.

### Anxiety

A prospect may worry about putting money decisions in the request path, relying on a young
open-source billing-adjacent system, moving logic out of familiar Stripe-centered workflows, or
depending on latency and throughput claims that have not been proven for their workload.

## Before And After

Before:

- Pricing behavior lives in multiple places.
- Cost spikes are discovered after usage already happened.
- Support or engineering reconstructs invoice disputes by hand.
- Packaging changes require edits across application code, billing code, and reconciliation jobs.

After:

- Runtime checks decide whether expensive work is allowed before it runs.
- Budgets and wallet credits constrain customer or workload spend.
- Invoice explanations connect back to usage and ledger evidence.
- Engineers can change pricing models while keeping one request-path money model.

## Functional Needs

Unprice must help teams:

- Meter usage events.
- Enforce entitlements before expensive work runs.
- Start, consume, end, and inspect budgeted runs.
- Reserve and capture wallet credits.
- Keep failed, rejected, processed, and replayed ingestion states visible.
- Explain invoices from pricing rules, usage quantity, rated facts, ledger captures, and event
  evidence.

## Emotional Needs

The product should help founders and engineers feel:

- In control of usage cost before it becomes invoice damage.
- Clear about why a request was allowed, denied, charged, credited, or replayed.
- Confident enough to offer usage pricing and customer budgets without scattering money logic
  through product code.

## Campaign Angles

Lead campaigns with the primary trigger: expensive AI/API usage can cross a customer budget before
the team notices.

Strong angles:

- Stop runaway usage before it hits margin.
- Put a budget around the expensive action in your product.
- Your Redis counter is not a budget: request-path enforcement beats a homegrown pre-check.
- Pricing is a runtime decision for usage-based SaaS.
- Explain every usage invoice line from event evidence.
- Move usage, entitlements, credits, and invoices into one inspectable money path.

Weak angles:

- A broad billing platform.
- A generic pricing page builder.
- A Stripe replacement.
- An AI agent platform.
- A no-code monetization tool.
- An enterprise revenue recognition, tax, or accounting suite.

## Copy Review Checklist

Use this checklist when reviewing homepage, landing page, launch, ad, docs, or sales copy.

- Does the copy name the actor: developer-led AI/API SaaS teams, CTOs, founding engineers, platform
  engineers, or product engineers?
- Does the first screen make runtime spend control visible?
- Does the message lead with the cost-spike trigger or another explicit trigger from this document?
- Does the copy connect request, meter, entitlement, budget, wallet, and invoice evidence?
- Does it show that Unprice stops over-budget work before cost is created?
- Does it explain why open source matters: inspectable revenue logic and clear failure paths?
- Does it avoid broad billing-platform, tax, and accounting claims, and avoid claiming live
  multi-provider payments (Stripe-first today, provider-extensible by design is fine)?
- Does it avoid presenting Unprice as an AI agent platform?
- Does every claim have product evidence from `PRODUCT.md`, `brand-identity.md`,
  `positioning-and-messaging.md`, or implemented behavior?
- Does the call to action ask the prospect to identify the expensive product action and put a
  customer budget around it?

## Message Mapping

| Buyer question | Answer to emphasize |
| --- | --- |
| Why now? | Usage cost can spike before the billing cycle ends. Runtime enforcement prevents customer or workload spend from exceeding budget. |
| Why not just Stripe? | Stripe captures the payment; Unprice owns the runtime money path — usage, budgets, credits, and invoice evidence — inside the product request path. Stripe-first today, provider-extensible by design. |
| Why open source? | Revenue logic should be inspectable when it allows, denies, charges, credits, or replays customer activity. |
| What is the first demo? | Pick the expensive action, meter it, put a customer budget around it, reject over-budget calls, and show invoice evidence from the same stream. |
| What should not be promised? | Do not promise live multi-provider payments (Stripe-first today; provider-extensible by design is fine), tax, accounting, enterprise revenue recognition, exact latency, or exact throughput without proof. |

## Validation Plan (P0 — validate before scaling spend)

The positioning rests on one unproven bet: that buyers feel "reject over-budget work before it runs"
as acute pain, not just "rate it accurately after." Validate this before committing GTM spend or
treating the "only Unprice" claim as proven.

Targets: 8-12 in-ICP engineering owners (CTOs, founding engineers, platform/product engineers) at
developer-led AI/API SaaS teams (5-50 people, Seed to Series A) with usage that affects gross margin.
Recruit from inbound, design partners, and warm dev-community intros — not a broad survey.

Falsify the wedge. Ask for the last time usage created cost they wished they had blocked. Listen for
whether they tried to stop it in the request path or only discovered it on the invoice. If teams
consistently say post-hoc rating is "good enough," the wedge is weaker than assumed and the lead
should shift toward explainability or pricing flexibility.

Phrase test. Show the same hero three ways and measure comprehension and "this is for me" response:

1. "Stop runaway usage before it runs." (runaway-usage frame)
2. "Put a customer budget around your most expensive action." (customer-budget frame)
3. "Pricing is a runtime decision." (runtime-control frame)

Pick the lead phrase from evidence, then make it canonical in `positioning-and-messaging.md`.

Name and category check. Confirm whether buyers misread "Unprice" as "remove price / free" and
whether "PriceOps" lands or needs the DevOps/FinOps analogy every time. Feed results into the name
disambiguation rule in `brand-identity.md`.

Outcome to capture. One real, attributable quote on the cost-spike trigger, and one quantified
outcome (cost avoided, invoice-debugging time saved, or time-to-launch usage pricing).

## Open Questions

These are resolved by running the Validation Plan above:

- Collect one real customer or founder quote that captures the cost-spike trigger.
- Quantify the strongest outcome once evidence exists, for example cost avoided, invoice-debugging
  time saved, or time to launch usage pricing.
- Validate whether the primary beachhead responds better to "runaway usage", "customer budgets",
  or "runtime pricing control" as the first phrase in campaign copy.
