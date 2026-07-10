# Brand And Design Documentation

Date: 2026-07-03

Status: pre-validation refresh (July 2026 market audit). Run the Validation Plan in
`jobs-to-be-done.md`, fold in the interview evidence, then lock these documents.

These documents define how Unprice should present itself in product UI, marketing pages, docs,
sales demos, and developer examples.

They are internal source-of-truth documents. They do not replace API docs, ADRs, or implementation
plans.

## Canonical Brand (Quick Reference)

Do not re-derive these. Copy from here; if they change, change them here first.

- Public frame: open-source customer money path for usage-based SaaS.
- PriceOps: internal operating model for pricing as versioned commercial infrastructure — plan versions,
  subscriptions, entitlements, meters, budgets, credits, usage evidence, and invoice evidence stay
  separate but connected.
- PriceOps manifesto: entitlements should not be hardcoded into subscriptions; customers can stay
  pinned to the plan version they bought while the team ships new pricing experiments.
- Wedge: customer spend authorization with invoice evidence — authorize customer spend before paid
  work runs, then prove every allow, deny, charge, credit, and invoice line after.
- Headline: Authorize customer spend before paid work runs.
- Rallying cry: Authorize customer spend before paid work runs.
- Promise line: Sell credits and usage-based plans without eating over-budget customer work.
- Name meaning: "Unprice" = un-hardcoding pricing from your codebase, not removing price.
- Payments: Stripe-first today, provider-extensible by design. Unprice never sits in the buyer's
  funds flow.
- Business model: open-core (AGPL-3.0 plus a commercial license).
- Primary buyers: developer-led usage-based SaaS teams — CTOs, founding engineers, platform
  engineers. AI/API and workflow products are the sharpest early slice.
- Contrast: gateways cap provider spend; Unprice governs what the buyer's customer is allowed to
  spend and connects that decision to invoice evidence.
- Why now (dated 2026-07; verify before external use): the independent billing layer consolidated
  into payment processors (Stripe/Metronome, Adyen/Orb, Kong/OpenMeter). Authorization alone is a
  contested claim (Stigg); the open, forkable authorization runtime is not. Full context in
  `positioning-and-messaging.md` Market Context.

## Terminology

- "team", "builder", or "you" = the Unprice buyer (developer-led SaaS team).
- "customer" or "account" = the buyer's end customer, the economic actor holding subscriptions,
  budgets, wallets, and invoices.
- Never call the Unprice buyer "the customer."

## Canonical Sources (Avoid Drift)

Each fact has one owner. Other docs should reference, not restate, the owner.

| Fact | Canonical owner |
| --- | --- |
| Positioning statement, category, headline, message hierarchy, competitor contrast | `positioning-and-messaging.md` |
| Claims policy, voice, tone, name meaning, terminology, visual direction | `brand-identity.md` |
| Product nouns, verbs, CTAs, state language, and surface-specific copy rules | `language-and-vocabulary.md` |
| Product definition, ICP, pillars, claim boundaries, business model | `PRODUCT.md` |
| Narrative, pitches, demo script, rallying cry | `brand-narrative.md` |
| JTBD, triggers, switch forces, copy-review checklist | `jobs-to-be-done.md` |
| Marketing avatar, incident bank, altitude map, offer placement, channel motion | `marketing-framework.md` |
| UI/marketing design rules, signature visual | `design-system-guidelines.md` |

## Governance

- Owner: founder/brand lead. Review at least quarterly and whenever positioning, ICP, claims, or the
  payments boundary change.
- When two docs disagree, the canonical owner above wins; fix the non-owner to match.

## Documents

- [Product](PRODUCT.md): app-level product source of truth, primary market, product purpose,
  positioning, product pillars, claim boundaries, and UX principles.
- [Brand Identity](brand-identity.md): positioning, personality, messaging pillars, voice,
  vocabulary, claims policy, and high-level visual direction.
- [Language And Vocabulary](language-and-vocabulary.md): product nouns, proper verbs, state
  language, CTAs, replacement dictionary, surface-specific copy rules, and review checklist.
- [Brand Narrative](brand-narrative.md): core story, rallying cry, pitch variants, demo script,
  repeatable lines, and narrative guardrails.
- [Positioning And Messaging](positioning-and-messaging.md): canonical source for beachhead market,
  ICP, category, positioning statement, headline, message hierarchy, competitor contrast, and GTM
  message discipline.
- [Jobs To Be Done](jobs-to-be-done.md): core job, trigger priority, switch forces, campaign
  angles, and copy-review checklist for marketing and launch work.
- [Marketing Framework](marketing-framework.md): the marketing operating system — avatar, incident
  bank, altitude map, offer placement, channel motion, measurement, and the pre-publish checklist
  for every ad, post, email, and launch asset.
- [Launch Plan](launch-plan.md): the active campaign instance of the framework — the quiet engine
  (interception, design-partner outreach, weekly receipts), the three signature attention moves
  (Overspend Challenge, Billing Graveyard, Invoice Autopsy), the Show HN launch playbook, calendar,
  budget, and kill criteria.
- [Design System Guidelines](design-system-guidelines.md): product UI and marketing design rules
  for layout, color, typography, components, states, and motion.
- [Design Tokens](design-tokens.md): canonical color and logo token reference, grounded in the
  Tailwind theme engine and Radix scales. Brand identity tokens vs product semantic tokens.

## How To Use

Read these before changing:

- the landing page, pricing pages, or public docs
- dashboard information architecture or visual style
- onboarding, quickstarts, or SDK examples
- sales/demo copy, README positioning, or launch assets
- any marketing asset — ads, posts, emails, DMs, campaigns (start with `marketing-framework.md`)

When product behavior and these docs conflict, the code wins. Update the docs after verifying the
implemented behavior.
