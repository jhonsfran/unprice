# Launch-Day Landing Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the landing page to a five-move launch narrative with one conversion action and
the money-path proof immediately after the incident.

**Architecture:** Keep the existing ledger design system and signature `MoneyPath`. Compose the
page from statically imported server sections, replace the interactive three-tab integration
ladder with one static integration/adoption proof, progressively disclose FAQ answers, and remove
landing-only components that no longer earn their place.

**Tech Stack:** Next.js App Router, React Server Components, Tailwind CSS, Unprice UI tokens,
TypeScript.

---

### Task 1: Simplify page composition and hero

**Files:**

- Modify: `apps/nextjs/src/app/(root)/(landing)/page.tsx`
- Modify: `apps/nextjs/src/components/landing/hero.tsx`

- [ ] **Step 1: Replace dynamic section imports with static imports**

Use this page order and a non-landmark wrapper because the marketing layout already owns `main`:

```tsx
import Cta from "~/components/landing/cta"
import FaqSection from "~/components/landing/faq"
import Hero from "~/components/landing/hero"
import LaunchPath from "~/components/landing/launch-path"
import { MoneyPathSection } from "~/components/landing/money-path-section"
import { ProblemSection } from "~/components/landing/problem"

export default function Home() {
  return (
    <div className="flex flex-col overflow-hidden">
      <Hero />
      <ProblemSection />
      <MoneyPathSection />
      <LaunchPath />
      <FaqSection />
      <Cta />
    </div>
  )
}
```

- [ ] **Step 2: Compress the hero to one promise and one action**

Set the headline and promise to:

```tsx
<h1 id="hero-title" className="font-primary text-background-textContrast text-display-1">
  <Balancer>Authorize customer spend before paid work runs.</Balancer>
</h1>
<p className="mt-6 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
  Sell credits and usage-based plans without eating over-budget customer work.
</p>
```

Keep only the `Start with one paid action` acquisition link. Replace the large trust block with:

```tsx
<p className="mt-4 font-mono text-[11px] text-background-text leading-5">
  AGPL-3.0 open source · shadow-first · payments settle to your own Stripe
</p>
```

- [ ] **Step 3: Run focused formatting and type validation**

Run:

```bash
./node_modules/.bin/biome check apps/nextjs/src/app/\(root\)/\(landing\)/page.tsx \
  apps/nextjs/src/components/landing/hero.tsx
```

Expected: no diagnostics.

### Task 2: Tighten the incident and mechanism

**Files:**

- Modify: `apps/nextjs/src/components/landing/problem.tsx`
- Modify: `apps/nextjs/src/components/landing/money-path-section.tsx`

- [ ] **Step 1: Renumber and shorten the incident**

Keep station `01`, use the headline “By invoice time, the paid work already ran.”, and replace the
body with:

```tsx
<p className="mt-5 max-w-xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
  Your Redis counter is not a budget. It notices usage after the expensive action runs, then
  leaves engineering to reconstruct the invoice from logs.
</p>
```

- [ ] **Step 2: Move the mechanism to station 02 and compress its copy**

Use:

```tsx
<StationHeader index="02" label="The money path" fact="allow settles · deny costs nothing" />
<h2 id="money-path-title" className="mt-6 max-w-2xl font-primary text-background-textContrast text-display-3">
  The decision becomes the invoice.
</h2>
<p className="mt-5 max-w-2xl text-background-text text-base leading-7 sm:text-lg sm:leading-8">
  Allowed work reserves credits and writes invoice evidence. Denied work creates no charge, and
  returns the reason to your app.
</p>
```

- [ ] **Step 3: Run focused formatting**

Run:

```bash
./node_modules/.bin/biome check apps/nextjs/src/components/landing/problem.tsx \
  apps/nextjs/src/components/landing/money-path-section.tsx
```

Expected: no diagnostics.

### Task 3: Build one integration and adoption proof

**Files:**

- Create: `apps/nextjs/src/components/landing/launch-path.tsx`
- Delete: `apps/nextjs/src/components/landing/code-example.tsx`
- Delete: `apps/nextjs/src/components/landing/integration-ladder.tsx`
- Delete: `apps/nextjs/src/components/landing/adoption.tsx`

- [ ] **Step 1: Create the static first-integration proof**

