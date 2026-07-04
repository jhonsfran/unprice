# Workspace Upgrade Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable customer-facing workspace plan-change flow that can start from Billing & Usage or from blocked feature contexts.

**Architecture:** Keep billing identity server-owned: the browser sends `workspaceSlug` plus the selected target plan, while backend use cases resolve workspace customer, billing project, subscription, active phase, provider, and payment readiness. Refactor existing internal plan-version pricing UI into shared dashboard billing components; rename public site pricing components so they are clearly marketing-only. Use one canonical upgrade intent shape for both the full page and contextual upgrade entrypoints.

**Tech Stack:** Next.js App Router, React, TypeScript, tRPC, TanStack Query, Zod, Drizzle, `@unprice/services` use cases, shadcn/ui primitives, Tailwind, pnpm.

---

## Current Truths

- Workspace billing is self-reflective: `workspace.unPriceCustomerId` must resolve to the customer owning project before loading current access, wallet, usage, plan choices, or changing plans.
- `internal/trpc/src/router/lambda/workspaces/getBillingOverview.ts` already resolves `workspace -> customer -> billingProjectId` and returns current access, wallet, usage, and active phase payment provider.
- Public site pricing components under `apps/nextjs/src/app/(sites)/sites/_components` include marketing concerns such as cookies, `window.Unprice`, `mailto`, and external signup links. Do not use those for dashboard upgrade UX.
- Internal pricing components under `apps/nextjs/src/components/forms/pricing-card.tsx` and `pricing-item.tsx` already render plan-version prices and features, but their names and actions are form/admin oriented.
- Admin subscription change-plan UI exists under `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions`, but `internal/trpc/src/router/lambda/subscriptions/changePhasePlan.ts` currently returns fake success instead of changing subscription phases, and it is project-scoped admin UX.
- Blocked feature surfaces currently render `apps/nextjs/src/components/layout/error.tsx`, whose `Update plan` CTA is not wired.

## Product Decisions

- Billing page header actions:
  - Primary: `Change plan`
  - Secondary: `Billing Portal`
- Canonical plan comparison lives at `/:workspaceSlug/settings/billing/change-plan`.
- Blocked feature moments open a contextual upgrade entrypoint instead of only sending users away.
- The contextual entrypoint uses the same upgrade intent contract and plan-card primitives as the full page.
- Current plan remains visible but disabled with a `Current plan` badge.
- Other active/published plans are selectable when payment/provider preconditions are satisfied.
- Marketing pricing cards are renamed as marketing components and stay out of dashboard billing.

## Upgrade Intent Contract

Create one client-side contract used by Billing & Usage, blocked feature pages, tooltips, and future usage-limit failures.

```ts
export const workspaceUpgradeIntentSchema = z.object({
  source: z.enum(["billing", "feature_block", "usage_limit"]),
  workspaceSlug: z.string().min(1),
  returnTo: z.string().min(1),
  blockedFeatureSlug: z.string().min(1).optional(),
  targetPlanVersionId: z.string().min(1).optional(),
})

export type WorkspaceUpgradeIntent = z.infer<typeof workspaceUpgradeIntentSchema>
```

The full page reads this from query params. Contextual upgrade CTAs can also hold it in component state before navigating.

## File Map

