# Jobs To Be Done

Date: 2026-07-03

Status: pre-validation refresh (July 2026 market audit). Run the Validation Plan below, then lock
the brand docs.

This document translates the Unprice brand and product positioning into Jobs-to-Be-Done language.
Use it when creating marketing campaigns, reviewing page copy, writing launch content, or checking
whether a message speaks to the real switching moment.

## Evidence Base

Source: internal brand docs plus founder clarification on 2026-06-30.

Inputs:

- [`PRODUCT.md`](PRODUCT.md)
- [`brand-identity.md`](brand-identity.md)
- [`positioning-and-messaging.md`](strategic/positioning-and-messaging.md)
- [`design-system-guidelines.md`](design-system-guidelines.md)

Evidence limits:

- Treat this as internal positioning, not customer research.
- Do not write or imply customer quotes until real interviews, support threads, or sales calls are
  available.
- The primary trigger is an agent or paid workflow spending customer credits before billing can
  stop it.
- The job is authorization-led AI billing: decide before the workload runs, settle actual usage,
  then trace the invoice line to the authorization.
- The measurable outcomes to emphasize are cost avoided, invoice-debugging time reduced, and pricing
  changes shipped without moving existing customers off their plan versions.

### Public Buyer Language (Market Research, July 2026)

Sourced verbatims from public threads. These are market evidence for the pain, not Unprice customer
proof — they inform recruiting and interview language, and must never be presented as Unprice
customer quotes.

- On Stripe Billing, for AI products: "no way to check a customer's balance before they use the
  product, no way to enforce spend caps" — teams are forced to "hardcode pricing logic inside their
  product." (HackerNoon teardown of Stripe usage-based billing.)
- "Usage based billing is tough." / "I want to freely mix subscription based and pre-paid credits.
  My users go over their quota one month… they prefer a one-off top-up." (Hacker News, Lago
  thread, item 39958909.)
- "Billing systems are a nightmare for engineers." (Lago's canonical post, 846+ points on Hacker
  News, item 31424450.)
- On entitlement sprawl: "tying entitlements closely to plans and pricing doesn't hold up" —
  pricing migrations "create numerous opportunities for entitlements to be incorrect." (Garrett
  Dimon, data-modeling-saas-entitlements-and-pricing.)

Use the first verbatim as the interview recruiting hook: "Can you check a balance or enforce a
spend cap before the request runs today?"

## Core Job

When an AI product sells credits, agent runs, or paid workflows, the team wants to authorize the
customer's plan, budget, and credits before the workload creates cost, then trace settled usage to
the invoice.

## Job Statement

When my AI product runs agents or paid workflows that spend customer credits, I want to apply the
correct plan, check the customer's budget, reserve credits before work starts, settle actual usage,
and preserve invoice evidence, so I can show why the workload ran and how it became a charge.

## Primary Actor

Best-fit early actors:

- CTOs, founding engineers, heads of platform, and product engineers.
- Developer-led AI products with 5-50 employees, Seed to Series A.
- Agent, workflow, API, automation, or AI infrastructure products where usage affects gross margin.
- Engineering teams that own billing, metering, entitlements, plan versions, or request-path
  customer spend authorization.

The customer account is the economic actor. Runs, jobs, workflows, tools, and agents are workload
labels that help control and explain spend.

## Trigger Events

Primary trigger:

- A paid customer action can burn through credits, budget, or usage allowance before the team can
  explain it.

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
whether a customer is allowed to spend, keep existing customers on the right plan version, or explain
a charge from one inspectable trail. The product can move quickly, but the pricing logic becomes
something engineers and support are afraid to touch.

## Desired Outcome

Every paid action is authorized against the customer's plan, budget, and credits before it runs, and
every charge, denial, credit, or invoice line can be explained after the fact.

A successful implementation should let the team:

- Authorize or deny customer spend before paid work creates cost.
- Change packaging without rewriting the application money path.
- Keep customers pinned to the plan version they bought while new pricing experiments ship.
- Explain invoice lines from plan versions, billing periods, pricing rules, rated usage events when
  present, ledger captures, and wallet movements.
- Distinguish wallet credits, entitlement grants, usage quantities, and invoices.
- Recover from ingestion failures with evidence and replay paths.

## Switch Forces

### Push

The current setup combines billing tools, usage tables, counters, cron reconciliation, and manual
support debugging. It does not give enough runtime control or after-the-fact evidence when usage can
create real cost before the billing cycle ends, or when a customer asks why a specific invoice line
exists.

### Pull

Unprice connects product requests, plan versions, pricing rules, meter events, entitlement
decisions, customer budget checks, wallet movements, ledger captures, ingestion state, and invoice
evidence in one inspectable runtime system.

### Habit

Teams already have Stripe, custom counters, billing scripts, and plan logic embedded in product
code. These pieces may work well enough until a cost spike, pricing change, or invoice dispute
forces the team to trace the full money path.

### Anxiety

A prospect may worry about putting customer money decisions in the request path, relying on a young
open-source billing-adjacent system, moving logic out of familiar Stripe-centered workflows, or
depending on latency and throughput claims that have not been proven for their workload.

## Before And After

Before:

- Pricing behavior lives in multiple places.
- Cost spikes are discovered after usage already happened.
- Support or engineering reconstructs invoice disputes by hand.
- Packaging changes require edits across application code, billing code, and reconciliation jobs.
- Engineers hesitate to change pricing because one hidden branch can create the wrong invoice.

After:

- Runtime checks decide whether customer spend is commercially allowed before paid work runs.
- Budgets and wallet credits constrain customer or workload spend.
- Invoice explanations connect back to plan-version, pricing, usage, wallet, and ledger evidence.
- Engineers can change pricing models while existing customers stay on their plan versions.

## Functional Needs

Unprice must help teams:

- Meter usage events.
- Enforce entitlements before expensive work runs.
- Start, consume, end, and inspect budgeted runs.
- Reserve and capture wallet credits.
- Keep subscriptions, entitlements, and plan versions separate but connected.
- Keep failed, rejected, processed, and replayed ingestion states visible.
- Explain invoices from pricing rules, usage quantity, rated facts when present, billing periods,
  ledger captures, wallet movements, and event evidence.

## Emotional Needs

The product should help founders and engineers feel:

- In control of customer spend before it becomes invoice damage.
- Clear about why a request was allowed, denied, charged, credited, invoiced, or replayed.
- Confident enough to offer usage pricing and customer budgets without scattering money logic
  through product code.
- Safe enough to change packaging without turning the next invoice into an engineering investigation.

## Campaign Angles

Lead campaigns with the primary trigger: an agent or paid workflow can spend customer credits
before billing can stop it.

Strong angles:

- Sell AI credits and usage. Keep the margin.
- Every AI charge starts with an authorization.
- Authorize every agent run and paid workflow before it creates cost.
- Reserve customer credits before the run, then settle actual usage.
- Trace each invoice line to the decision that allowed the work.
- Prove every charge after it bills.
- Sell AI credits and usage without paying for unfunded agent work.
- Put a budget and evidence trail around the expensive action in your product.
- Your Redis counter is not a budget: request-path enforcement beats a homegrown pre-check.
- AI gateways cap provider spend; Unprice governs customer spend and invoice evidence.
- Pricing is a runtime decision and an evidence trail for usage-based SaaS.
- Prove every invoice line after it bills.
- Explain every invoice line from plan-version, pricing, usage, wallet, and ledger evidence.
- Keep entitlements separate from subscriptions so pricing experiments do not rewrite existing
  customers.
- Move usage, pricing rules, entitlements, credits, plan versions, ledger captures, and invoices into
  one inspectable money path.