Use one `GATE_SNIPPET` containing `customers.signUp` followed by `access.check`. Render it in the
existing `CodeEditor`, with the existing `CopyToClipboard` control and SDK link.

- [ ] **Step 2: Add the ordered adoption path beneath the code**

Use exactly these stages:

```ts
const stages = [
  {
    title: "Shadow",
    body: "Run access.check beside the logic you already trust. It is read-only and blocks nothing.",
  },
  {
    title: "Sandbox",
    body: "Prove the customer, plan, budget, credits, and invoice evidence before a real dollar moves.",
  },
  {
    title: "Your own Stripe",
    body: "Enforce only when the decisions match. Payments still settle in your account.",
  },
] as const
```

Render them as one semantic ordered list with station `03`, not as cards.

- [ ] **Step 3: Remove the superseded components**

Delete the old three-tab ladder, code wrapper, and separate adoption section after confirming no
other import remains:

```bash
rg -n "IntegrationLadder|CodeExample|AdoptionSection" apps/nextjs/src
```

Expected: no matches after deletion and page replacement.

### Task 4: Reduce objections and the closing offer

**Files:**

- Modify: `apps/nextjs/src/components/landing/faq.tsx`
- Modify: `apps/nextjs/src/components/landing/cta.tsx`

- [ ] **Step 1: Reduce FAQ data to six launch-critical objections**

Keep:

```ts
[
  "Why not just Stripe?",
  "Does Unprice touch the money?",
  "Why not an AI gateway?",
  "What happens if Unprice is down?",
  "Is it safe enough for money logic?",
  "Do I need Cloudflare?",
]
```

Combine Stripe-only/provider scope into the funds-custody answer. Keep all claims inside
`docs/brand/PRODUCT.md`.

- [ ] **Step 2: Render FAQ answers with native disclosure**

Use a single-column `<div>` of `<details>` rows. Each `<summary>` is at least `min-h-11`, has a
visible focus ring, and exposes one answer at a time without client state. Keep FAQ JSON-LD.

- [ ] **Step 3: Compress the closing offer**

Use station `05`, headline “Start with one paid action.”, one paragraph describing a plan version,
test customer, and shadow check, the existing acquisition link, one compact walk-away guarantee,
and a quiet founder email link.

- [ ] **Step 4: Run focused formatting**

Run:

```bash
./node_modules/.bin/biome check apps/nextjs/src/components/landing/faq.tsx \
  apps/nextjs/src/components/landing/cta.tsx
```

Expected: no diagnostics.

### Task 5: Remove obsolete launch sections and verify

**Files:**

- Delete: `apps/nextjs/src/components/landing/usp.tsx`
- Delete: `apps/nextjs/src/components/landing/gains.tsx`
- Delete: `apps/nextjs/src/components/landing/floor-divider.tsx`

- [ ] **Step 1: Delete landing-only files no longer in the launch narrative**

Confirm each has no caller, then delete it.

- [ ] **Step 2: Scan for stale numbers, imports, landmarks, and claims**

Run:

```bash
rg -n "index=\"0[6-9]\"|UspSection|GainsSection|FloorDivider|IntegrationLadder|AdoptionSection" \
  apps/nextjs/src/app/\(root\)/\(landing\) apps/nextjs/src/components/landing
rg -n "<main" apps/nextjs/src/app/\(root\)/\(landing\)/page.tsx
```

Expected: no matches.

- [ ] **Step 3: Run package verification**

Run:

```bash
nvm use
corepack pnpm --filter @unprice/nextjs typecheck
pnpm run doctor
./node_modules/.bin/biome check apps/nextjs/src/app/\(root\)/\(landing\)/page.tsx \
  apps/nextjs/src/components/landing/hero.tsx \
  apps/nextjs/src/components/landing/problem.tsx \
  apps/nextjs/src/components/landing/money-path-section.tsx \
  apps/nextjs/src/components/landing/launch-path.tsx \
  apps/nextjs/src/components/landing/faq.tsx \
  apps/nextjs/src/components/landing/cta.tsx
git diff --check
```

Expected: all commands pass.

- [ ] **Step 4: Inspect the rendered page when a permitted server is available**

Check desktop 1440px and mobile 390px in light and dark themes. Scroll section-by-section instead
of taking one stitched full-page screenshot. Confirm the money-path animation, FAQ disclosure,
focus states, no horizontal overflow, and one visible conversion action per section.