- Rename: `apps/nextjs/src/app/(sites)/sites/_components/pricing-card.tsx` -> `apps/nextjs/src/app/(sites)/sites/_components/marketing-pricing-card.tsx`
- Rename: `apps/nextjs/src/app/(sites)/sites/_components/pricing-table.tsx` -> `apps/nextjs/src/app/(sites)/sites/_components/marketing-pricing-table.tsx`
- Modify: imports in `apps/nextjs/src/app/(sites)/sites/**`
- Create: `apps/nextjs/src/components/billing/plan-version-feature-list.tsx`
- Create: `apps/nextjs/src/components/billing/plan-version-pricing-card.tsx`
- Modify: `apps/nextjs/src/components/forms/pricing-item.tsx`
- Modify: `apps/nextjs/src/components/forms/pricing-card.tsx`
- Modify: `apps/nextjs/src/components/forms/items-fields.tsx`
- Create: `apps/nextjs/src/components/billing/workspace-upgrade-intent.ts`
- Create: `apps/nextjs/src/components/billing/workspace-upgrade-entrypoint.tsx`
- Modify: `apps/nextjs/src/components/layout/error.tsx`
- Modify: plan-gated pages that render `UpgradePlanError`
- Create: `internal/services/src/use-cases/workspace/get-upgrade-options.ts`
- Create: `internal/services/src/use-cases/workspace/change-plan.ts`
- Modify: `internal/services/src/use-cases/workspace/index.ts`
- Create: `internal/trpc/src/router/lambda/workspaces/getUpgradeOptions.ts`
- Create: `internal/trpc/src/router/lambda/workspaces/changePlan.ts`
- Modify: `internal/trpc/src/router/lambda/workspaces/index.ts`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/page.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/loading.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/_components/workspace-change-plan-client.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/page.tsx`
- Test: service use-case unit/integration tests under `internal/services/src/use-cases/workspace`
- Test: tRPC typecheck and Next typecheck

## Task 1: Baseline And Rename Marketing Pricing Components

**Files:**

- Rename: `apps/nextjs/src/app/(sites)/sites/_components/pricing-card.tsx`
- Rename: `apps/nextjs/src/app/(sites)/sites/_components/pricing-table.tsx`
- Modify: imports that reference those files

- [ ] **Step 1: Confirm the current worktree before moving files**

Run:

```bash
git status --short
```

Expected: note unrelated changes and do not revert them.

- [ ] **Step 2: Rename the public site pricing components**

Run:

```bash
mv 'apps/nextjs/src/app/(sites)/sites/_components/pricing-card.tsx' 'apps/nextjs/src/app/(sites)/sites/_components/marketing-pricing-card.tsx'
mv 'apps/nextjs/src/app/(sites)/sites/_components/pricing-table.tsx' 'apps/nextjs/src/app/(sites)/sites/_components/marketing-pricing-table.tsx'
```

- [ ] **Step 3: Rename exported symbols**

In `marketing-pricing-card.tsx`, rename:

```ts
PricingPlan -> MarketingPricingPlan
PricingCardProps -> MarketingPricingCardProps
PricingCard -> MarketingPricingCard
```

In `marketing-pricing-table.tsx`, rename:

```ts
PricingTableProps -> MarketingPricingTableProps
PricingTable -> MarketingPricingTable
```

- [ ] **Step 4: Update imports**

Run:

```bash
rg -n "pricing-card|pricing-table|PricingCard|PricingTable|PricingPlan" 'apps/nextjs/src/app/(sites)/sites'
```

Update the site imports to use:

```ts
import {
  MarketingPricingCard,
  type MarketingPricingPlan,
} from "./marketing-pricing-card"
import { MarketingPricingTable } from "./marketing-pricing-table"
```

- [ ] **Step 5: Verify the rename**

Run:

```bash
corepack pnpm --filter nextjs typecheck
```

Expected: pass.

## Task 2: Extract Internal Plan-Version Pricing Primitives

**Files:**

- Create: `apps/nextjs/src/components/billing/plan-version-feature-list.tsx`
- Create: `apps/nextjs/src/components/billing/plan-version-pricing-card.tsx`
- Modify: `apps/nextjs/src/components/forms/pricing-item.tsx`
- Modify: `apps/nextjs/src/components/forms/pricing-card.tsx`
- Modify: `apps/nextjs/src/components/forms/items-fields.tsx`

- [ ] **Step 1: Extract the feature list item**

Move the reusable rendering logic from `components/forms/pricing-item.tsx` into `components/billing/plan-version-feature-list.tsx`.

Create this public API:

```ts
export function PlanVersionFeatureListItem(props: {
  feature: PlanVersionExtended["planFeatures"][number]
  withCalculator?: boolean
  withQuantity?: boolean
  onQuantityChange?: (quantity: number) => void
  hideCheckIcon?: boolean
  hideTitle?: boolean
  className?: string
})
```

Keep the pricing math exactly where it is today: `calculatePricePerFeature`, `calculateFreeUnits`, `nFormatter`, and `currencySymbol`.

- [ ] **Step 2: Keep a compatibility wrapper**

Replace `components/forms/pricing-item.tsx` with a thin wrapper:

```tsx
import { PlanVersionFeatureListItem } from "~/components/billing/plan-version-feature-list"

