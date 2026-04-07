# Phase 3: Payment Provider Runtime Refactor

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: refactor payment provider runtime`  
Branch: `feat/provider-runtime-refactor`

## Mission

Replace the Stripe-centric provider runtime with a provider-neutral runtime that
uses the Phase 2 data model and can support Stripe, sandbox, the next provider,
and later crypto-backed settlement.

## Dependencies

- Phase 2 must be complete first.

## Why This Phase Exists

- the public provider interface still exposes Stripe types
- provider dispatch is switch-based but not normalized around capabilities or
  webhook handling
- resolver logic still depends on `customers.stripeCustomerId`
- runtime reads still pull provider choice from plan versions in several paths

## Read First

- [../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
- [../../internal/services/src/payment-provider/service.ts](../../internal/services/src/payment-provider/service.ts)
- [../../internal/services/src/payment-provider/resolver.ts](../../internal/services/src/payment-provider/resolver.ts)
- [../../internal/services/src/customers/service.ts](../../internal/services/src/customers/service.ts)
- [../../internal/services/src/billing/service.ts](../../internal/services/src/billing/service.ts)
- [../../internal/services/src/subscriptions/service.ts](../../internal/services/src/subscriptions/service.ts)
- [../../internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts](../../internal/services/src/use-cases/payment-provider/complete-stripe-sign-up.ts)
- [../../internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts](../../internal/services/src/use-cases/payment-provider/complete-stripe-setup.ts)
- [../../apps/api/src/routes/paymentProvider/stripeSignUpV1.ts](../../apps/api/src/routes/paymentProvider/stripeSignUpV1.ts)
- [../../apps/api/src/routes/paymentProvider/stripeSetupV1.ts](../../apps/api/src/routes/paymentProvider/stripeSetupV1.ts)
- [../../apps/api/src/index.ts](../../apps/api/src/index.ts)
- [../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/page.tsx](../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/page.tsx)
- [../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/_components/stripe-payment-config-form.tsx](../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/_components/stripe-payment-config-form.tsx)
- [../../apps/nextjs/src/components/onboarding/steps/payment-provider-step.tsx](../../apps/nextjs/src/components/onboarding/steps/payment-provider-step.tsx)
- [../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions/subscription-phase-form.tsx](../../apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions/subscription-phase-form.tsx)

## Guardrails

- Cut over to the Phase 2 model instead of keeping long-lived parallel storage.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Keep provider-specific code inside provider adapters, not in use cases or API
  routes.
- Add capability flags only where provider behavior truly differs.
- Keep decryption and provider config lookup centralized in the resolver.
- Keep UI behavior aligned with backend cutover in the same phase; do not leave
  frontend paths on Stripe-only assumptions after runtime migration.

## UI Patterns (Agent Notes)

When touching `apps/nextjs`, follow existing patterns:

- Server components fetch with `~/trpc/server` and hand data to client
  components.
- Client interactions use `useTRPC()` + React Query (`useQuery`,
  `useMutation`).
- Forms use `useZodForm` and `@unprice/db/validators` schemas with
  `@unprice/ui` primitives.
- Mutation completion should keep current UX conventions:
  `toastAction(...)` and `router.refresh()`/`revalidateAppPath(...)`.
- Preserve slug-scoped dashboard routing via
  `[workspaceSlug]/[projectSlug]` params.

## High-Risk Search Targets

Before changing code, search for these patterns and make a migration list:

- `stripeCustomerId`
- `phase.planVersion.paymentProvider`
- `completeStripe`
- `registerStripe`
- direct assumptions that provider customer id equals Stripe customer id

## Primary Touchpoints

- `internal/services/src/payment-provider/`
- `internal/services/src/customers/service.ts`
- `internal/services/src/billing/service.ts`
- `internal/services/src/subscriptions/`
- `internal/services/src/use-cases/payment-provider/`
- `internal/services/src/use-cases/index.ts`
- `apps/api/src/routes/paymentProvider/`
- `apps/api/src/index.ts`
- `internal/db/src/validators/customer.ts`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/`
- `apps/nextjs/src/components/onboarding/steps/payment-provider-step.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions/subscription-phase-form.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/`

## Execution Plan

### Slice 1: Redesign the public contract

