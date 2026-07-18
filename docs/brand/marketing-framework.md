# Marketing Framework

Date: 2026-07-10

Status: active. This is the operating system for all marketing work: ads, posts, emails, DMs,
launch assets, and campaign landing pages. Any agent or person producing a marketing asset reads
this first, then pulls canonical strings from the owners listed in
[`README.md`](README.md) (Canonical Sources).

The governing rule: **sell the incident, not the infrastructure.** Nobody wakes up wanting a money
path; they buy their way out of a moment. Every asset is one incident, told at one altitude, ending
in the one offer.

## The Avatar

Primary avatar: **the margin-responsible founding engineer.**

- Who: founding engineer or CTO — usually the technical co-founder — at a developer-led
  usage-based SaaS product. Company: 2–20 people, pre-seed to Series A. Sharpest slice: AI, API,
  and workflow products selling credits or usage allowances, where one customer-triggered action
  (an LLM call, a data job, a compute run, a third-party API fan-out) creates real marginal cost.
- Two brains, one person: they **buy with the founder brain** (margin eaten by over-budget work,
  disputed invoices, pricing changes that need a deploy) and **evaluate with the engineer brain**
  (SDK surface, source code, latency, blast radius, exit cost). Marketing enters through the
  founder brain and converts through the engineer brain. The door rule: *money at the door, code
  inside the house.*
- When they buy: at a trigger, not from awareness. The triggers are the incidents below — cold
  copy dramatizes an incident; it never opens with the product.
- Where they are: Hacker News, X (dev/AI-builder circles), GitHub, AI-engineering Discords and
  Slacks, LinkedIn (founder mode). They read the README and the docs before the landing page, and
  they screenshot pricing pages that annoy them.
- What they have already tried: a Redis counter with a cron reset; Stripe Billing metered usage;
  an AI-gateway spend cap; hand reconciliation when a customer disputed a bill.
- Voice of customer (dated 2026-07, verify before quoting externally): "Stripe has no way to check
  a customer's balance before they use the product, no way to enforce spend caps." "Billing
  systems are a nightmare for engineers."
- Objections, in the order they raise them: Why not just Stripe? Why not an AI gateway? Is it safe
  enough for money logic? Do I need Cloudflare? Will you get acquired like the rest? All five are
  answered on the landing FAQ and the manifesto; campaign assets link there rather than re-arguing.
- Disqualifiers — do not target, do not chase replies from: pure seat-based SaaS, enterprises
  wanting revenue-recognition/tax/accounting replacement, teams that only need a pricing table,
  buyers requiring multi-provider payment portability on day one.