export function PricingItem(props: {
  feature: Parameters<typeof PlanVersionFeatureListItem>[0]["feature"]
  withCalculator?: boolean
  withQuantity?: boolean
  onQuantityChange?: (quantity: number) => void
  noCheckIcon?: boolean
  noTitle?: boolean
  className?: string
}) {
  return (
    <PlanVersionFeatureListItem
      feature={props.feature}
      withCalculator={props.withCalculator}
      withQuantity={props.withQuantity}
      onQuantityChange={props.onQuantityChange}
      hideCheckIcon={props.noCheckIcon}
      hideTitle={props.noTitle}
      className={props.className}
    />
  )
}
```

- [ ] **Step 3: Extract the internal pricing card**

Create `components/billing/plan-version-pricing-card.tsx` with this API:

```ts
export type PlanVersionPricingCardAction =
  | { kind: "current"; label: "Current plan" }
  | { kind: "select"; label: string; onSelect: () => void }
  | { kind: "disabled"; label: string; reason: string }
  | { kind: "publish"; onPublish?: () => void }

export function PlanVersionPricingCard(props: {
  planVersion: RouterOutputs["planVersions"]["getById"]["planVersion"]
  action: PlanVersionPricingCardAction
  highlight?: boolean
  className?: string
})
```

Use the existing internal card calculations from `components/forms/pricing-card.tsx`:

```ts
calculateFlatPricePlan({ planVersion, prorate: 1 })
getTrialUnitLabel({
  billingInterval: planVersion.billingConfig.billingInterval,
  units: planVersion.trialUnits ?? 0,
})
```

Render features with `PlanVersionFeatureListItem`.

- [ ] **Step 4: Keep `components/forms/pricing-card.tsx` as an admin compatibility wrapper**

Make it call `PlanVersionPricingCard` with:

```ts
action={
  showPublish && planVersion.status !== "published"
    ? { kind: "publish", onPublish }
    : { kind: "select", label: "Get Started", onSelect: () => undefined }
}
```

This keeps existing admin/preview usage stable while moving reusable UI to `components/billing`.

- [ ] **Step 5: Update feature configuration to use the new item directly**

In `components/forms/items-fields.tsx`, replace direct `PricingItem` imports with:

```ts
import { PlanVersionFeatureListItem } from "~/components/billing/plan-version-feature-list"
```

Replace usage:

```tsx
<PricingItem feature={feature} withCalculator noCheckIcon withQuantity={false} />
```

with:

```tsx
<PlanVersionFeatureListItem
  feature={feature}
  withCalculator
  hideCheckIcon
  withQuantity={false}
/>
```

- [ ] **Step 6: Verify**

Run:

```bash
corepack pnpm --filter nextjs typecheck
corepack pnpm biome check apps/nextjs/src/components/billing apps/nextjs/src/components/forms/pricing-card.tsx apps/nextjs/src/components/forms/pricing-item.tsx apps/nextjs/src/components/forms/items-fields.tsx
```

Expected: pass.

## Task 3: Add Workspace Upgrade Options Use Case

**Files:**

- Create: `internal/services/src/use-cases/workspace/get-upgrade-options.ts`
- Modify: `internal/services/src/use-cases/workspace/index.ts`
- Create: `internal/trpc/src/router/lambda/workspaces/getUpgradeOptions.ts`
- Modify: `internal/trpc/src/router/lambda/workspaces/index.ts`

- [ ] **Step 1: Define Zod contracts in the use case**

Create:

```ts
export const workspaceUpgradeOptionSchema = z.object({
  planVersion: getPlanVersionApiResponseSchema,
  isCurrent: z.boolean(),
  isAvailable: z.boolean(),
  unavailableReason: z.string().nullable(),
  paymentProvider: paymentProviderSchema,
  paymentMethodRequired: z.boolean(),
  hasPaymentMethod: z.boolean(),
})

