# Launch Plan

Date: 2026-07-10

Status: active campaign plan. This is an instance of
[`marketing-framework.md`](marketing-framework.md) — the framework owns the avatar, incident bank,
altitude map, and offer; this document owns launch sequencing, the signature attention moves, and
the channel calendar. Tactical facts about channels (newsletter policies, HN norms) are dated
2026-07; verify before executing.

The operating idea: with no budget and no audience, attention comes from **radical concreteness —
real dollars, real denials, real receipts, real stakes** — not from volume or adjectives. The
brand is receipts; the marketing is receipts. Launch day is not day one of attention; it is the
day accumulated proof gets cashed in. The pre-launch constraint is proof, not reach.

## The Quiet Engine (starts immediately, 60–90 min/day)

The stunts create surface area; this engine is where design partners and customers actually come
from. It never pauses.

1. **Watering-hole interception.** Saved searches, checked daily, on X / HN / Reddit:
   "surprise bill" + API/OpenAI/Anthropic · "spend cap" / "spend limit" customer · "runaway
   agent" cost · "usage limits" billing · "Stripe metered" / "usage-based billing" complaint ·
   "credit system" pricing. Reply with help and receipts (a trace, a concrete pattern), never a
   pitch. Every thread is a hand-raiser; DM follows only after the public reply added value.
2. **Design-partner outreach, 5–10/day.** Script = the landing founder note ("Map my paid
   action") personalized with one observed incident from their product or posts. Sources: YC
   directory (recent batches building agents/AI infra with credit pricing), Latent Space and AI
   Engineer communities, the Cloudflare Discord (they already run on Workers/DOs), and everyone
   surfaced by interception. Target: 10 white-glove partners; each yields a quote, a logo, and
   real numbers.
3. **Build-in-public receipts, 3 posts/week.** Each post = one incident from the incident bank
   told through a real product artifact (ledger screenshot, denial trace, demo clip), ending with
   the offer line. Never architecture-first; money at the door.

## Signature Move 1 — The Overspend Challenge (the throat-grab)

Turns the core claim into a public game with real stakes. Costly signal: no copy can buy the
credibility of real dollars at risk.

- **Phase A (private, week 1):** 3–5 friendly engineers try to break a budget boundary in
  Sandbox. Fix what breaks; keep notes — failures become content.
- **Phase B (public stunt, ~week 3):** "I gave an agent $50 and instructed it to spend $500."
  A real agent, real metered API cost, Unprice as the only boundary. Thread/stream it live;
  publish the full ledger either way. If the boundary holds: proof. If it breaks: publish the
  postmortem — engineers trust flaw-admission more than perfection claims, and it is a second
  story for free.
- **Phase C (standing, monthly):** "Break my budget" rounds with a small bounty ($100–250) and a
  public leaderboard rendered as a ledger. An always-open loop people return to, plus free
  adversarial QA, aimed exactly at the agent-spend wedge.
- Rules published, Sandbox-scoped, honest disclosure. Budget ≤ $300/round including bounty.

## Signature Move 2 — The Billing Graveyard (newsjack infrastructure)

A standalone, linkable page (e.g. `/graveyard`): every independent billing/metering vendor,
dated — acquirer, price, outcome — rendered as ledger rows, ending with "the money path you own
cannot be acquired · git clone …". The manifesto's consolidation trace already exists as a
component; this is half a day of work. Pre-write the activation post template now: every future
acquisition headline gets the updated trace posted within hours. Factual, calm, devastating —
the brand does provocative facts, not hype.

## Signature Move 3 — The Invoice Autopsy (compounding franchise)

Weekly teardown of a real, public runaway-bill or pricing-failure story, rendered in the
product's trace/receipt grammar: timeline rows, the missing checks, the invoice line nobody can
explain. The format is the moat — nobody publishes autopsies as balanced ledgers. Each ends with
the mechanism line and the offer. Sources: public postmortems, HN surprise-bill threads, the
2025 Cursor pricing backlash (the audience's shared memory), agent-overspend stories, classic
cloud-bill horror stories reframed to per-customer margin. Never punch at struggling peers; autopsy
patterns and public giants, not small startups.

## Supporting Moves (opportunistic)

- **The mock-invoice artifact (outbound).** A personalized one-page "invoice" for a target's
  product: "INV-0000 · the over-budget run your pricing allows," line items modeled from their
  public pricing, an empty evidence column, and the note "this invoice cannot explain itself —
  yours shouldn't be able to either." The product's aesthetic as outreach. Send to the 20
  best-fit targets. Must read as obviously well-crafted satire, never as a real bill.
- **Ecosystem borrowing.** "Budget your agent in 5 lines" recipes as examples/PRs in the repos
  the avatar already uses (Vercel AI SDK, LangChain/LangGraph, agent frameworks). Pitch a "built
  on Durable Objects" deep-dive to Cloudflare DevRel (they amplify DO showcases; this is a
  flagship DO use case) and the equivalent to Tinybird.
- **The agent-audit invitation.** "Point your coding agent at the repo and ask whether the ledger
  balances." Ship an auditor prompt file in the repo; make this the best-documented money code an
  agent has ever read. Cohort competitors claim AI-legibility; an audit *invitation* is the
  stronger, falsifiable version.
- **The one-afternoon livestream.** Integrate a volunteer's real product live in one afternoon —
  proves the time promise publicly, recruits partners, and the recording becomes the demo video.
- **Answer-engine presence.** Canonical, code-complete answers on Stack Overflow / Reddit / HN
  for "cap OpenAI spend per customer," "per-customer budget limits," "usage-based spend caps."
  These threads rank, compound, and are what LLMs cite.

## The Launch (Show HN anchor)

**Gate, not date:** launch fires only when ≥5 proof assets exist — 3 partner quotes with real
numbers, one challenge round's receipts, the graveyard live, 4+ autopsy episodes, demo polished.
If the gate isn't met, slip the date, never lower the gate.

- **Anchor: Show HN**, Tuesday–Thursday, 8–10am ET, calendar cleared all day. Title plain, no
  marketing tone — e.g. "Show HN: Deny a customer's over-budget AI spend before it runs (open
  source)". Never solicit upvotes.
