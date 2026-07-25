# Launch-Day Landing Simplification Design

Date: 2026-07-25

Status: approved under delegated launch-day authority

## Goal

Make the landing page explain Unprice in one fast, credible sequence and move a qualified
founding engineer toward one action: **Start with one paid action**.

The page should preserve the existing receipt-and-ledger identity. This is an editorial reduction,
not a visual rebrand.

## Audience And Conversion

The primary visitor is the margin-responsible founding engineer at a usage-based SaaS company.
They buy with the founder brain and evaluate with the engineer brain.

- Primary action: start the paid-action signup flow.
- Secondary proof path: inspect the SDK or source.
- Incident: a customer-triggered paid action creates cost before billing notices.
- Mechanism: authorize customer spend before paid work runs.
- Offer: prove one paid action in shadow, on Sandbox, before enforcement or real payment movement.

## Current Audit

### Technical health

| Dimension | Score | Finding |
| --- | ---: | --- |
| Accessibility | 3/4 | Good semantic figures and labels, but the page nests a second `main` landmark and the integration tabs have undersized touch targets. |
| Performance | 2/4 | Seven landing sections are dynamically imported without layout-preserving fallbacks; most of the page also instantiates client observers. |
| Responsive design | 3/4 | The page has deliberate breakpoints, but dense `nowrap` facts and a three-tab code panel increase mobile risk. |
| Theming | 4/4 | Landing components consistently use semantic surface and state tokens in both themes. |
| Anti-patterns | 3/4 | The ledger language is distinctive, but the comparison matrix and four specimen grid add card-like density and delay the signature mechanism. |
| **Total** | **15/20** | **Good implementation; the launch problem is hierarchy and excess, not visual quality.** |

### Conversion diagnosis

The current page asks the visitor to process:

1. hero;
2. detailed incident trace;
3. four-system comparison;
4. four outcome specimens;
5. a floor-transition explainer;
6. full money-path proof;
7. three-tab integration ladder;
8. adoption path;
9. nine long FAQ answers;
10. a multi-part closing offer.

This creates three launch-day problems:

- The signature proof arrives after two secondary arguments.
- The same claims—own Stripe, shadow-first, one afternoon, invoice evidence—repeat instead of
  advancing the story.
- The page offers too many local decisions before the single conversion decision.

## Considered Approaches

### 1. Copy-only compression

Keep every section and shorten the prose.

Trade-off: lowest implementation risk, but the core problem remains structural. The money path
still arrives late and visitors still pass through ten narrative moves.

### 2. Five-move launch page — selected

Keep the hero, incident, signature mechanism, integration/adoption proof, objections, and offer.
Remove the comparison, feature-outcome grid, and floor divider. Collapse the integration and
adoption sections into one proof section. Reduce the FAQ through progressive disclosure.

Trade-off: removes useful supporting detail from the homepage, but that detail remains available
in the manifesto, SDK docs, and source. This produces the best balance of comprehension, proof,
and trust for launch traffic.

### 3. Single-screen technical launch page

Hero, code sample, CTA, and nothing else.

Trade-off: exceptionally fast, but insufficient for money-adjacent infrastructure. It does not
answer the Stripe, custody, adoption-risk, and open-source objections needed before signup.

## Page Architecture

```text
Hero          promise + compact decision proof + one CTA
01 Incident   the cost already exists by invoice time
02 Mechanism  the full request-to-invoice money path
03 Adoption   two-call shadow integration + Shadow → Sandbox → Live
04 Questions  six launch-critical objections, collapsed by default
05 Offer      one plan version + one test customer + one shadow check
```

Every section advances exactly one level:

- Hook/promise → incident
- Incident → mechanism
- Mechanism → implementation proof
- Implementation proof → objection handling
- Objections → offer

## Component Decisions

### Hero

- Use the canonical headline: “Authorize customer spend before paid work runs.”
- Use the canonical loss-framed promise in one sentence.
- Keep the compact animated money path as the product visual.
- Keep one hero CTA. Remove the founder-call button from the first viewport.
- Compress trust into one metadata line: AGPL-3.0, shadow-first, and payments settling to the
  visitor's own Stripe.

### Incident

- Keep the DIY trace because it makes the pain concrete.
- Add the canonical line “Your Redis counter is not a budget.”
- Remove explanatory clauses that repeat what the trace already shows.

### Mechanism

- Move immediately after the incident.
- Keep the full money-path animation unchanged; it is the page's strongest proof.
- Compress the section copy to the allow/deny consequence.

### Integration And Adoption

- Replace the three-tab ladder and separate adoption section with one static section.
- Show only the honest first integration: `customers.signUp` once, then `access.check` before the
  paid action.
- Put the three-stage trust path directly beneath it:
  `Shadow → Sandbox → Your own Stripe`.
- Keep the SDK link as the deeper proof path.

### FAQ

- Keep six questions: Stripe, funds custody/provider scope, AI gateways, outage behavior,
  money-logic safety, and Cloudflare.
- Use native `details` disclosure so only the visitor's active objection expands.
- Preserve FAQ structured data.

### Offer

- Headline: “Start with one paid action.”
- Itemize the afternoon honestly: one plan version, one test customer, one shadow check.
- Keep the walk-away guarantee as one compact paragraph.
- Keep founder help as a quiet secondary link, not another primary button.

## Removals

Stop rendering and delete the landing-only components:

- `usp.tsx`
- `gains.tsx`
- `floor-divider.tsx`
- `adoption.tsx`
- `integration-ladder.tsx`

The unique supporting arguments are not lost:

- competitor contrast remains in `/manifesto` and the FAQ;
- pricing/versioning depth remains in product docs and the dashboard;
- adoption guidance remains in the new combined section.

## Accessibility And Performance

- Render one `main` landmark from the marketing layout only.
- Use static server imports for the page sections. Client code remains only where interaction or
  animation requires it.
- Native FAQ disclosures remain keyboard accessible without a hydration dependency.
- Preserve visible focus rings and minimum 44px targets for links/buttons in edited components.
- Preserve reduced-motion behavior in the money-path animation.

## Verification

- Run Biome on every changed landing file.
- Run the Next.js package typecheck.
- Run React Doctor after React changes.
- Inspect desktop and mobile, light and dark, with stepped scrolling if a permitted dev server is
  available.
- Confirm no nested `main`, no stale section numbers, no deleted imports, and no horizontal
  overflow.