export const getWorkspaceUpgradeOptionsOutputSchema = z.object({
  customerId: z.string(),
  billingProjectId: z.string(),
  currentPlanVersionId: z.string().nullable(),
  currentSubscriptionId: z.string().nullable(),
  currentPhaseId: z.string().nullable(),
  currentCycleEndAt: z.number().nullable(),
  options: workspaceUpgradeOptionSchema.array(),
})
```

- [ ] **Step 2: Implement the resolver logic**

In the use case:

1. Resolve `workspace.unPriceCustomerId`.
2. Load the customer across projects.
3. Use `customer.projectId` as `billingProjectId`.
4. Load current access using `getCustomerCurrentAccess`.
5. Load active/published plan versions from `services.plans.listPlanVersions`.
6. Filter to the current customer currency.
7. Annotate current plan as unavailable with reason `This is your current plan.`
8. Check provider config with `checkPaymentProviderAvailability`.
9. Check default payment method with `services.customers.resolvePaymentMethod`.

Return all plans with availability annotations rather than hiding unavailable plans.

- [ ] **Step 3: Add tRPC query**

Create `workspaces.getUpgradeOptions` as a `protectedWorkspaceProcedure` with input:

```ts
z.object({
  workspaceSlug: z.string().optional(),
})
```

Call the use case with `opts.ctx.workspace`, `opts.ctx.services`, `opts.ctx.db`, and `opts.ctx.logger`.

- [ ] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter @unprice/services typecheck
corepack pnpm --filter @unprice/trpc typecheck
```

Expected: pass.

## Task 4: Add Workspace Change Plan Use Case

**Files:**

- Create: `internal/services/src/use-cases/workspace/change-plan.ts`
- Modify: `internal/services/src/use-cases/workspace/index.ts`
- Create: `internal/services/src/use-cases/workspace/change-plan.test.ts`
- Create: `internal/trpc/src/router/lambda/workspaces/changePlan.ts`
- Modify: `internal/trpc/src/router/lambda/workspaces/index.ts`

- [ ] **Step 1: Add input and output contracts**

```ts
export const workspaceChangePlanInputSchema = z.object({
  workspaceSlug: z.string().optional(),
  targetPlanVersionId: z.string().min(1),
  whenToChange: z.enum(["immediately", "end_of_cycle"]),
  config: subscriptionItemsConfigSchema.optional(),
})

export const workspaceChangePlanOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("changed"),
    subscriptionId: z.string(),
    phaseId: z.string(),
  }),
  z.object({
    status: z.literal("scheduled"),
    subscriptionId: z.string(),
    phaseId: z.string(),
    effectiveAt: z.number(),
  }),
  z.object({
    status: z.literal("requires_payment_method"),
    paymentProvider: paymentProviderSchema,
    message: z.string(),
  }),
])
```

- [ ] **Step 2: Implement the use case**

The use case must:

1. Resolve workspace billing customer.
2. Resolve billing project from the customer.
3. Load current access.
4. Find active subscription and active phase.
5. Reject the same plan version.
6. Load target plan version from the billing project.
7. Reject inactive, unpublished, archived, wrong-project, or wrong-currency targets.
8. Check provider availability for the target plan version payment provider.
9. If `paymentMethodRequired` is true and no default method exists, return `requires_payment_method`.
10. For `immediately`, close current phase at `now` and create target phase at `now + 1`.
11. For `end_of_cycle`, create target phase at `currentCycleEndAt` and leave current phase in place until then.
12. Generate billing periods after phase creation.

Use the existing service primitives inside a database transaction. The implementation should build
the phase objects before calling the service methods:

