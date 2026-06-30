# Brand And Design Documentation

Date: 2026-06-30

These documents define how Unprice should present itself in product UI, marketing pages, docs,
sales demos, and developer examples.

They are internal source-of-truth documents. They do not replace API docs, ADRs, or implementation
plans.

## Canonical Positioning (Quick Reference)

Do not re-derive these. Copy from here; if they change, change them here first.

- Category: open-source PriceOps runtime for usage-based SaaS.
- PriceOps: operating pricing as live infrastructure (metering, entitlements, budgets, credits,
  invoice evidence) in the request path.
- Wedge: spend safety — stop over-budget usage before it runs.
- Headline: Stop runaway usage before it runs.
- Rallying cry: Put a budget around the expensive action.
- Name meaning: "Unprice" = un-hardcoding pricing from your codebase, not removing price.
- Payments: Stripe-first today, provider-extensible by design (Paddle, Lemon Squeezy, others).
- Business model: open-core (AGPL-3.0 plus a commercial license).
- Primary buyers: developer-led AI/API SaaS teams — CTOs, founding engineers, platform engineers.

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

When product behavior and these docs conflict, the code wins. Update the docs after verifying the
implemented behavior.
