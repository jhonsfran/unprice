# The Expensive-Action Offer (Grand Slam Offer)

Date: 2026-06-30

## What This Is

A complete, packaged Grand Slam Offer for Unprice, built with Alex Hormozi's `$100M Offers`
frameworks: the Value Equation, a stacked value/bonus ladder, a layered guarantee, fit-based
scarcity, and a MAGIC-formula name. It is the "make them feel stupid saying no" version of the
pitch.

**Claims guardrails (do not break):** no exact latency/throughput numbers, no "Stripe replacement,"
no tax/accounting/revenue-recognition coverage, not an "AI agent platform." Payments: Stripe-first
today (via Stripe Connect to the buyer's own account, or bring-your-own-key) plus the built-in
**Sandbox** test provider; do not claim Square (an unimplemented placeholder) or live
Paddle/Lemon Squeezy. The "only Unprice" wedge is the canonical competitive line but is still a
positioning hypothesis — see the guardrails section.

---

## The One-Sentence Offer

> Name the one action in your product that can burn margin. Define one plan, and a single `signUp`
> call provisions the customer, subscription, and entitlements for you; then `access.check` denies
> over-budget work in the request path before it runs, credits reserve against real spend, and every
> allow, deny, charge, and invoice line carries its own evidence — testable end-to-end on a built-in
> sandbox before a real dollar moves, on an open-source core you can read before you trust it.

---

## The Offer Name (MAGIC Formula)

**Primary:** **The Expensive-Action Budget Sprint**

| MAGIC | How it is satisfied |
| --- | --- |
| **M**ake it about them | "Your expensive action," "your margin," "your request path." The hero is the builder's cost, not our platform. |
| **A**nnounce the avatar | Developer-led AI/API SaaS teams with expensive per-request usage (CTOs, founding engineers, platform engineers). |
| **G**ive them a goal | Put a real-time customer budget around the one action that can blow past spend. |
| **I**ndicate a time interval | A "Sprint" — one request path live before your next billing cycle, not a quarter-long migration. |
| **C**omplete with a container word | "Sprint" (the container). Alternatives below. |

**Approved alternates (same wedge, different energy):**

- **Budget The Expensive Action** — the established rallying-cry name; safest, most on-brand.
- **The Margin Firewall** — louder, still mechanism-grounded (a budget that rejects over-budget work
  in the request path behaves like a firewall for spend). Use for campaigns, not the core doc.
- **The Runaway-Usage Stop** — leads with the homepage headline verb.

Do not rename the product or category. This names the *offer*, not the product.

---

## The Value Equation

```
Value = (Dream Outcome x Perceived Likelihood) / (Time Delay x Effort & Sacrifice)
```

Every line of the offer is engineered to push the two numerators up and the two denominators down.

| Lever | Direction | The move in this offer |
| --- | --- | --- |
| **Dream Outcome** | Maximize | Reframe from "better invoices" to **margin protection at the moment of cost creation**: *"Your most expensive action can never exceed a customer's budget unless you allow it — and every invoice line can prove why it exists."* The win is a *blocked over-budget request*, not a cleaner spreadsheet. |
| **Perceived Likelihood** | Maximize | Shrink the promise to one plan, one budget, one deny path, one evidence trail. Show the exact SDK methods that do it (`customers.signUp`, `access.check`, `usage.consume`, `runs.start` / `runs.consume` / `runs.end`, `wallet.balance`). Define the plan once and `signUp` provisions the subscription + entitlements for you. The core is **open source** — they can read the money-path code before trusting it. Start small, prove it, expand. |
| **Time Delay** | Minimize | **No full billing migration, and no real processor to start.** Define one plan, call `signUp` (it wires the subscription + entitlements), then guard one action with `access.check` — runnable on the built-in **Sandbox** provider before a dollar moves. First request path live in a sprint, not a roadmap quarter. |
| **Effort & Sacrifice** | Minimize | Adopt in **shadow** first: run Unprice's decisions next to your current stack (the `access.check` read mutates nothing) so production behavior changes only when you trust it. You don't hand-build subscription or entitlement tables — `signUp` provisions them from the plan. When you go live, connect **your own** Stripe account (Stripe Connect or your own key); Unprice never sits in your funds flow. Generated SDK, explicit schemas, no black box. |

The strategic result: the *value* (protected margin + eliminated DIY build + explainable invoices)
is large and the *price* (an afternoon defining one plan and wiring two SDK calls into one request
path) is small. That gap is the offer.

---

## What The First Integration Actually Is

The first step is *not* hand-building entitlement tables, and it is *not* one magic call either. It
is three small moves — and Unprice automates the part teams dread:

1. **Define one plan, once (dashboard).** Create the feature(s) you want to gate and publish a plan
   version that includes them. The plan *is* the entitlement map — `access.check` later matches on
   the feature slug you define here. (Plans are authored in the dashboard/tRPC, not the runtime SDK.)
2. **Provision a customer with one SDK call.** `customers.signUp({ planSlug | planVersionId, ... })`
   creates the customer, the subscription, the phase, and the entitlements + credit grants + billing
   periods + wallet — in one transaction, derived from the plan. You do not write a subscriptions
   table, an entitlements table, or reconciliation glue.
3. **Gate the expensive action.** `access.check({ customerId, featureSlug })` returns allow/deny in
   the request path; for usage features, report with `usage.record` / `usage.consume`, and cap
   workloads with budgeted runs (`runs.start` / `consume` / `end`).

The honest version of "low effort": a one-time plan definition plus two SDK calls (`signUp`,
`access.check`). Unprice owns the subscription + entitlement provisioning you would otherwise
hand-roll.

## Pick The Right Decision: Observe, Enforce, Or Reserve

Four runtime operations — and the difference is the product. Don't conflate them:

| Operation | Sync? | Blocks over-budget? | Mutates | Use it to |
| --- | --- | --- | --- | --- |
| `access.check` | sync | — (read-only) | nothing | Pre-flight: ask "is this customer allowed / within limit?" before doing the work. Safe to call anywhere, including in shadow. |
| `usage.record` | **async** | **No** | meter (eventual, non-enforcing) | **Report** usage for metering and invoice evidence. Usage *can* exceed funds — it is fire-and-forget, not a gate. |
| `usage.consume` | **sync** | **Yes** | meter (real-time, enforcing) | **Enforce** in the request path: validate in real time and deny (`LIMIT_EXCEEDED`) the moment funds/limit run out. |
| `runs.start` / `consume` / `end` | sync | **Yes, up front** | wallet reservation | **Reserve** a budget envelope *before* a multi-step workload runs, so it cannot overspend. `start` holds the funds, `consume` draws down, `end` releases the remainder. |

The one-line mental model:

- **`record` = "tell me later."** Async, never blocks; usage can overshoot funds.
- **`consume` = "decide now."** Sync, blocks the moment funds/limit are exhausted.
- **`runs` = "ring-fence it first."** Reserve the budget before the work starts, so the run is guaranteed not to overspend.

Lead the offer with `consume` and `runs` — that is the block-before-cost wedge. `record` is for metering
and invoice evidence, not spend safety.

## Adopt In Shadow: Don't Touch Your Current Logic

The lowest-risk on-ramp: run Unprice's pricing decisions *alongside* your existing stack before you let
them enforce anything. You keep your own payment provider and your own logic; Unprice just shadows it.

- **Keep your provider and current logic running.** Nothing in production behavior changes.
- **Mirror the decision in shadow.** Call `access.check` (read-only — it mutates nothing) in parallel
  with your existing checks and log whether Unprice *would* have allowed or denied. Optionally mirror
  usage with `usage.record` (non-blocking) to compare Unprice's meters against your own numbers.
- **Compare, then cut over.** Once Unprice's decisions match — or beat — your current logic, switch
  enforcement to `usage.consume` / `runs.*` and move the provider over to your own Stripe through
  Unprice.

Because the pre-flight (`access.check`) and reporting (`usage.record`) paths never block your traffic,
you validate the entire money path against real production usage without risking a single customer
request — then flip the switch only when the evidence convinces you.

## Payments: Start On Sandbox, Settle To Your Own Account

Two facts that collapse adoption risk:

- **Sandbox by default.** Every project starts on a built-in **Sandbox** payment provider that runs
  the entire money path — invoices, payments, wallet settlement — with canned results and no real
  processor. Model customers, plans, budgets, and credits, and watch how billing behaves, before
  connecting real money.
- **Your money, your account.** When you go live, you connect **your own** Stripe account via Stripe
  Connect (or bring your own Stripe key). Charges, invoices, and payouts execute on *your* account —
  Unprice never sits in your funds flow, and there is no central platform account between you and
  your revenue.

Claim discipline: Stripe-first today, plus the Sandbox test provider; the provider model is
extensible by design. Do not advertise Square (an unimplemented placeholder) or live
Paddle/Lemon Squeezy.

---

## The Grand Slam Value Stack

The buyer should feel they are getting a complete, owned money path — not a trial of a vague
platform. Anchor on the **cost of the status quo**, not an invented retail price (Unprice's own
commercial pricing is still being defined; do not fabricate a number).

| # | What you get | What you do without it | What that costs you (fill in your number) |
| --- | --- | --- | --- |
| 1 | **Real-time spend budget** around your most expensive action — `usage.consume` validates synchronously and denies over-budget work in the request path *before* it runs. | Discover the overage at invoice time; eat the margin. | One reseller customer's bad week of unbudgeted LLM/API spend. |
| 2 | **Auto-provisioned entitlements + runtime metering** — `signUp` derives entitlements from the plan; check access and consume usage while the request is in flight. | Hand-build a subscriptions + entitlements table and scatter `if (plan === ...)` checks through product code. | Every packaging change becomes a code change + redeploy. |
| 3 | **Wallets & credits with reservations** — purchased, granted, reserved, and consumed balances kept distinct from entitlement grants. | Conflate credits, grants, and quantities in ad-hoc columns. | Denials you cannot explain; refunds you cannot defend. |
| 4 | **Budgeted runs** for jobs, workflows, tools, and agents — `runs.start` reserves a budget envelope *before* the work runs (so it cannot overspend), `consume` draws down, `end` releases the remainder. Generic workload labels, no agent registration. | Hand-roll per-run caps and hope the counter wins the race. | Concurrency leaks over-budget work through silently. |
| 5 | **Explainable invoice evidence** — every charge traces back to rated usage events and ledger captures. | Reconstruct a disputed line by hand from logs. | Senior-eng + support hours per dispute; eroded trust. |
| 6 | **One inspectable, open money path** — AGPL-3.0 core, explicit schemas, generated SDK. | Trust a black-box billing vendor with your margin logic. | No audit trail; vendor owns your revenue truth. |
| 7 | **Pricing flexibility without rewrites** — flat, tiered, package, usage, and hybrid share one mental model; plan versions + customer migration. | Rebuild plan logic across app, billing scripts, and cron. | Pricing experiments blocked on engineering tickets. |
| 8 | **Your payments, your account** — start on the built-in Sandbox (no real processor), then connect your own Stripe via Stripe Connect or your own key. Unprice never sits in your funds flow. | Re-platform billing, or route your revenue through a vendor's account, to change one pricing rule. | Lock-in anxiety on the most critical system you run. |

**The anchor line:** add up rows 1, 5, and 7 for one quarter. That number — runaway spend you could
not stop, disputes you reconstructed by hand, and pricing changes you could not ship — is what the
status quo already charges you. The offer asks for one request path in return.

---

## Stacked Bonuses

Hormozi bonuses solve the buyer's *next* problem and pre-empt objections. Each of these is real and
shippable from the existing product surface.

- **Bonus 1 — The Expensive-Action Map.** A short worksheet to find the single action that creates
  real cost (LLM call, data job, third-party API, multi-minute workflow, tool run) and model it as
  request → meter → entitlement → budget → credits → invoice. *Kills the "where do I even start"
  objection.*
- **Bonus 2 — The One-Request-Path Quickstart.** The honest minimum: define one plan, call
  `customers.signUp` (it provisions the subscription + entitlements for you), then guard one action
  with `access.check` — runnable end-to-end on Sandbox before any real processor. *Collapses Time
  Delay.*
- **Bonus 3 — The Invoice-Evidence Trail.** The replayable event-to-ledger path that lets support
  answer "why was I charged this?" without paging an engineer. *Kills the dispute-cost objection.*
- **Bonus 4 — The Inspectable Core.** The AGPL-3.0 source for the money path itself — read every line
  that guards your revenue before you depend on it. *Kills the "is it safe / what if you disappear"
  objection.*
- **Bonus 5 — Plan Versioning & Migration.** Version plans and migrate customers without rewriting
  product code, so the first win does not become tomorrow's ceiling. *Kills the "I'll outgrow it"
  objection.*

---

## The Guarantee (Layered Risk Reversal)

For this buyer the real fear is **not** the price — the core is open source and free to self-host.
The real fear is *architectural*: "Will I put money logic somewhere I'll regret?" So the guarantee
reverses **implementation risk**, not purchase risk. Two layers:

### 1. The Inspectable-Core Guarantee (anti-black-box)

> The code that guards your money is open. Read the exact money-path logic before you trust it, run
> it on your own infrastructure under AGPL-3.0, and keep your own data. No hidden pricing logic, no
> vendor lock-in, no black box between your product and your margin.

Hormozi type: **unconditional transparency** — stronger than money-back for infrastructure, because
the buyer can verify the claim themselves instead of trusting it.

### 2. The One-Action Fit Check (conditional)

> Bring one expensive action and model it as a money path — request, meter, entitlement, budget,
> wallet, evidence — before you migrate anything else. If that single path does not make the decision
> clearer and safer than your current counter, cron job, or billing script, you should know **before**
> you move the rest of your stack. We will tell you if it is not a fit.

Hormozi type: **conditional / fit guarantee** — it removes the dominant risk (regret over where the
money logic lives) and signals confidence by inviting disqualification.

### 3. The Shadow-and-Sandbox Guarantee (nothing changes until you trust it)

> Run Unprice in **shadow** next to your current stack first — `access.check` mutates nothing, so you
> compare its decisions against your live logic without touching a single production request. Model the
> full money path — customers, plans, entitlements, budgets, credits, invoices — on the built-in
> **Sandbox** provider before a real dollar moves. Then switch enforcement to `usage.consume` / `runs`
> and connect your **own** Stripe account (Connect or your own key); Unprice never sits in your funds
> flow. Validate with zero exposure, cut over only on the evidence, keep full custody of funds.

Hormozi type: **risk removal by sequencing** — observe → simulate → enforce, with the buyer in control
at every step.

> Honesty note: Unprice is in **alpha**. Frame this as a design-partner advantage ("shape the runtime
> while the core is still being shaped"), not as a hidden risk. The open core *is* the safety net.

---

## Scarcity & Urgency (Real, Not Fake)

No countdown timers. Urgency comes from the buyer's own traffic and from genuine fit.

**Fit-based scarcity (qualification, not a fake limit):**

> Unprice is for teams that can name the expensive action. If your product is pure seat-based SaaS,
> Stripe Billing is probably enough. If a single request can create margin risk, that request needs a
> budget in front of it.

**Cost-of-delay urgency (the deadline is set by your traffic):**

> Every billing cycle you wait, the next runaway customer is already creating cost you cannot claw
> back. The expensive action shipped today; the invoice that explains it is weeks away. The gap
> between those two is the leak.

**Design-partner window (true scarcity, used honestly):**

> The core is open and still being shaped. Early teams get to influence the runtime money path while
> it is still small — a window that closes as the surface stabilizes.

---

## Objection Crushers

| Objection | Answer |
| --- | --- |
| "Why not just Stripe?" | Stripe captures the payment *after* the cost exists. Unprice controls the runtime money path *before* usage creates the cost. Keep Stripe; put the budget decision in front of it. |
| "Why not a Redis counter?" | **Your Redis counter is not a budget.** A counter can say "usage is high." It cannot reliably explain which budget was checked, which credits were reserved, why a request was denied, and how accepted usage became an invoice line — correctly, under concurrency. Unprice keeps all of that on one money path. |
| "Will this replace my billing stack?" | No. Stripe-first today, provider-extensible by design. Unprice sits between product usage and invoice evidence; it does not replace your payment processor, tax, or accounting. |
| "Do I have to move my payments to you? Will you touch my money?" | No. Start on the built-in Sandbox provider (no real processor) to test behavior, then connect **your own** Stripe account via Stripe Connect or your own API key. Charges and payouts run on your account; Unprice never sits in your funds flow. |
| "Do I have to rebuild subscriptions and entitlements?" | No. Define the plan once; `customers.signUp` provisions the customer, subscription, and entitlements (plus credit grants, billing periods, and wallet) in one call. You don't hand-roll those tables. |
| "Will switching disrupt my current billing logic?" | No — adopt it in shadow. `access.check` is read-only and `usage.record` is non-blocking, so you run Unprice's decisions next to your existing stack and provider, compare, and only cut over to enforcement (`usage.consume` / `runs`) when you trust it. |
| "What's the difference between record, consume, and runs?" | `usage.record` reports usage asynchronously and never blocks (usage can exceed funds). `usage.consume` validates synchronously and blocks when funds/limit run out. `runs.*` reserves a budget envelope *before* a multi-step workload runs so it cannot overspend. Lead with consume/runs for spend safety; record is for metering and evidence. |
| "Is this an AI agent platform?" | No. Budgeted runs are generic workload labels. Your app still owns prompts, tools, jobs, traces, and execution. Unprice owns the budget, the credit reservation, and the evidence. |
| "Is it safe enough for money decisions? It's alpha." | The money-path core is open source — audit it before you depend on it. Start with one request path, prove it, then expand. The open core is the guarantee, not a promise to trust. |
| "My pricing is complex — hybrid subscription + usage + credits." | That is the design center: flat, tiered, package, usage, and hybrid share one mental model, and credits stay distinct from entitlement grants. |
| "What if I outgrow it / want to leave?" | You own the code and the data under AGPL-3.0. Version plans and migrate customers without rewriting product code. No lock-in by construction. |

---

## The Assembled Pitch

### The 15-second version (cold open / DM)

> What's the single most expensive action in your product — the LLM call, the data job, the costly
> API? Right now you find out it went over budget at invoice time, when the money's already spent.
> Unprice puts a real-time customer budget in front of that one action, so over-budget work is denied
> before it runs — and every charge can prove why it exists. Open source, one request path to start,
> tested on a sandbox before any real money moves. Want to budget yours?

### The 60-second version (call / founder post)

> For usage-based products, pricing isn't a page — it's a runtime decision. By the time billing runs,
> the expensive work already happened: the LLM call, the data job, the multi-minute workflow. If that
> request should have been blocked, the cost is already created. If a customer disputes it, an
> engineer reconstructs the path by hand.
>
> Most teams patch this with a Redis counter and a cron job. But a counter isn't a budget: it drifts
> from real spend, it leaks over-budget work under concurrency, and it can't explain a denial after
> the fact.
>
> Unprice is open-source PriceOps infrastructure. You name one expensive action, and Unprice puts a
> real-time customer budget in that request path: check entitlement, check budget, reserve or capture
> credits, deny over-budget work before it runs, and keep the invoice evidence from the same money
> trail. Define one plan and a single `signUp` call provisions the customer, subscription, and
> entitlements — no entitlement tables to hand-roll.
>
> Start with one action — and you don't have to disturb your current logic to try it. Run Unprice in
> shadow next to your existing stack (`access.check` is read-only, so it blocks nothing), test the full
> flow on a built-in sandbox with no real processor, then switch enforcement on and connect your own
> Stripe account when you trust it. Unprice never sits in your funds flow. If that path doesn't make the
> decision clearer than your counter, you'll know before you migrate the rest — and the core is open
> source, so you can read the exact code that guards your money first.
>
> Budget the expensive action before it runs.

---

## CTAs (in order of preference)

1. **Budget my expensive action** (primary — concrete, on-brand)
2. **Start with one expensive action** (low-commitment first step)
3. **Explore the request-path SDK** (developer secondary)
4. **Star on GitHub** (community / trust secondary)

Avoid vague CTAs like "Start pricing" or "Get started."

---

## Channel-Ready Snippets

**One-liners (repeatable):**

- Pricing is not a page. Pricing is a runtime decision.
- Put a budget around the expensive action.
- Your Redis counter is not a budget.
- Stop the cost before it's created.
- Every charge should carry its own evidence.

**Cold DM (founder-to-founder):**

> Saw you're shipping usage-based [AI/API]. Quick one: what's the most expensive single action a
> customer can trigger, and what stops one account from blowing past budget *before* the invoice
> runs? If the answer is "a counter and a cron job," that's the leak we close. Unprice is open-source
> PriceOps infra — one request path to start, test it on a sandbox, then connect your own Stripe.
> Worth 10 minutes?

**Tweet/post:**

> For usage-based SaaS, the invoice is the autopsy — the money's already spent.
>
> Unprice puts a real-time budget around your most expensive action and denies over-budget work in
> the request path, before the cost is created.
>
> Open source. One action to start. Your own Stripe when you ship.
>
> Budget the expensive action before it runs.

---

## Guardrails Recap (Read Before Shipping Any Of This)

- Keep claims within policy: no exact latency/throughput numbers, no "Stripe replacement," no
  tax/accounting/revenue-recognition, not an "AI agent platform."
- The "only Unprice decides whether expensive usage runs at all" wedge is the canonical competitive
  line, but `positioning-and-messaging.md` flags it as a hypothesis to validate with customer
  interviews. Lead with the mechanism; don't oversell the superlative until proven.
- Do not publish a dollar price for Unprice's own plans — the commercial/hosted tiers are still
  being defined. Anchor on the cost of the status quo and the cost of the DIY stack instead.
- Lead competitive copy against the **DIY stack** (counter + cron + custom tables) first; position
  against vendors second.
- Payments claims: Stripe is the only live real processor (via Stripe Connect to the buyer's own
  account, or bring-your-own-key); **Sandbox** is the default no-processor test mode. Do not claim
  Square (an unimplemented placeholder) or live Paddle/Lemon Squeezy. Always say Unprice never sits
  in the buyer's funds flow.
- Integration claim discipline: the first integration is "define one plan + `signUp` +
  `access.check`," not "one `access.check`." `signUp` is what auto-provisions the subscription and
  entitlements; don't imply entitlements appear without a published plan version that defines the
  feature.
- Don't conflate the decision endpoints: `usage.record` = async, non-blocking (usage can exceed
  funds); `usage.consume` = sync, blocks over-limit; `runs.*` = up-front wallet budget reservation;
  `access.check` = read-only pre-flight. Lead spend-safety copy with `consume` / `runs`.
- "Shadow adoption" is accurate because `access.check` is read-only and `usage.record` is
  non-blocking. Don't sell shadow as a separate product mode or imply it auto-syncs from the buyer's
  provider — it is running Unprice's decision endpoints in parallel without enforcing.
- Voice is **calm urgency**: create urgency with the mechanism, not fear adjectives. Avoid "growth
  platform," "magic billing," "effortless," "revenue OS," "no-code pricing."