- Your customers' agents can burn a month of credits in an afternoon. Budget the run before it
  starts. (AI-credits slice; stays inside the not-an-agent-platform boundary.)
- The billing layer you rent can be acquired. The money path you own cannot. (Consolidation angle;
  dated market facts — verify at publish time.)
- Read the code that guards your money — or have your agent read it. (Open-source AI-legibility
  angle.)

Weak angles:

- A broad billing platform.
- A generic pricing page builder.
- A Stripe replacement.
- An AI agent platform.
- A no-code monetization tool.
- An enterprise revenue recognition, tax, or accounting suite.

## Copy Review Checklist

Use this checklist when reviewing homepage, landing page, launch, ad, docs, or sales copy.

- Does the copy name the actor: developer-led AI products, CTOs, founding engineers, platform
  engineers, or product engineers?
- Does the first screen make customer spend authorization or invoice explanation visible?
- Does the message lead with a paid-action trigger, cost-spike trigger, invoice-dispute trigger, or
  pricing-experiment trigger from this document?
- Does the copy connect request, meter, entitlement, budget, wallet, plan version, and invoice
  evidence?
- Does it show that Unprice authorizes customer spend before paid work creates cost?
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
| Why now? | A customer can burn through credits, budget, or usage allowance before the billing cycle ends. Runtime authorization prevents over-budget work, and invoice evidence explains every line that did happen. |
| Why not just Stripe? | Stripe captures the payment; Unprice owns the customer money path — plan versions, pricing rules, entitlements, usage, budgets, credits, ledger captures, and invoice evidence — inside the product request path. Stripe-first today, provider-extensible by design. |
| Why not an AI gateway? | Gateways cap provider spend, route models, and manage virtual keys. Unprice governs what the buyer's customer is allowed to spend and connects that decision to plan versions, credits, and invoice evidence. |
| Why open source? | Revenue logic should be inspectable when it allows, denies, charges, credits, or replays customer activity. |
| What is the first demo? | Pick the paid action, define the plan-version pricing rule, authorize it before it runs, budget it if it can burn margin, and show invoice evidence from the same money path. |
| What should not be promised? | Do not promise live multi-provider payments (Stripe-first today; provider-extensible by design is fine), tax, accounting, enterprise revenue recognition, exact latency, or exact throughput without proof. |

## Validation Plan (P0 — validate before scaling spend)

The positioning rests on one unproven bet: that buyers feel "authorize before; explain after" as
acute pain, not just "rate usage accurately after." Use this story as the working center of selling
propositions, but validate the lead phrase before committing GTM spend.

Targets: 8-12 in-ICP engineering owners (CTOs, founding engineers, platform/product engineers) at
developer-led AI products (5-50 people, Seed to Series A) with agent runs or paid workflows that affect
gross margin, invoice trust, or packaging flexibility. Recruit from inbound, design partners, and
warm dev-community intros — not a broad survey. Open recruiting and interviews with the buyer's own
words from the Public Buyer Language section ("can you check a balance or enforce a spend cap
before the request runs today?"), not Unprice vocabulary.

Falsify the wedge. Ask for the last time usage created cost they wished they had blocked, and the
last time support or engineering had to explain a confusing invoice line. Listen for whether they
tried to stop it in the request path, only discovered it on the invoice, or struggled because plan
logic and entitlement state were scattered. If teams consistently say post-hoc rating plus custom
counters is good enough, the wedge is weaker than assumed.

Phrase test. Show the same AI-first hero three ways and measure comprehension and "this is for me"
response:

1. "Sell AI credits and usage. Keep the margin." (business-outcome frame)
2. "Every AI charge starts with an authorization." (mechanism frame)
3. "Reserve customer credits before the agent runs." (operational frame)

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
- Validate whether the primary beachhead responds better to "authorize customer spend", "prove every
  charge", or "budget the paid action" as the first phrase in campaign copy.
