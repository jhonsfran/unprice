# The Expensive-Action Offer (Grand Slam Offer)

Date: 2026-07-02

## What This Is

A complete, packaged Grand Slam Offer for Unprice, built with Alex Hormozi's `$100M Offers`
frameworks: the Value Equation, a stacked value/bonus ladder, a layered guarantee, fit-based
scarcity, and a MAGIC-formula name. It is the "make them feel stupid saying no" version of the
pitch.

**Claims guardrails (do not break):** no exact latency/throughput numbers, no "Stripe replacement,"
no tax/accounting/revenue-recognition coverage, not an "AI agent platform." Payments: Stripe-first
today (via Stripe Connect to the buyer's own account, or bring-your-own-key) plus the built-in
**Sandbox** test provider; do not claim Square (an unimplemented placeholder) or live
Paddle/Lemon Squeezy. Lead with the customer money path, not cold category language.

---

## The One-Sentence Offer

> Bring the one paid action in your product that can burn a customer's credits, budget, or usage
> allowance. In one afternoon, define the plan version, install the SDK, provision or map one
> customer, and run Unprice in shadow beside your current logic. You see whether that action should
> be allowed, which customer budget or credits apply, and what evidence will explain the invoice line
> later — before you enforce anything, before you move payments, and before a real dollar moves.

---

## The Offer Name (MAGIC Formula)

**Primary:** **The One-Afternoon Paid-Action Sprint**

| MAGIC | How it is satisfied |
| --- | --- |
| **M**ake it about them | "Your paid action," "your margin," "your invoice evidence," "your request path." The hero is the builder's money path, not our platform. |
| **A**nnounce the avatar | Developer-led usage-based SaaS teams with paid actions that affect margin, invoice trust, or pricing flexibility (CTOs, founding engineers, platform engineers). |
| **G**ive them a goal | Authorize customer spend before one paid action runs and prove the charge after it bills. |
| **I**ndicate a time interval | One afternoon to get the first action into shadow, not a quarter-long billing migration. |
| **C**omplete with a container word | "Sprint" (the container). Alternatives below. |

**Approved alternates (same wedge, different energy):**

- **The One Paid Action Fit Check** — use as the low-friction first meeting / trial motion.
- **Budget The Expensive Action** — the established rallying-cry name; safest, most on-brand for
  campaigns.
- **The Expensive-Action Evidence Sprint** — use when the buyer's acute pain is invoice disputes or
  support explanation rather than raw cost.
- **The Margin Firewall** — louder, still mechanism-grounded (a budget that rejects over-budget work
  in the request path behaves like a firewall for spend). Use for campaigns, not the core doc.
- **The Paid-Usage Gate** — compact and direct, but less complete than the before/after promise.

Do not rename the product or category. This names the *offer*, not the product.

---

## The Value Equation

```
Value = (Dream Outcome x Perceived Likelihood) / (Time Delay x Effort & Sacrifice)
```

Every line of the offer is engineered to push the two numerators up and the two denominators down.

| Lever | Direction | The move in this offer |
| --- | --- | --- |
| **Dream Outcome** | Maximize | **Customer spend control with proof**: *"The paid action is allowed before cost is created, and the invoice line can defend itself after."* The win is emotional as much as technical: no surprise margin leak, no support panic, no founding engineer spending Friday reconstructing why a customer was charged. |
| **Perceived Likelihood** | Maximize | Shrink the promise to one plan version, one paid action, one shadow authorization path, one evidence trail. Back it with a workflow-app demo video that shows the exact path: create the plan, install the SDK, run `access.check` in shadow, simulate on Sandbox, then inspect the invoice evidence. The core is **open source** — they can read the money-path code before trusting it. Start small, prove it, expand. |
| **Time Delay** | Minimize | **One paid action in one afternoon.** No full billing migration, no payment-provider move, and no production enforcement to start. Define one plan version, provision or map one customer with `signUp`, install the SDK, and place a read-only shadow check beside the existing logic. |
| **Effort & Sacrifice** | Minimize | Adopt in **shadow** first: `access.check` mutates nothing and `usage.record` is non-blocking, so production behavior stays unchanged while you compare decisions. You don't hand-build subscription or entitlement tables — `signUp` provisions them from the plan version. When you go live, connect **your own** Stripe account (Stripe Connect or your own key); Unprice never sits in your funds flow. Generated SDK, explicit schemas, no black box. |

The strategic result: the *value* (protected margin, fewer invoice disputes, eliminated DIY build,
and safer pricing changes) is large and the *price* (one afternoon, one plan version, one SDK path
in shadow) is small. That gap is the offer.

## Proof Asset: The Workflow-App Demo

Use the planned video to increase perceived likelihood. The demo should show a real workflow app,
not a dashboard tour:

1. Pick the workflow action that costs money or creates invoice questions.
2. Create the plan version and pricing rule.
3. Install the SDK and provision or map one customer.
4. Add `access.check` beside the current product logic as a shadow decision.
5. Run the workflow and show what Unprice would allow, deny, budget, or reserve.
6. Simulate the path on Sandbox and click the invoice evidence: plan version, pricing rule, usage
   facts when present, wallet movement, ledger captures, and billing period.

The viewer should leave with one thought: *"I can try this on one action without trusting it with my
whole billing stack."*

---

## What The First Afternoon Actually Is

The first step is not a billing migration. It is one afternoon proving whether Unprice makes a
single paid action clearer than the stack the team already trusts.

1. **Name the action.** Pick the customer-triggered workflow, API call, job, package, or tier that
   can burn margin or create invoice confusion.
2. **Define one plan version.** Create the feature and pricing rule you want that action to obey.
   The plan version becomes the entitlement map for assigned customers.
3. **Install the SDK and provision or map one customer.** `customers.signUp({ planSlug |
   planVersionId, ... })` creates the customer, subscription, phase, entitlements, credit grants,
   billing periods, and wallet in one transaction when Unprice owns the signup path. Existing
   customers can be mapped into the same proof path before broader migration.
4. **Run the decision in shadow.** Put `access.check({ customerId, featureSlug })` beside the
   current product check and log what Unprice *would* decide. For usage evidence, mirror with
   `usage.record` where appropriate. Nothing blocks production traffic yet.

The honest version of "low effort": one plan version, one customer path, one SDK check in shadow.
Unprice owns the subscription + entitlement provisioning you would otherwise hand-roll.

## Pick The Right Decision: Observe, Enforce, Or Reserve

Four runtime operations — and the difference is the product. Don't conflate them:

| Operation | Sync? | Blocks over-budget? | Mutates | Use it to |
| --- | --- | --- | --- | --- |
| `access.check` | sync | — (read-only) | nothing | Pre-flight: ask "is this customer commercially allowed?" before doing the work. Safe to call anywhere, including in shadow. |
| `usage.record` | **async** | **No** | meter (eventual, non-enforcing) | **Report** usage for metering and invoice evidence. Usage *can* exceed funds — it is fire-and-forget, not a gate. |
| `usage.consume` | **sync** | **Yes** | meter (real-time, enforcing) | **Enforce** in the request path: validate in real time and deny (`LIMIT_EXCEEDED`) the moment funds/limit run out. |
| `runs.start` / `consume` / `end` | sync | **Yes, up front** | wallet reservation | **Reserve** a budget envelope *before* a multi-step workload runs, so it cannot overspend. `start` holds the funds, `consume` draws down, `end` releases the remainder. |

The one-line mental model:

- **`record` = "tell me later."** Async, never blocks; usage can overshoot funds.
- **`consume` = "decide now."** Sync, blocks the moment funds/limit are exhausted.
- **`runs` = "ring-fence it first."** Reserve the budget before the work starts, so the run is guaranteed not to overspend.

Lead the offer with `access.check` / `usage.consume` / `runs` — that is the customer-spend
authorization wedge. `record` is for metering and invoice evidence, not spend safety.

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
  processor. Model customers, plan versions, entitlements, budgets, and credits, and watch how
  billing behaves, before connecting real money.
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
| 1 | **Customer spend authorization for one paid action** — check entitlement, budget, credits, and meter rules in the request path before work runs. | Let the action run first and reconcile later. | The work already ran, the cost is real, and now the team has to defend it. |
| 2 | **Explainable invoice evidence** — every charge traces back to the plan version, pricing rule, billing period, rated usage events when present, wallet movement, and ledger captures. | Reconstruct a disputed line by hand from logs. | Senior engineering time turns into invoice forensics; customer trust drops while everyone waits. |
| 3 | **Auto-provisioned entitlements + runtime metering** — `signUp` derives entitlements from the plan version; check access and consume usage while the request is in flight. | Hand-build a subscriptions + entitlements table and scatter `if (plan === ...)` checks through product code. | Every packaging change feels like touching a live wire: app code, billing scripts, and support rules all move together. |
| 4 | **Wallets & credits with reservations** — purchased, granted, reserved, and consumed balances kept distinct from entitlement grants. | Conflate credits, grants, and quantities in ad-hoc columns. | Denials you cannot explain; refunds you cannot defend. |
| 5 | **Budgeted runs** for jobs, workflows, tools, and agents — `runs.start` reserves a budget envelope *before* the work runs (so it cannot overspend), `consume` draws down, `end` releases the remainder. Generic workload labels, no agent registration. | Hand-roll per-run caps and hope the counter wins the race. | Concurrency leaks over-budget work through silently. |
| 6 | **One inspectable, open money path** — AGPL-3.0 core, explicit schemas, generated SDK. | Trust a black-box billing vendor with your margin logic. | No audit trail; vendor owns your revenue truth. |
| 7 | **Pricing experiments without moving old customers** — flat, tiered, package, usage, credit-based, and hybrid share one mental model; plan versions keep customers on the pricing they bought. | Rebuild plan logic across app, billing scripts, and cron. | Pricing experiments blocked on engineering tickets or risky migrations. |
| 8 | **Your payments, your account** — start on the built-in Sandbox (no real processor), then connect your own Stripe via Stripe Connect or your own key. Unprice never sits in your funds flow. | Re-platform billing, or route your revenue through a vendor's account, to change one pricing rule. | Lock-in anxiety on the most critical system you run. |

**The anchor line:** add up rows 1, 2, and 7 for one quarter. That number — paid usage you could not
authorize, disputes you reconstructed by hand, and pricing changes you could not ship — is what the
status quo already charges you. The offer asks for one afternoon and one request path in return.

---

## Stacked Bonuses

Hormozi bonuses solve the buyer's *next* problem and pre-empt objections. Each of these is real and
shippable from the existing product surface.

- **Bonus 1 — The Workflow-App Shadow Demo.** A short video showing one workflow action move from
  hardcoded product logic to Unprice shadow authorization, Sandbox simulation, and invoice evidence.
  *Kills the "I don't believe this is that fast" objection.*
- **Bonus 2 — The Paid-Action Map.** A short worksheet to find the product action that creates cost
  or invoice confusion (LLM call, data job, third-party API, multi-minute workflow, tool run) and
  model it as request → plan version → meter → entitlement → budget → credits → invoice. *Kills the
  "where do I even start" objection.*
- **Bonus 3 — The One-Request-Path Quickstart.** The honest minimum: define one plan, call
  `customers.signUp` (it provisions the subscription + entitlements for you), then guard one action
  with `access.check` — runnable end-to-end on Sandbox before any real processor. *Collapses Time
  Delay.*
- **Bonus 4 — The Invoice-Evidence Trail.** The replayable event-to-ledger path that lets support
  answer "why was I charged this?" without paging an engineer. *Kills the dispute-cost objection.*
- **Bonus 5 — The Inspectable Core.** The AGPL-3.0 source for the money path itself — read every line
  that guards your revenue before you depend on it. *Kills the "is it safe / what if you disappear"
  objection.*
- **Bonus 6 — Plan Versioning Without Surprise Migration.** Version plans and keep existing
  customers on the pricing they bought while new experiments ship, so the first win does not become
  tomorrow's ceiling. *Kills the "I'll outgrow it" objection.*

---

## The Guarantee (Layered Risk Reversal)

For this buyer the real fear is **not** the price — the core is open source and free to self-host.
The real fear is *architectural*: "Will I put money logic somewhere I'll regret?" So the guarantee
reverses **implementation risk**, not purchase risk. Two layers:

### 1. The Inspectable-Core Guarantee (anti-black-box)

> The code that guards your money is open. Read the exact money-path logic before you trust it — or
> have your agent read it — run it on your own infrastructure under AGPL-3.0, and keep your own
> data. No hidden pricing logic, no vendor lock-in, no black box between your product and your
> margin — and no acquisition risk: a forkable money path cannot be bought out from under you.

Hormozi type: **unconditional transparency** — stronger than money-back for infrastructure, because
the buyer can verify the claim themselves instead of trusting it.

### 2. The One-Afternoon Fit Check (conditional)

> Bring one paid action and model it as a money path — request, plan version, meter, entitlement,
> budget, wallet, evidence — before you migrate anything else. In one working session, the path
> should become clearer than your current counter, cron job, or billing script. If we cannot show
> that on one action, you should know **before** you move the rest of your stack. We will tell you if
> it is not a fit.

Hormozi type: **conditional / fit guarantee** — it removes the dominant risk (regret over where the
money logic lives) and signals confidence by inviting disqualification.

### 3. The Shadow-and-Sandbox Guarantee (nothing changes until you trust it)

> Run Unprice in **shadow** next to your current stack first — `access.check` mutates nothing, so you
> compare its decisions against your live logic without touching a single production request. Model
> the full money path — customers, plan versions, entitlements, budgets, credits, invoices — on the
> built-in **Sandbox** provider before a real dollar moves. Then switch enforcement to
> `usage.consume` / `runs` and connect your **own** Stripe account (Connect or your own key); Unprice
> never sits in your funds flow. Validate with zero exposure, cut over only on the evidence, keep
> full custody of funds.

Hormozi type: **risk removal by sequencing** — observe → simulate → enforce, with the buyer in control
at every step.

> Honesty note: Unprice is in **alpha**. Frame this as a design-partner advantage ("shape the runtime
> while the core is still being shaped"), not as a hidden risk. The open core *is* the safety net.

---

## Scarcity & Urgency (Real, Not Fake)

No countdown timers. Urgency comes from the buyer's own traffic and from genuine fit.

**Fit-based scarcity (qualification, not a fake limit):**

> Unprice is for teams that can name the paid action. If your product is pure seat-based SaaS,
> Stripe Billing is probably enough. If a single request can create margin risk or invoice confusion,
> that request needs customer spend authorization and evidence around it.

**Cost-of-delay urgency (the deadline is set by your traffic):**

> Every billing cycle you wait, the next confusing or over-budget customer action is already
> creating cost you cannot claw back or invoice lines support cannot explain. The paid action shipped
> today; the invoice that explains it is weeks away. That gap is where margin leaks, trust burns, and
> engineering turns into invoice support.

**Design-partner window (true scarcity, used honestly):**

> The core is open and still being shaped. Early teams get to influence the runtime money path while
> it is still small — a window that closes as the surface stabilizes.

---

## Objection Crushers

| Objection | Answer |
| --- | --- |
| "Why not just Stripe?" | Stripe captures the payment and issues the invoice. Unprice owns the customer money path before and around that invoice: plan version, entitlement, usage, budget, credit, and evidence. Keep Stripe; put customer spend authorization in front of paid usage. |
| "Why not an AI gateway?" | Gateways cap provider spend, route models, and manage virtual keys. Unprice governs what your customer is allowed to spend and connects that decision to plan versions, credits, and invoice evidence. |
| "Why not Stigg?" | Stigg is a strong closed usage runtime. Use Unprice when you want the request-to-invoice money path in open source: inspect it, self-host it, adapt it, and keep the budget check, credit reservation, and invoice evidence together. |
| "Why not a Redis counter?" | **Your Redis counter is not a budget.** A counter can say "usage is high." It cannot reliably explain which budget was checked, which credits were reserved, why a request was denied, and how accepted usage became an invoice line — correctly, under concurrency. Unprice keeps all of that on one money path. |
| "Will this replace my billing stack?" | No. Stripe-first today, provider-extensible by design. Unprice sits between product usage and invoice evidence; it does not replace your payment processor, tax, or accounting. |
| "Do I have to move my payments to you? Will you touch my money?" | No. Start on the built-in Sandbox provider (no real processor) to test behavior, then connect **your own** Stripe account via Stripe Connect or your own API key. Charges and payouts run on your account; Unprice never sits in your funds flow. |
| "Do I have to rebuild subscriptions and entitlements?" | No. Define the plan version once; `customers.signUp` provisions the customer, subscription, and entitlements (plus credit grants, billing periods, and wallet) in one call. You don't hand-roll those tables. |
| "Why separate entitlements from subscriptions?" | Because pricing changes should not silently rewrite the rights a customer already bought. Plan versions let new pricing experiments ship while existing customers stay attached to their versioned entitlement map. |
| "Will switching disrupt my current billing logic?" | No — adopt it in shadow. `access.check` is read-only and `usage.record` is non-blocking, so you run Unprice's decisions next to your existing stack and provider, compare, and only cut over to enforcement (`usage.consume` / `runs`) when you trust it. |
| "What's the difference between record, consume, and runs?" | `usage.record` reports usage asynchronously and never blocks (usage can exceed funds). `usage.consume` validates synchronously and blocks when funds/limit run out. `runs.*` reserves a budget envelope *before* a multi-step workload runs so it cannot overspend. Lead with the operation that matches the paid action: `access.check`, `consume`, or `runs`; record is for metering and evidence. |
| "Is this an AI agent platform?" | No. Budgeted runs are generic workload labels. Your app still owns prompts, tools, jobs, traces, and execution. Unprice owns the budget, the credit reservation, and the evidence. |
| "Is it safe enough for money decisions? It's alpha." | The money-path core is open source — audit it before you depend on it. Start with one request path, prove it, then expand. The open core is the guarantee, not a promise to trust. |
| "My pricing is complex — hybrid subscription + usage + credits." | That is the design center: flat, tiered, package, usage, credit-based, and hybrid share one mental model; credits stay distinct from entitlement grants, and plan versions keep experiments contained. |
| "What if I outgrow it / want to leave?" | You own the code and the data under AGPL-3.0. Version plans and migrate customers without rewriting product code. No lock-in by construction. |

---

## The Assembled Pitch

### The 15-second version (cold open / DM)

> What's the paid action in your product that can burn margin or create invoice confusion — the LLM
> call, the data job, the costly API, the workflow run? Right now you find out at invoice time, when
> the work already ran and the cost is real. Unprice lets you put that one action in shadow in one
> afternoon, then prove the decision on Sandbox before you enforce anything. Want to map yours?

### The 60-second version (call / founder post)

> For usage-based products, pricing isn't a page — it's a runtime decision and an evidence trail. By
> the time billing runs, the paid work already happened: the LLM call, the data job, the multi-minute
> workflow. If that request should have been blocked, the cost is already created. If a customer
> disputes it, someone has to stop building product and prove why the charge exists.
>
> Most teams patch this with a Redis counter and a cron job. But a counter isn't a budget: it drifts
> from real spend, it leaks over-budget work under concurrency, and it can't explain a denial after
> the fact.
>
> Unprice is the open-source customer money path for usage-based SaaS. You name one paid action, and Unprice
> puts customer spend authorization in that request path: check plan version, entitlement, budget,
> credits, and meter rules before it runs, then keep the invoice evidence from the same money trail. Define
> one plan version and a single `signUp` call provisions the customer, subscription, and entitlements
> — no entitlement tables to hand-roll.
>
> Start with one action in one afternoon — and you don't have to disturb your current logic to try it.
> Run Unprice in shadow next to your existing stack (`access.check` is read-only, so it blocks
> nothing), test the full flow on a built-in sandbox with no real processor, then switch enforcement
> on and connect your own Stripe account when you trust it. Unprice never sits in your funds flow. If
> that path doesn't make the decision clearer than your counter, you'll know before you migrate the
> rest — and the core is open source, so you can read the exact code that guards your money first.
>
> Authorize the paid action before it runs. Prove the charge after it bills.

---

## CTAs (in order of preference)

1. **Start with one paid action** (primary — low-commitment, outcome-oriented)
2. **Map my paid action** (consultative / design-partner motion)
3. **Watch the workflow demo** (proof asset once the video is live)
4. **Budget my expensive action** (campaign / high-cost use case)
5. **Explore the request-path SDK** (developer secondary)
6. **Star on GitHub** (community / trust secondary)

Avoid vague CTAs like "Start pricing" or "Get started."

---

## Channel-Ready Snippets

**One-liners (repeatable):**

- Pricing is not a page. Pricing is a runtime decision and an evidence trail.
- Authorize customer spend before paid work runs.
- Prove every charge after it bills.
- Put a budget and evidence trail around the expensive action.
- Your Redis counter is not a budget.
- One paid action in one afternoon.
- Stop the cost before it's created.
- Every charge should carry its own evidence.

**Cold DM (founder-to-founder):**

> Saw you're shipping usage-based [AI/API/workflows]. Quick one: what's the paid action a customer
> can trigger that either burns margin or creates invoice questions, and what authorizes it before it
> runs? If the answer is "a counter and a cron job," that's the leak we close. Unprice is the
> open-source customer money path — one paid action in one afternoon, run in shadow first, prove it
> on Sandbox, then connect your own Stripe when you trust it. Worth 10 minutes?

**Tweet/post:**

> For usage-based SaaS, the invoice is the autopsy — the work already ran.
>
> Unprice authorizes paid usage before it runs and keeps the evidence that explains every charge
> after it bills.
>
> Open source. One action in one afternoon. Your own Stripe when you ship.
>
> Authorize before. Explain after.

---

## Guardrails Recap (Read Before Shipping Any Of This)

- Keep claims within policy: no exact latency/throughput numbers, no "Stripe replacement," no
  tax/accounting/revenue-recognition, not an "AI agent platform."
- The "authorize before; explain after" wedge is the canonical competitive line, but
  `positioning-and-messaging.md` flags it as a hypothesis to validate with customer interviews.
  Lead with the mechanism; don't oversell superlatives until proven.
- Do not publish a dollar price for Unprice's own plans — the commercial/hosted tiers are still
  being defined. Anchor on the cost of the status quo and the cost of the DIY stack instead.
- Lead competitive copy against the **DIY stack** (counter + cron + custom tables) first; position
  against vendors second.
- Payments claims: Stripe is the only live real processor (via Stripe Connect to the buyer's own
  account, or bring-your-own-key); **Sandbox** is the default no-processor test mode. Do not claim
  Square (an unimplemented placeholder) or live Paddle/Lemon Squeezy. Always say Unprice never sits
  in the buyer's funds flow.
- Integration claim discipline: the first integration is "define one plan version + `signUp` +
  `access.check`," not "one `access.check`." `signUp` is what auto-provisions the subscription and
  entitlements; don't imply entitlements appear without a published plan version that defines the
  feature.
- Don't conflate the decision endpoints: `usage.record` = async, non-blocking (usage can exceed
  funds); `usage.consume` = sync, blocks over-limit; `runs.*` = up-front wallet budget reservation;
  `access.check` = read-only pre-flight. Lead commercial-authorization copy with `access.check` /
  `consume` / `runs` depending on the use case.
- "Shadow adoption" is accurate because `access.check` is read-only and `usage.record` is
  non-blocking. Don't sell shadow as a separate product mode or imply it auto-syncs from the buyer's
  provider — it is running Unprice's decision endpoints in parallel without enforcing.
- Voice is **calm urgency**: create urgency with the mechanism, not fear adjectives. Avoid "growth
  platform," "magic billing," "effortless," "revenue OS," "no-code pricing."
- Keep "one afternoon" mechanically honest: back it with a timed, CI-tested quickstart (plan
  version + `signUp` + `access.check` on Sandbox) before using it as a hard claim in paid
  campaigns. The workflow-demo video and the quickstart are the two proof assets this offer
  depends on; neither has shipped yet.
