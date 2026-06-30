# Landing Page Grand Slam Offer

Date: 2026-06-30

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
against the DIY stack (counter + cron) first. Voice is **calm urgency** — mechanism, not fear.

---

## The Offer In One Line

> Budget the expensive action before it runs. Define one plan, and a single `signUp` call provisions
> the customer, subscription, and entitlements; then deny over-budget work in the request path,
> reserve credits against real spend, and explain every invoice from the same money path — adopt it
> in shadow next to your current stack, test it on a sandbox, and settle to your own Stripe account.

Primary CTA everywhere: **Budget my expensive action** (or **Start with one expensive action**).
Secondary: **Explore the SDK** / **Star on GitHub**. Retire the vague **Start pricing** label.

---

## Page Map (which section does which job)

| Page section | Component | The one job |
| --- | --- | --- |
| Above the fold | `hero.tsx` | Name the pain + the wedge promise in one breath; one strong CTA. |
| Problem | `mainfesto-copy.tsx` | "By invoice time, the expensive work already ran." Agitate the leak. |
| Solution / category | `pillarsAMI.tsx` | "The Solution: PriceOps" + 4 pillars. |
| Mechanism (signature visual) | `money-path.tsx` | Show the money path + the allow/deny decision. |
| Adoption path | *(new — add it)* | Shadow → Sandbox → your own Stripe. Collapse adoption risk. |
| Capabilities | `features.tsx` | "One runtime for every pricing model" + plans. |
| Final CTA | `cta.tsx` | "Put a budget around the expensive action." One CTA. |

---

## Above The Fold (Hero)

**Pre-headline (keep the rotating line):**

> Your product is smart, but your pricing is *hardcoded / brittle / static / manual.*

**Headline (keep — it is canonical):**

> Stop runaway usage before it runs.

**Subheadline:**

> Open-source PriceOps infrastructure for usage-based SaaS. Put a real-time budget around your most
> expensive action, reject over-budget work in the request path, and explain every invoice line from
> the same money path.

**Payments microcopy (replace the current line):**

> Start on the built-in Sandbox — no real processor. When you go live, connect your **own** Stripe
> account; Unprice never sits in your funds flow. Stripe-first today, provider-extensible by design.

**Primary CTA:** Budget my expensive action  **Secondary CTA:** Star on GitHub

**Proof strip (under the fold):**

- Request-path allow/deny — before any cost
- Reserve up front (`runs`) or enforce live (`usage.consume`)
- Wallet credits and reservations
- Invoice evidence from the same usage trail
- Shadow-adopt beside your current stack
- Sandbox-first, then your own Stripe — AGPL core

---

## Problem (maps to `mainfesto-copy.tsx`)

**Headline (keep):** By invoice time, the expensive work already ran.

> **The trap:** a customer triggers your most expensive action — an LLM call, a data job, a costly
> API, a multi-minute workflow. Your usage tables, Redis counters, and cron reconciliation only
> notice later. By then the cost is created. If the customer disputes the invoice, you reconstruct
> the path from event to counter to billing line by hand.
>
> **Your Redis counter is not a budget.** It can say "usage is high." It can't reliably say which
> budget was checked, which credits were reserved, why a request was denied, and how the accepted
> usage became an invoice line — correctly, under concurrency.

**Signs of static, after-the-fact pricing (keep):**

- No way to stop over-budget usage before it runs.
- Inability to change packaging without rewriting product code.
- Treating pricing as a backend config, not a runtime decision.
- Invoice disputes that take manual reconstruction to explain.

---

## Mechanism (maps to `money-path.tsx`)

**Section line:** Pricing runs in the request path.

Before the expensive action runs, your app asks Unprice four questions on one money path
(**Request → Meter → Entitlement → Budget → Wallet → Invoice**):

1. Is this customer **entitled** to the feature?
2. Is this request **inside budget**?
3. Should **credits** be reserved or captured?
4. Can this decision **explain the invoice** later?