```ts
const result = await deps.db.transaction(async (tx) => {
  const targetStartAt =
    input.whenToChange === "immediately" ? now + 1 : currentCycleEndAt

  if (input.whenToChange === "immediately") {
    const closeCurrentPhaseInput = {
      id: activePhase.id,
      projectId: billingProjectId,
      subscriptionId,
      startAt: activePhase.startAt,
      endAt: now,
      items: [],
    } as SubscriptionPhase

    const closeResult = await services.subscriptions.updatePhase({
      input: closeCurrentPhaseInput,
      subscriptionId,
      projectId: billingProjectId,
      db: tx,
      now,
    })

    if (closeResult.err) return closeResult
  }

  const createResult = await services.subscriptions.createPhase({
    input: {
      subscriptionId,
      planVersionId: input.targetPlanVersionId,
      startAt: targetStartAt,
      config: input.config,
      paymentProvider: targetPlanVersion.paymentProvider,
      paymentMethodId,
    },
    projectId: billingProjectId,
    db: tx,
    now: targetStartAt,
  })

  if (createResult.err) return createResult

  const periodsResult = await services.billing.generateBillingPeriods({
    projectId: billingProjectId,
    subscriptionId,
    now,
  })

  if (periodsResult.err) return periodsResult

  return Ok(createResult.val)
})
```

- [ ] **Step 3: Add tRPC mutation**

Create `workspaces.changePlan` as `protectedWorkspaceProcedure`.

Require:

```ts
opts.ctx.verifyRole(["OWNER", "ADMIN"])
```

Map expected provider/payment/validation failures to `PRECONDITION_FAILED` or `BAD_REQUEST`, not `INTERNAL_SERVER_ERROR`.

- [ ] **Step 4: Add tests**

Add tests for:

- same plan rejected
- non-owner/non-admin rejected at tRPC layer
- missing payment method returns `requires_payment_method`
- provider disabled returns a human-readable precondition failure
- immediate change closes old phase and creates new phase at `now + 1`
- end-of-cycle change creates future phase at `currentCycleEndAt`

- [ ] **Step 5: Verify**

Run:

```bash
corepack pnpm --filter @unprice/services test -- change-plan
corepack pnpm --filter @unprice/services typecheck
corepack pnpm --filter @unprice/trpc typecheck
```

Expected: pass.

## Task 5: Add Upgrade Intent And Contextual Entry Point

**Files:**

- Create: `apps/nextjs/src/components/billing/workspace-upgrade-intent.ts`
- Create: `apps/nextjs/src/components/billing/workspace-upgrade-entrypoint.tsx`
- Modify: `apps/nextjs/src/components/layout/error.tsx`
- Modify: feature-gated pages that render `UpgradePlanError`

- [ ] **Step 1: Add intent helpers**

Create the schema from this plan's `Upgrade Intent Contract`.

Add helpers:

```ts
export function encodeWorkspaceUpgradeIntent(intent: WorkspaceUpgradeIntent): URLSearchParams
export function parseWorkspaceUpgradeIntent(searchParams: URLSearchParams): WorkspaceUpgradeIntent | null
```

- [ ] **Step 2: Add contextual entrypoint component**

Create `WorkspaceUpgradeEntrypoint`:

```ts
export function WorkspaceUpgradeEntrypoint(props: {
  intent: WorkspaceUpgradeIntent
  children?: React.ReactNode
})
```

Behavior:

- Default trigger text is `Change plan`.
- On click, navigate to `/${workspaceSlug}/settings/billing/change-plan` with encoded intent params.
- Keep this as navigation for v1, not a modal, so the first implementation is consistent and simple.

- [ ] **Step 3: Wire blocked feature errors**

Update `UpgradePlanError` props:

```ts
export default function UpgradePlanError(props: {
  workspaceSlug: string
  blockedFeatureSlug?: string
  returnTo?: string
})
```

The `Update plan` button should use `WorkspaceUpgradeEntrypoint` with:

```ts
source: "feature_block"
workspaceSlug: props.workspaceSlug
blockedFeatureSlug: props.blockedFeatureSlug
returnTo: props.returnTo ?? window.location.pathname
```

- [ ] **Step 4: Update gated page calls**

Pass `workspaceSlug`, `blockedFeatureSlug`, and `returnTo` from pages such as:

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/domains/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/(overview)/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/pages/(overview)/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/(overview)/page.tsx`

- [ ] **Step 5: Verify**

Run:

```bash
corepack pnpm --filter nextjs typecheck
```

Expected: pass.

## Task 6: Add Full Change Plan Page

**Files:**

- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/page.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/loading.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan/_components/workspace-change-plan-client.tsx`

