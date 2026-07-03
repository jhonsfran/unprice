# Landing Page Grand Slam Offer

Date: 2026-07-02

## What This Is

Page-ready conversion copy for the Unprice landing page, derived from the complete offer and mapped
to the real components in `apps/nextjs/src/components/landing/`. Use this to write/refresh the page;
use the strategy doc for the full reasoning.

- **Canonical offer (full value stack, guarantee, bonuses, value equation):**
  [`the-expensive-action-offer.md`](the-expensive-action-offer.md). Defer to it for offer logic.
- **Canonical positioning, headline, competitor contrast:**
  [`positioning-and-messaging.md`](positioning-and-messaging.md).
- **Voice, vocabulary, claims policy:** [`brand-identity.md`](brand-identity.md).

**Claims guardrails:** no exact latency/throughput numbers, no "Stripe replacement," no
tax/accounting/revenue-recognition, not an "AI agent platform." Payments: Stripe-first today (Stripe
Connect to the buyer's own account, or bring-your-own-key) plus the built-in **Sandbox** test
provider; do not claim Square (unimplemented) or live Paddle/Lemon Squeezy. Lead competitive copy
against the DIY stack (counter + cron) first, then distinguish Unprice from AI gateways and closed
usage runtimes. Voice is **calm urgency** — mechanism, not fear.

---

## The Offer In One Line

> Start with one paid action in one afternoon. Define the plan version, install the SDK, provision or
> map one customer, and run Unprice in shadow beside your current logic; then prove the same path on
> Sandbox with invoice evidence before you enforce anything or move payments.

Primary CTA everywhere: **Start with one paid action**. Consultative/design-partner variant:
**Map my paid action**. Proof CTA once the video is live: **Watch the workflow demo**. Secondary:
**Explore the SDK** / **Star on GitHub**. Retire the vague **Start pricing** label.

---

## Page Map (which section does which job)

| Page section | Component | The one job |
| --- | --- | --- |
| Above the fold | `hero.tsx` | Name the pain + the wedge promise in one breath; one low-friction CTA. |
| Problem | `mainfesto-copy.tsx` | "By invoice time, the paid work already ran." Agitate the before/after gap. |
| Solution / operating model | `pillarsAMI.tsx` | Explain PriceOps after the customer money path is clear. |
| Mechanism (signature visual) | `money-path.tsx` | Show the money path + the allow/deny decision + invoice explanation. |
| Proof / demo | *(new — add it)* | Workflow-app video: one paid action in one afternoon. Increase perceived likelihood. |
| Adoption path | *(new — add it)* | Shadow → Sandbox → your own Stripe. Collapse adoption risk. |
| Capabilities | `features.tsx` | "One runtime for every pricing model" + plans. |
| Final CTA | `cta.tsx` | Repeat the wedge, then ask for the one-action first step. |

---

## Above The Fold (Hero)

**Pre-headline (keep the rotating line):**

> Your product is smart, but your pricing is *hardcoded / brittle / static / manual.*

**Headline (keep — it is canonical):**

> Authorize customer spend before paid work runs.

**Subheadline:**

> Open-source money path for usage-based SaaS. Keep plans versioned, entitlements separate,
> customer budgets in the request path, and invoice evidence tied to the same decision that allowed
> or denied the work.

**Outcome line:**

> Start with one paid action in one afternoon: create the plan, install the SDK, run the decision in
> shadow, and prove the path on Sandbox before you enforce anything.

**Payments microcopy (replace the current line):**

> Start on the built-in Sandbox — no real processor. When you go live, connect your **own** Stripe
> account; Unprice never sits in your funds flow. Stripe-first today, provider-extensible by design.

**Primary CTA:** Start with one paid action  **Secondary CTA:** Watch the workflow demo / Explore the SDK

**Proof strip (under the fold):**

- Customer spend authorization — before paid work creates cost
- Plan versions and separated entitlements
- Reserve up front (`runs`) or enforce live (`usage.consume`)
- Wallet credits and reservations
- Invoice evidence from the same money path
- Customer spend control, not provider-cost routing
- Workflow-app demo: one action in one afternoon
- Shadow-adopt beside your current stack
- Sandbox-first, then your own Stripe — AGPL core

---

## Problem (maps to `mainfesto-copy.tsx`)

**Headline:** By invoice time, the paid work already ran.

> **The trap:** a customer triggers a paid action — an LLM call, a data job, a costly API, a
> multi-minute workflow. Your usage tables, Redis counters, and cron reconciliation only notice
> later. By then the work already ran, the cost is real, and someone has to defend the charge. If
> the customer disputes the invoice, you reconstruct the path from plan version to event to counter
> to billing line by hand.
>
> **Your Redis counter is not a budget.** It can say "usage is high." It can't reliably say which
> budget was checked, which credits were reserved, why a request was denied, and how the accepted
> usage became an invoice line — correctly, under concurrency.

**Signs of static, after-the-fact pricing (keep):**

- No way to authorize customer spend before paid work runs.
- Inability to change packaging without rewriting product code.
- Treating pricing as a backend config, not a runtime decision and evidence trail.
- Invoice disputes that take manual reconstruction to explain.

---

## Mechanism (maps to `money-path.tsx`)

**Section line:** Customer spend authorization runs in the request path.

Before the paid action runs, your app asks Unprice five questions on one customer money path
(**Request → Plan version → Pricing rule → Meter → Entitlement → Budget → Wallet → Ledger →
Invoice**):

1. Which **plan version** applies to this customer?
2. Which **pricing rule** applies to this feature?
3. Is this customer **entitled** to the feature?
4. Is this request inside the **customer's budget**, and should **credits** be reserved or captured?
5. Can this decision **explain the invoice line** later?

Over-budget customer work is denied in the request path (`429`), before any cost is created.
Accepted usage settles credits and explains the invoice from the same money path.

**Pick the right call (don't conflate them):**

| Call | What it does |
| --- | --- |
| `access.check` | Read-only pre-flight — "commercially allowed?" Mutates nothing (safe to run in shadow). |
| `usage.record` | **Report** usage asynchronously. Never blocks; usage can exceed funds. For metering + evidence. |
| `usage.consume` | **Enforce** synchronously. Denies (`LIMIT_EXCEEDED`) the moment funds/limit run out. |
| `runs.start/consume/end` | **Reserve** a budget envelope before a multi-step workload, so it cannot overspend; release the remainder. |

Lead with `access.check` / `usage.consume` / `runs` depending on the action. That is the
authorize-before-cost wedge.

---

## The Offer Section (the conversion core)

**Headline:** Start with one paid action in one afternoon.

Bring the one action in your product that can burn a customer's credits, budget, or usage allowance.
Create the plan, install the SDK, put Unprice beside your current logic in shadow, and prove the path
on Sandbox before you enforce anything.

**What you get:**

- Customer spend authorization for one paid action — entitlement, budget, credits, and meter rules
  checked before work runs.
- One `signUp` call that provisions the customer, subscription, and entitlements from your plan
  version (no entitlement tables to hand-roll).
- Shadow adoption with `access.check` — compare decisions without blocking production traffic.
- Plan versions that keep existing customers on the pricing they bought while new experiments ship.
- Budgeted runs that reserve spend up front for jobs, workflows, tools, and agents.
- Wallet credits and reservations kept distinct from entitlement grants.
- Invoice evidence that traces every charge to plan version, pricing rule, billing period, rated
  events when present, wallet movement, and ledger captures.
- An open-source money-path core you can read before you trust it.

**CTA:** Start with one paid action

---

## The Proof Video (new section — the likelihood booster)

**Headline:** Watch one workflow action move into shadow.

The video should not be a feature tour. Show a real workflow app with one paid action:

1. Pick the workflow that creates cost or invoice questions.
2. Create the plan version and pricing rule.
3. Install the SDK and provision or map one customer.
4. Add `access.check` beside the current code path as a shadow decision.
5. Run the workflow, inspect allow/deny/budget evidence, then simulate invoice evidence on Sandbox.

The emotional payoff: the viewer sees the scary part become small. They do not have to migrate
billing, move money, or trust enforcement on day one. They only have to prove one action.

---

## The Adoption Path (new section — the biggest risk-killer)

**Headline:** Try it without touching your current logic.

> **1. Shadow.** Keep your provider and your current logic running. Call `access.check` (read-only —
> it mutates nothing) next to your existing checks and log what Unprice *would* decide. Nothing in
> production changes.
>
> **2. Sandbox.** Model the full money path — customers, plan versions, entitlements, budgets,
> credits, invoices — on the built-in Sandbox provider. No real processor; watch how billing behaves
> before a dollar moves.
>
> **3. Cut over.** When the decisions convince you, switch enforcement to `usage.consume` / `runs`
> and connect your **own** Stripe account (Stripe Connect or your own key). Unprice never sits in
> your funds flow.

Validate with zero exposure. Flip the switch only on the evidence. Keep full custody of funds.

---

## Capabilities (maps to `features.tsx`)

**Headline (keep):** One runtime for every pricing model.

- **Plan iteration** — version plans, pin customers to plan versions, and package features.
- **Any pricing model** — flat, tiered, package, usage, credit-based, and hybrid share one mental
  model.
- **Analytics** — trace charges back to pricing, rated usage when present, wallet movement, and
  ledger evidence.
- **Subscriptions** — provisioned by `signUp`; cancel, pause, resume with a simple API.

**Tiers (keep):** FREE (AGPL, self-host) · PRO (commercial license + support) · ENTERPRISE
(dedicated support for teams that can't open-source their changes).

---

## Risk Reversal

Lead with the buyer's real fear — not price, but *"will I put money logic somewhere I'll regret?"*

- **Shadow-and-Sandbox:** nothing changes until you trust it. Observe in shadow, simulate on
  sandbox, enforce only when the evidence convinces you.
- **Your money, your account:** go live on your own Stripe (Connect or your own key). Unprice never
  sits in your funds flow; there is no central platform account between you and your revenue.
- **Inspectable core:** the code that guards your money is open (AGPL-3.0). Read it — or have your
  agent read it — run it, own your data. No black box, and no acquisition risk: a forkable money
  path cannot be bought out from under you.
- **One-afternoon fit check:** model one paid action first. If it is not clearer than your counter
  or cron in one working session, you will know before you migrate the rest.

---

## Scarcity & Qualification (fit, not fake timers)

> Unprice is for teams that can name the paid action. If your product is pure seat-based SaaS,
> Stripe Billing is probably enough. If a single request can create margin risk or invoice confusion,
> that request needs authorization and evidence around it.

> Every billing cycle you wait, the next over-budget or confusing paid action is already creating
> cost you can't claw back or invoice lines support cannot explain. The paid action shipped today;
> the invoice that explains it is weeks away. The gap between them is where margin leaks, trust
> burns, and engineering turns into invoice support.

Design-partner window: the core is open and still being shaped — early teams influence the runtime
money path while it's small.

---

## Objection Handling

| Objection | Answer |
| --- | --- |
| "Why not just Stripe?" | Stripe captures payment and issues invoices. Unprice owns the customer money path before and around that invoice: plan versions, pricing rules, entitlements, usage, budgets, credits, ledger captures, and evidence. Keep Stripe; put customer spend authorization in front of paid usage. |
| "Why not an AI gateway?" | Gateways cap provider spend, route models, and manage virtual keys. Unprice governs what your customer is allowed to spend and connects that decision to plan versions, credits, and invoice evidence. |
| "Why not Stigg?" | Stigg is a strong closed usage runtime. Use Unprice when you want the request-to-invoice money path in open source: inspect it, self-host it, adapt it, and keep the budget check, credit reservation, and invoice evidence together. |
| "Why not a Redis counter?" | A counter can drift from spend, credits, and invoice evidence, and races let over-budget work through. Unprice keeps the budget check, credit reservation, and invoice explanation on one path. |
| "Will switching disrupt my current logic?" | No — adopt it in shadow. `access.check` is read-only and `usage.record` is non-blocking, so you run Unprice's decisions beside your stack and only cut over to enforcement when you trust it. |
| "Do I have to move my payments / will you touch my money?" | No. Start on Sandbox (no processor), then connect your **own** Stripe via Connect or your own key. Charges and payouts run on your account; Unprice never sits in your funds flow. |
| "Do I have to rebuild subscriptions and entitlements?" | No. Define one plan version; `signUp` provisions the customer, subscription, and entitlements (plus grants, billing periods, wallet) in one call. |
| "Why separate entitlements from subscriptions?" | Because pricing experiments should not silently rewrite what an existing customer bought. Plan versions keep customers attached to their versioned entitlement map. |
| "Record vs consume vs runs?" | `record` = async report (can exceed funds). `consume` = sync enforce (blocks over limit). `runs` = reserve a budget envelope before the work runs. Lead with the operation that matches the paid action: `access.check`, `consume`, or `runs`. |
| "Will this replace my billing stack?" | No. Stripe-first today; Unprice sits between product usage and invoice evidence — not a tax, accounting, or payment-processor replacement. |
| "Is this an AI agent platform?" | No. Budgeted runs are generic workload labels. Your app owns prompts, tools, jobs, and execution. |
| "Is it safe? It's alpha." | The money-path core is open source — audit it, run it in shadow, prove it on sandbox, then enforce. The open core is the guarantee. |

---

## Final CTA (maps to `cta.tsx`)

**Headline:** Authorize customer spend before paid work runs.

> Unprice is the open-source customer money path for usage-based SaaS. Pick one paid action, check
> entitlement, customer budget, credits, and meter rules before it runs, then explain every invoice
> from the same money path. Start in shadow in one afternoon, prove it on Sandbox, then settle to
> your own Stripe. The core is open source — build on it, or help us shape it.

**CTA:** Start with one paid action   ·   Microcopy: Not sure where to start? **Map my paid action.**

---

## Recommended Copy Changes To Current Components

Concrete edits to align the live page with this offer (copy only — no structural redesign):

1. `hero.tsx` — replace the **Start pricing** CTA with **Start with one paid action**; add the
   one-afternoon outcome line and the Sandbox + your-own-account payment microcopy above.
2. `cta.tsx` — replace **Start pricing** with **Start with one paid action**; add the shadow →
   sandbox → own-Stripe sentence to the paragraph.
3. `money-path.tsx` — caption stays; add plan version as a visible evidence point, and consider a
   one-line note that `Meter` uses `usage.record` (report) while the authorization decision uses
   `access.check`, `usage.consume`, or `runs` depending on the action.
4. **Add a Proof Video section** with the workflow-app demo between the hero/problem and the
   adoption path. It should prove one action in one afternoon, not narrate every product feature.
5. **Add an Adoption Path section** (the shadow → sandbox → cut-over block) between the money-path
   visual and the capabilities grid — it is the strongest risk-reducer and is currently missing.
6. `mainfesto-copy.tsx` — add the "Your Redis counter is not a budget" line to sharpen the DIY-stack
   contrast.
7. Keep "PriceOps" as the operating-model explanation (`pillarsAMI.tsx`), not the primary promise.

---

## Claims Guardrails (recap)

- No exact latency/throughput numbers, no "Stripe replacement," no tax/accounting/revenue
  recognition, not an "AI agent platform."
- Payments: Stripe is the only live processor (Stripe Connect to the buyer's own account, or BYOK);
  Sandbox is the default no-processor test mode. Don't claim Square or live Paddle/Lemon Squeezy.
  Always say Unprice never sits in the buyer's funds flow.
- Integration: the first integration is "define one plan version + `signUp` + `access.check`," not "one
  `access.check`." Don't imply entitlements exist without a published plan version.
- Endpoints: don't conflate `record` (async report) / `consume` (sync enforce) / `runs` (reserve) /
  `access.check` (read-only). Shadow adoption is real because `access.check` is read-only and
  `usage.record` is non-blocking — don't describe shadow as a separate product mode.
- The "authorize before; explain after" wedge is the canonical competitive line but a
  still-unvalidated hypothesis (`positioning-and-messaging.md`). Lead with mechanism; don't oversell
  superlatives.
- Keep "one afternoon" mechanically honest: back it with a timed, CI-tested quickstart (plan
  version + `signUp` + `access.check` on Sandbox) before using it as a hard claim in paid
  campaigns. The proof-video and adoption-path sections depend on assets that have not shipped yet.
- Consolidation copy ("a forkable money path cannot be bought out from under you") rests on dated
  market facts (see Market Context in `positioning-and-messaging.md`); verify at publish time.