Refactor
[../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
so the interface is provider-neutral.

Required changes:

- remove Stripe types from the exported contract
- delete `upsertProduct()` unless a real runtime caller still needs it
- add webhook verification and normalization hooks
- make capabilities explicit where providers differ

Good contract shape:

- customer/session setup
- payment method operations
- invoice sync and payment collection
- webhook verification and normalization
- provider capability metadata

### Slice 2: Normalize the dispatcher

Refactor
[../../internal/services/src/payment-provider/service.ts](../../internal/services/src/payment-provider/service.ts)
into a single normalized entry point.

Keep support for:

- Stripe
- sandbox

Add explicit provider capability reporting for cases like:

- billing portal support
- saved payment methods
- invoice item mutation
- async payment confirmation

### Slice 3: Cut the resolver over to Phase 2 storage

Update
[../../internal/services/src/payment-provider/resolver.ts](../../internal/services/src/payment-provider/resolver.ts)
to:

- read provider customer ids from `customer_provider_ids`
- load webhook secrets from `payment_provider_config`
- stop treating `customers.stripeCustomerId` as the primary source
- keep secret decryption centralized

This is the core runtime cutover. Once it lands, old Stripe-only reads should
be shrinking quickly.

### Slice 4: Move provider-owned metadata out of customer metadata

Refactor provider-specific customer metadata so it lives in
`customer_provider_ids.metadata` rather than the generic customer metadata
shape.

Implementation notes:

- define a normalized provider metadata type
- keep customer metadata limited to customer-owned facts
- update any read/write paths in customer setup and payment-method flows

### Slice 5: Move provider choice to subscription phases

Replace runtime reads of `planVersion.paymentProvider` with reads of
`subscription_phases.paymentProvider`.

Known hotspots include:

- billing invoice creation paths
- subscription flow reads
- any provider resolution inside subscription renewal and invoicing

### Slice 6: Replace Stripe-only completion flows

Replace the Stripe-only use cases and routes with provider-neutral versions.

Requirements:

- provider is explicit in route params and use-case input
- mapping writes go to `customer_provider_ids`
- session completion logic remains in use cases, not adapters
- route registration in
  [../../apps/api/src/index.ts](../../apps/api/src/index.ts) becomes provider
  neutral

### Slice 7: Cut over dashboard and onboarding UI flows

Replace Stripe-hardcoded UI assumptions with provider-neutral flows that match
the runtime refactor.

Requirements:

- payment settings page supports provider-neutral config UX instead of
  Stripe-only copy/component naming
- onboarding payment-provider step can configure/select provider without
  Stripe-specific wording or control coupling
- subscription phase UI no longer assumes provider comes only from
  `planVersion.paymentProvider`; it must read/write the phase-level provider
  contract
- plan and customer payment method screens preserve sandbox parity and still
  validate required payment-method rules correctly

### Slice 8: Remove legacy Stripe-only runtime fields

After every runtime caller uses the new model, remove:

- `customers.stripeCustomerId`
- Stripe-only metadata on customers
- fallback logic in the resolver that assumes Stripe by default

Do this at the end of the phase, not at the start.

### Slice 9: Add parity and extensibility tests

Cover:

- resolver behavior with mapping-table-backed customer ids
- provider completion flows
- phase-level provider reads
- Stripe capability behavior
- sandbox parity
- webhook secret loading
- dashboard payment settings flow parity after provider-neutral refactor
- onboarding provider setup parity across Stripe and sandbox

Packages likely affected:

- `@unprice/services`
- `api`
- `nextjs`
- `@unprice/db` only if validators or metadata schemas changed

## Validation

- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter @unprice/services test`
- `pnpm --filter api test`
- `pnpm --filter nextjs typecheck`
- `pnpm typecheck` if exported API shapes changed across packages

## Exit Criteria

- the public provider contract is provider-neutral
- provider customer ids are stored and resolved via `customer_provider_ids`
- runtime provider choice comes from subscription phases
- setup and sign-up flows are no longer hard-coded to Stripe route names or
  use-case names
- dashboard and onboarding payment-provider UX is provider-neutral and aligned
  with runtime contracts
- legacy Stripe-only runtime fields are removed or clearly dead

## Out Of Scope

- ledger implementation
- settlement webhook processing
- agent usage billing