- [ ] **Step 1: Add server page**

The page should:

1. Parse `workspaceSlug`.
2. Fetch `api.workspaces.getUpgradeOptions({ workspaceSlug })`.
3. Render `DashboardShell` with title `Change plan`.
4. Include a secondary action back to `/${workspaceSlug}/settings/billing`.
5. Hydrate the client component with options.

- [ ] **Step 2: Add client selection component**

The client component should:

- Render a responsive grid of `PlanVersionPricingCard`.
- Disable the current plan.
- Disable unavailable plans with provider/payment reasons.
- Store selected plan id in local state.
- Show review section after selection.
- Use a segmented control for `Immediately` and `End of current cycle`.
- Call `workspaces.changePlan`.
- On `changed` or `scheduled`, toast success and navigate back to billing.
- On `requires_payment_method`, show inline payment setup using existing `PaymentMethodButton`.

- [ ] **Step 3: Preserve context**

If query params include `source=feature_block`, show compact context copy above the cards:

```tsx
<Alert variant="info">
  <AlertTitle>Upgrade for this feature</AlertTitle>
  <AlertDescription>
    Choose a plan that includes the feature you were trying to use.
  </AlertDescription>
</Alert>
```

Use provider-agnostic language.

- [ ] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter nextjs typecheck
corepack pnpm biome check 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/change-plan' apps/nextjs/src/components/billing
```

Expected: pass.

## Task 7: Update Billing Header Actions

**Files:**

- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing/page.tsx`

- [ ] **Step 1: Replace single action with primary and secondary actions**

If `HeaderTab` only supports one action slot, create a local action group in `page.tsx`:

```tsx
<div className="flex items-center gap-2">
  <Button asChild>
    <SuperLink href={`/${workspaceSlug}/settings/billing/change-plan`}>
      Change plan
    </SuperLink>
  </Button>
  <PaymentMethodButton
    customerId={overview.customerId}
    successUrl={`/${workspaceSlug}/settings/billing`}
    cancelUrl={`/${workspaceSlug}/settings/billing`}
    paymentProvider={overview.paymentProvider}
    workspaceSlug={workspaceSlug}
    hasPaymentMethods
  />
</div>
```

Keep `Change plan` primary and `Billing Portal` secondary.

- [ ] **Step 2: Verify**

Run:

```bash
corepack pnpm --filter nextjs typecheck
```

Expected: pass.

## Task 8: Final Validation

**Files:** all changed files

- [ ] Run focused checks:

```bash
corepack pnpm --filter @unprice/services typecheck
corepack pnpm --filter @unprice/trpc typecheck
corepack pnpm --filter nextjs typecheck
```

- [ ] Run targeted Biome:

```bash
corepack pnpm biome check internal/services/src/use-cases/workspace internal/trpc/src/router/lambda/workspaces apps/nextjs/src/components/billing 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/billing'
```

- [ ] Manual QA:

1. Visit `/:workspaceSlug/settings/billing`.
2. Confirm `Change plan` is primary and `Billing Portal` is secondary.
3. Visit `/:workspaceSlug/settings/billing/change-plan`.
4. Confirm current plan is visible and disabled.
5. Confirm active plans show selectable actions.
6. Trigger a blocked feature page and confirm the upgrade CTA preserves context.
7. Select a plan that requires a payment method and confirm inline setup appears.
8. Select an available plan and confirm success returns to Billing & Usage.

## Self-Review Checklist

- No dashboard upgrade UI imports marketing pricing components.
- Marketing pricing components are explicitly named `MarketingPricing*`.
- Workspace billing identity is never accepted from the browser as authoritative.
- Upgrade CTAs share one intent contract.
- The plan-change mutation is one backend operation, not browser-side cancel-plus-create orchestration.
- Provider errors are provider-agnostic and human-readable.
- Current plan is visible but disabled.
- Blocked feature upgrade moments preserve `returnTo`.
