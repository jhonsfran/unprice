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
- The sharpest current trigger is still cost spikes from expensive AI/API/workflow usage.
- The broader job is commercial authorization plus evidence: decide before paid usage runs, then
  explain the charge, credit, denial, or invoice line after.
- The measurable outcomes to emphasize are cost avoided, invoice-debugging time reduced, and pricing
  changes shipped without moving existing customers off their plan versions.

## Core Job

When a developer-led usage-based SaaS product has paid actions that create cost or invoice
complexity, the team wants to authorize usage, budgets, credits, and entitlements at runtime so it
can decide before work runs and explain every charge from the same usage trail.

## Job Statement

When my usage-based SaaS product has paid actions that can create cost or customer confusion, I want
to meter the event, check entitlement, check budget, reserve or capture credits, apply the correct
plan version, and preserve invoice evidence in the request path, so I can show why a request was
allowed, denied, charged, credited, or replayed.

## Primary Actor

Best-fit early actors:

- CTOs, founding engineers, heads of platform, and product engineers.
- Developer-led SaaS teams with 5-50 employees, Seed to Series A.
- B2B SaaS, API, infrastructure, automation, data, or AI products where usage affects gross margin.
- Engineering teams that own billing, metering, entitlements, plan versions, or request-path
  commercial authorization.

The customer account is the economic actor. Runs, jobs, workflows, tools, and agents are workload
labels that help control and explain spend.

## Trigger Events

Primary trigger:

- A paid customer action creates cost or an invoice outcome before the team can explain it.

Secondary triggers:

- A new usage-based pricing model is blocked by hardcoded plan logic.
- The team needs credits, prepaid balances, or per-run spend caps.
- Support cannot explain a disputed invoice line.
- The team wants pricing experiments without moving existing customers off the plan version they
  bought.
- A customer wants usage limits before signing a larger contract.

## Current Workaround

Teams usually combine:

- Stripe for invoices.
- Custom usage tables.
- Redis or database counters for limits.
- Cron jobs for billing reconciliation.
- Manual debugging when customers dispute usage.
- Hardcoded plan logic inside product code.

What hurts: the money path is split across tools and code paths, so the team cannot reliably decide
whether paid usage should run, keep existing customers on the right plan version, or explain a
charge from one inspectable trail.

## Desired Outcome

Every paid action is commercially authorized before it runs, and every charge or denial can be
explained after the fact.

A successful implementation should let the team:

- Authorize or deny paid usage before it creates cost.
- Change packaging without rewriting the application money path.
- Keep customers pinned to the plan version they bought while new pricing experiments ship.
- Explain invoice lines from rated usage events, ledger captures, and wallet movements.
- Distinguish wallet credits, entitlement grants, usage quantities, and invoices.
- Recover from ingestion failures with evidence and replay paths.

## Switch Forces

### Push

The current setup combines billing tools, usage tables, counters, cron reconciliation, and manual
support debugging. It does not give enough runtime control or after-the-fact evidence when usage can
create real cost before the billing cycle ends.

### Pull

Unprice connects product requests, plan versions, meter events, entitlement decisions, budget
checks, wallet movements, ingestion state, and invoice evidence in one inspectable runtime system.

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

- Runtime checks decide whether paid work is commercially allowed before it runs.
- Budgets and wallet credits constrain customer or workload spend.
- Invoice explanations connect back to usage and ledger evidence.
- Engineers can change pricing models while existing customers stay on their plan versions.

## Functional Needs

Unprice must help teams:

- Meter usage events.
- Enforce entitlements before expensive work runs.
- Start, consume, end, and inspect budgeted runs.
- Reserve and capture wallet credits.
- Keep subscriptions, entitlements, and plan versions separate but connected.
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

Lead campaigns with the primary trigger: a paid action can create cost or invoice confusion before
the team notices. Narrow to expensive AI/API/workflow usage when the audience needs a concrete
example.

Strong angles:

- Authorize paid usage before it runs.
- Prove every charge after it bills.
- Put a budget and evidence trail around the expensive action in your product.
- Your Redis counter is not a budget: request-path enforcement beats a homegrown pre-check.
- Pricing is a runtime decision and an evidence trail for usage-based SaaS.
- Explain every usage invoice line from event evidence.
- Keep entitlements separate from subscriptions so pricing experiments do not rewrite existing
  customers.
- Move usage, entitlements, credits, plan versions, and invoices into one inspectable money path.

Weak angles:

- A broad billing platform.
- A generic pricing page builder.
- A Stripe replacement.
- An AI agent platform.
- A no-code monetization tool.
- An enterprise revenue recognition, tax, or accounting suite.

## Copy Review Checklist

Use this checklist when reviewing homepage, landing page, launch, ad, docs, or sales copy.

- Does the copy name the actor: developer-led usage-based SaaS teams, CTOs, founding engineers,
  platform engineers, or product engineers?
- Does the first screen make commercial authorization or invoice explanation visible?
- Does the message lead with a paid-action trigger, cost-spike trigger, invoice-dispute trigger, or
  pricing-experiment trigger from this document?
- Does the copy connect request, meter, entitlement, budget, wallet, plan version, and invoice
  evidence?
- Does it show that Unprice authorizes paid usage before cost is created?
- Does it explain why open source matters: inspectable revenue logic and clear failure paths?
- Does it avoid broad billing-platform, tax, and accounting claims, and avoid claiming live
  multi-provider payments (Stripe-first today, provider-extensible by design is fine)?
- Does it avoid presenting Unprice as an AI agent platform?
- Does every claim have product evidence from `PRODUCT.md`, `brand-identity.md`,
  `positioning-and-messaging.md`, or implemented behavior?
- Does the call to action ask the prospect to identify the paid product action and put authorization,
  budget, or evidence around it?

## Message Mapping

| Buyer question | Answer to emphasize |
| --- | --- |
| Why now? | Paid usage can create cost or invoice confusion before the billing cycle ends. Runtime authorization prevents unwanted usage, and invoice evidence explains what did happen. |
| Why not just Stripe? | Stripe captures the payment; Unprice owns the PriceOps money path — plan versions, entitlements, usage, budgets, credits, and invoice evidence — inside the product request path. Stripe-first today, provider-extensible by design. |
| Why open source? | Revenue logic should be inspectable when it allows, denies, charges, credits, or replays customer activity. |
| What is the first demo? | Pick the paid action, meter it, authorize it before it runs, budget it if it can burn margin, and show invoice evidence from the same stream. |
| What should not be promised? | Do not promise live multi-provider payments (Stripe-first today; provider-extensible by design is fine), tax, accounting, enterprise revenue recognition, exact latency, or exact throughput without proof. |

## Validation Plan (P0 — validate before scaling spend)

The positioning rests on one unproven bet: that buyers feel "authorize before; explain after" as
acute pain, not just "rate usage accurately after." Validate this before committing GTM spend or
treating the before/after money path as proven.

Targets: 8-12 in-ICP engineering owners (CTOs, founding engineers, platform/product engineers) at
developer-led usage-based SaaS teams (5-50 people, Seed to Series A) with paid actions that affect
gross margin, invoice trust, or packaging flexibility. Recruit from inbound, design partners, and
warm dev-community intros — not a broad survey.

Falsify the wedge. Ask for the last time usage created cost they wished they had blocked, and the
last time support or engineering had to explain a confusing invoice line. Listen for whether they
tried to stop it in the request path, only discovered it on the invoice, or struggled because plan
logic and entitlement state were scattered. If teams consistently say post-hoc rating plus custom
counters is good enough, the wedge is weaker than assumed.

Phrase test. Show the same hero three ways and measure comprehension and "this is for me" response:

1. "Authorize paid usage before it runs." (commercial-authorization frame)
2. "Prove every charge after it bills." (evidence-after-the-fact frame)
3. "Put a budget and evidence trail around your most expensive action." (expensive-action frame)

Pick the lead phrase from evidence, then make it canonical in `positioning-and-messaging.md`.

Name and category check. Confirm whether buyers misread "Unprice" as "remove price / free" and
whether "PriceOps" lands or needs the DevOps/FinOps analogy every time. Feed results into the name
disambiguation rule in `brand-identity.md`.

Outcome to capture. One real, attributable quote on the cost-spike trigger, and one quantified
outcome (cost avoided, invoice-debugging time saved, or time-to-launch usage pricing).

## Open Questions

These are resolved by running the Validation Plan above:

- Collect one real customer or founder quote that captures the paid-action trigger.
- Quantify the strongest outcome once evidence exists: cost avoided, invoice-debugging time saved,
  or time to launch a pricing experiment without migrating existing customers.
- Validate whether the primary beachhead responds better to "authorize paid usage", "prove every
  charge", or "budget the expensive action" as the first phrase in campaign copy.