Over-budget work is denied in the request path (`429`), before any cost is created. The accepted
path settles credits and explains the invoice from the same trail.

**Pick the right call (don't conflate them):**

| Call | What it does |
| --- | --- |
| `access.check` | Read-only pre-flight — "allowed?" Mutates nothing (safe to run in shadow). |
| `usage.record` | **Report** usage asynchronously. Never blocks; usage can exceed funds. For metering + evidence. |
| `usage.consume` | **Enforce** synchronously. Denies (`LIMIT_EXCEEDED`) the moment funds/limit run out. |
| `runs.start/consume/end` | **Reserve** a budget envelope before a multi-step workload, so it cannot overspend; release the remainder. |

Lead with `consume` and `runs` — that is the block-before-cost wedge.

---

## The Offer Section (the conversion core)

**Headline:** Budget the expensive action before it runs.

Bring the one action in your product that can burn margin. Start with one plan, one customer budget,
one deny path, and one evidence trail — then expand.

**What you get:**

- A real-time budget around your most expensive action — over-budget work denied before it runs.
- One `signUp` call that provisions the customer, subscription, and entitlements from your plan (no
  entitlement tables to hand-roll).
- Budgeted runs that reserve spend up front for jobs, workflows, tools, and agents.
- Wallet credits and reservations kept distinct from entitlement grants.
- Invoice evidence that traces every charge to rated events and ledger captures.
- An open-source PriceOps core you can read before you trust it.

**CTA:** Budget my expensive action

---

## The Adoption Path (new section — the biggest risk-killer)

**Headline:** Try it without touching your current logic.

> **1. Shadow.** Keep your provider and your current logic running. Call `access.check` (read-only —
> it mutates nothing) next to your existing checks and log what Unprice *would* decide. Nothing in
> production changes.
>
> **2. Sandbox.** Model the full money path — customers, plans, budgets, credits, invoices — on the
> built-in Sandbox provider. No real processor; watch how billing behaves before a dollar moves.
>
> **3. Cut over.** When the decisions convince you, switch enforcement to `usage.consume` / `runs`
> and connect your **own** Stripe account (Stripe Connect or your own key). Unprice never sits in
> your funds flow.

Validate with zero exposure. Flip the switch only on the evidence. Keep full custody of funds.

---

## Capabilities (maps to `features.tsx`)

**Headline (keep):** One runtime for every pricing model.

- **Plan iteration** — version plans, migrate customers, and package features.
- **Any pricing model** — flat, tiered, package, usage, and hybrid share one mental model.
- **Analytics** — trace charges back to rated usage and ledger evidence.
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
- **Inspectable core:** the code that guards your money is open (AGPL-3.0). Read it, run it, own your
  data. No black box.
- **One-action fit check:** model one expensive action first. If it isn't clearer and safer than
  your counter or cron, you'll know before you migrate the rest.

---

## Scarcity & Qualification (fit, not fake timers)

> Unprice is for teams that can name the expensive action. If your product is pure seat-based SaaS,
> Stripe Billing is probably enough. If a single request can create margin risk, that request needs a
> budget in front of it.

> Every billing cycle you wait, the next runaway customer is already creating cost you can't claw
> back. The expensive action shipped today; the invoice that explains it is weeks away. The gap
> between them is the leak.

Design-partner window: the core is open and still being shaped — early teams influence the runtime
money path while it's small.

---

## Objection Handling

| Objection | Answer |
| --- | --- |
| "Why not just Stripe?" | Stripe captures the payment *after* the cost exists. Unprice controls the runtime money path *before* usage creates the cost. Keep Stripe; put the budget decision in front of it. |
| "Why not a Redis counter?" | A counter can drift from spend, credits, and invoice evidence, and races let over-budget work through. Unprice keeps the budget check, credit reservation, and invoice explanation on one path. |
| "Will switching disrupt my current logic?" | No — adopt it in shadow. `access.check` is read-only and `usage.record` is non-blocking, so you run Unprice's decisions beside your stack and only cut over to enforcement when you trust it. |
| "Do I have to move my payments / will you touch my money?" | No. Start on Sandbox (no processor), then connect your **own** Stripe via Connect or your own key. Charges and payouts run on your account; Unprice never sits in your funds flow. |
| "Do I have to rebuild subscriptions and entitlements?" | No. Define one plan; `signUp` provisions the customer, subscription, and entitlements (plus grants, billing periods, wallet) in one call. |
| "Record vs consume vs runs?" | `record` = async report (can exceed funds). `consume` = sync enforce (blocks over limit). `runs` = reserve a budget envelope before the work runs. Lead with consume/runs for spend safety. |
| "Will this replace my billing stack?" | No. Stripe-first today; Unprice sits between product usage and invoice evidence — not a tax, accounting, or payment-processor replacement. |
| "Is this an AI agent platform?" | No. Budgeted runs are generic workload labels. Your app owns prompts, tools, jobs, and execution. |
| "Is it safe? It's alpha." | The money-path core is open source — audit it, run it in shadow, prove it on sandbox, then enforce. The open core is the guarantee. |

---

## Final CTA (maps to `cta.tsx`)

**Headline (keep):** Put a budget around the expensive action.

> Unprice is open-source PriceOps infrastructure for usage-based SaaS. Pick your most expensive
> action, put a real-time budget around it, and explain every invoice from the same money path. Try
> it in shadow, prove it on sandbox, then settle to your own Stripe. The core is open source — build
> on it, or help us shape it.

**CTA:** Budget my expensive action   ·   Microcopy: Not sure where to start? **Talk to me.**

---

## Recommended Copy Changes To Current Components

Concrete edits to align the live page with this offer (copy only — no structural redesign):

1. `hero.tsx` — replace the **Start pricing** CTA with **Budget my expensive action**; replace the
   payments microcopy with the Sandbox + your-own-account line above.
2. `cta.tsx` — replace **Start pricing** with **Budget my expensive action**; add the shadow → sandbox
   → own-Stripe sentence to the paragraph.
3. `money-path.tsx` — caption stays; consider a one-line note that `Meter` uses `usage.record`
   (report) while the `Budget` decision uses `usage.consume` / `runs` (enforce), so the allow/deny
   moment reads as the enforcing call.
4. **Add an Adoption Path section** (the shadow → sandbox → cut-over block) between the money-path
   visual and the capabilities grid — it is the strongest risk-reducer and is currently missing.
5. `mainfesto-copy.tsx` — add the "Your Redis counter is not a budget" line to sharpen the DIY-stack
   contrast.
6. Keep "PriceOps" as the category explanation (`pillarsAMI.tsx`), not the primary promise.

---

## Claims Guardrails (recap)

- No exact latency/throughput numbers, no "Stripe replacement," no tax/accounting/revenue
  recognition, not an "AI agent platform."
- Payments: Stripe is the only live processor (Stripe Connect to the buyer's own account, or BYOK);
  Sandbox is the default no-processor test mode. Don't claim Square or live Paddle/Lemon Squeezy.
  Always say Unprice never sits in the buyer's funds flow.
- Integration: the first integration is "define one plan + `signUp` + `access.check`," not "one
  `access.check`." Don't imply entitlements exist without a published plan version.
- Endpoints: don't conflate `record` (async report) / `consume` (sync enforce) / `runs` (reserve) /
  `access.check` (read-only). Shadow adoption is real because `access.check` is read-only and
  `usage.record` is non-blocking — don't describe shadow as a separate product mode.
- The "only Unprice" wedge is the canonical competitive line but a still-unvalidated hypothesis
  (`positioning-and-messaging.md`). Lead with mechanism; don't oversell the superlative.