- **First comment** (the real landing page): the disputed-invoice incident, what it is and is
  NOT (Cloudflare-only today, Stripe-first, no rev-rec/tax), architecture for the curious
  (Durable Objects, double-entry ledger, reservation pattern), the walk-away guarantee, and a
  direct ask for brutal feedback. HN rewards the anti-sell; the FAQ's "Do not adopt it all at
  once" voice is the register.
- **Launch-week sequence:** Mon — strongest autopsy or graveyard update · Tue/Wed — Show HN +
  same-day X thread with the $50-agent video and receipts · Thu — newsletter submissions
  (Console.dev, TLDR, Changelog News, Latent Space if the agent angle led) · Fri — "what HN
  taught us" post; personal follow-up to every hand-raiser within 24h.
- **Product Hunt:** skip for launch week (weak for infra devtools); optional later.
- **Post-launch loop:** monthly challenge rounds, weekly autopsies, graveyard activations on
  every acquisition headline, partner case receipts as they mature.

## Six-Week Calendar

| Week | Focus |
| --- | --- |
| 1 | Engine on (interception + DMs + 3 posts/wk) · build graveyard page · private challenge with friendlies |
| 2 | Autopsies 1–2 · mock-invoice outbound to 20 targets · fix challenge findings · first partner live (one-afternoon session) |
| 3 | Public $50-agent stunt + thread · ecosystem recipe #1 · partners 2–3 |
| 4 | Challenge round 1 (public, bounty) · autopsies 3–4 · Cloudflare DevRel pitch · first partner receipts |
| 5 | Assemble proof assets · draft Show HN title + first comment · newsletter pitches · load-test the live demo |
| 6 | Launch week sequence (or slip if the proof gate is unmet) |

## Budget

Under $600 for the first 90 days: challenge bounties ($200–500 total), ~$50 of real API spend for
the agent stunt, $0 elsewhere. No cold paid ads (framework rule: not before 5+ proof assets, and
then retargeting + branded search only).

## Measurement and Kill Criteria

Metrics per altitude are owned by the framework. The weekly question: how many times did the
wedge repeat in front of the avatar, and how many founder-note replies + Sandbox signups did it
produce. Kill any tactic after 3 executions with zero qualified replies or signups. The engine
(interception, DMs, weekly receipts) is never killed pre-launch; only stunts rotate.

## Guardrails

- The calm brand does provocative **facts** — receipts, challenges, graveyards — never hype
  adjectives or manufactured urgency.
- Autopsies and graveyards target patterns, public stories, and giants; never name-and-shame
  small peers.
- Every claim stays inside `PRODUCT.md` Claim Boundaries; dated market facts re-verified before
  each use; the buyer is never called "the customer."
- Stunt honesty is absolute: publish the ledger whether the boundary holds or breaks.