Secondary avatar (serve, don't target): the platform or product engineer at a Series A team who
owns billing, metering, or entitlements. Same message, deeper integration objections, longer
cycle. Docs and SDK reference carry this persona; paid and outbound effort stays on the primary.

Terminology guard (from `language-and-vocabulary.md`): the avatar is "you", "the team", or "the
builder" — never "the customer." "Customer" always means the avatar's end customer.

## The Incident Bank

Each asset picks exactly one. Hook lines are canonical (owners: `brand-narrative.md`,
`jobs-to-be-done.md`); the mechanism line is always the same sentence.

1. **The over-budget run.** A customer or agent triggered paid work that burned real margin before
   anyone could stop it. Hooks: "The invoice is too late. The work already ran." · "Stop the cost
   before it's created." · "Blocked-too-late cost is margin you already spent."
2. **The disputed invoice.** "Why were we charged $1,204? We set a $500 budget" — and engineering
   becomes invoice support, reconstructing evidence from logs by hand. Hooks: "Both gates say no.
   Only a ledger proves why." · "Counters gate. Ledgers testify." · "Your Redis counter is not a
   budget."
3. **The deploy-to-change-a-price.** Packaging is spread across application code, billing scripts,
   and cron; a pricing experiment costs a sprint. Hooks: "You shouldn't need a deployment to change
   a price." · "Your product is smart, but your pricing is hardcoded."
4. **The acquisition scare** (market trigger, re-activates on news). The billing vendor got bought
   by a processor and the roadmap now belongs to someone else. Hooks: "The billing layer you rent
   can be acquired. The money path you own cannot." · "Your billing layer just got acquired. Now
   what?" Market facts are dated (2026-07): verify the consolidation trace in
   `positioning-and-messaging.md` before each external use.

Mechanism line for all four: **Authorize customer spend before paid work runs.**

## The Altitude Map

Every asset lives at exactly one altitude and links exactly one level deeper.

| Altitude | Job | Language | Surfaces | Metric |
| --- | --- | --- | --- | --- |
| Hook | Make the avatar feel the incident | Money words; zero product nouns | Ads, posts, DMs, OG cards, subject lines | Qualified click-through |
| Mechanism | State the fix in one sentence | "Authorize customer spend before paid work runs" | Hero, post bodies, README pull-quote | Scroll past hero / read time |
| Proof | Make it believable | Live demo, open source, consolidation trace | Landing stations 01–04, manifesto, repo | Demo interaction, stars, docs entry |
| Offer | Make refusing feel dumb | Time-boxed promise + guarantee | Closing CTA (station 05), campaign landings, welcome email | Sandbox signups, founder-note replies |

Rules:

- Hooks contain no product nouns. "Entitlements", "ledger", "PriceOps", "plan versions" never
  appear at hook altitude.
- Proof surfaces never hype. Claims stay inside the Claim Boundaries in `PRODUCT.md`.
- Every asset answers two questions before it is written: *which incident?* and *which altitude?*
  If either has no answer, the asset is not written.

## The Offer

One offer everywhere, restated at every conversion point. Long-form owner:
[`the-expensive-action-offer.md`](the-expensive-action-offer.md); landing-page mapping:
[`landing-page-grand-slam-offer.md`](landing-page-grand-slam-offer.md).

- Promise: **Start with one paid action in one afternoon** — define the plan version, install the
  SDK, sign up one customer against that plan (`customers.signUp` returns the customerId the check
  needs), run the decision in shadow beside the logic you already trust, prove it on Sandbox before
  a real dollar moves. The customer step is always stated — the check does not run without one.
- Ad-ready compression: "Put a budget and an evidence trail around the expensive action in your
  product — one paid action, one afternoon, free during early access, open source. If the
  decisions never match your reality, delete one line and walk away."
- Risk reversal: **The walk-away guarantee** (shipped inside the landing's closing offer station,
  08 as of 2026-07-18). Shadow is read-only;
  exit is deleting one line; nothing in the buyer's stack changes. Stated honestly: the only trace
  left behind is the one test customer signed up inside Unprice.
- Price frame: free is explained, never bare — AGPL core in your own account, hosted cloud free
  during early access with no card, payments settle to your own Stripe either way.
- Honest scarcity: design-partner slots ("I onboard N design partners personally"). Never fake
  countdowns, never fake stock.
- Placement law: **campaigns lead with the offer; the landing page restates it at the point of
  conversion.** An ad that promises what the page never restates leaks conversion at the moment of
  highest intent. Ad-to-page message match is mandatory.
- CTA system (owner: `language-and-vocabulary.md`): primary "Start with one paid action";
  founder-note variant "Map my paid action"; secondary "Explore the request-path SDK". Retired:
  "Start pricing", "Get started", "Learn more".

## Channel Motion (pre-launch → launch)

1. **Design partners — the primary sales motion.** Ten white-glove partners recruited by DM/email
   using the demo-script angle: "Show me the paid action in your product that can burn a
   customer's credits — we'll authorize it before it runs, in one afternoon, free." The landing
   founder note is the same script; treat replies as the pipeline. Each partner is expected to
   yield the missing proof assets: a testimonial, a logo, a case study with real numbers.
2. **Founder-led content, three posts per week,** drawn from the incident bank; every post ends
   with the same offer line. Channels: X and Hacker News first, LinkedIn re-post second.
3. **News-jacking consolidation.** Every billing/metering acquisition re-activates incident 4; the
   manifesto's dated trace is the receipt. Prepared angle: "Your billing layer just got acquired.
   Now what?"
4. **Launch: Show HN** with the manifesto as the companion argument and the live demo as the first
   link in comments.
5. **Paid ads: not yet.** No cold paid spend before at least five proof assets (logos,
   testimonials, case numbers) exist. Then retargeting and branded search only.

## Measurement

One metric per altitude (see table above). Weekly review asks one question: *how many times did
the wedge repeat in front of the avatar this week* — repetitions of one message to one persona,
not impressions. Secondary check: founder-note replies and Sandbox signups per content piece, so
hooks that never convert get retired.

## Pre-Publish Checklist

Run for every asset, no exceptions:

1. Which incident? Which altitude? (No answer → do not publish.)
2. Hook in money language, zero product nouns?
3. Mechanism sentence verbatim from canon?
4. Claims inside `PRODUCT.md` Claim Boundaries; dated market facts re-verified?
5. CTA from the approved CTA system?
6. Voice check: precise, calm, no hype adjectives, no exclamation points, buyer never called "the
   customer"?
7. Does the destination page restate the promise the asset makes?

## Canonical Ownership

This document owns: the avatar, the incident bank, the altitude map, offer placement, channel
motion, and measurement. It references — and must not restate — the positioning statement and
headline (`positioning-and-messaging.md`), the offer long-form (`the-expensive-action-offer.md`),
voice and claims policy (`brand-identity.md`), and approved strings
(`language-and-vocabulary.md`). When this document and an owner disagree, the owner wins; fix this
file to match.
