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

## Guardrails

- Cut over to the Phase 2 model instead of keeping long-lived parallel storage.
- Keep provider-specific code inside provider adapters, not in use cases or API
  routes.
- Add capability flags only where provider behavior truly differs.
- Keep decryption and provider config lookup centralized in the resolver.

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

### Slice 7: Remove legacy Stripe-only runtime fields

After every runtime caller uses the new model, remove:

- `customers.stripeCustomerId`
- Stripe-only metadata on customers
- fallback logic in the resolver that assumes Stripe by default

Do this at the end of the phase, not at the start.

### Slice 8: Add parity and extensibility tests

Cover:

- resolver behavior with mapping-table-backed customer ids
- provider completion flows
- phase-level provider reads
- Stripe capability behavior
- sandbox parity
- webhook secret loading

Packages likely affected:

- `@unprice/services`
- `api`
- `@unprice/db` only if validators or metadata schemas changed

## Validation

- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter @unprice/services test`
- `pnpm --filter api test`
- `pnpm typecheck` if exported API shapes changed across packages

## Exit Criteria

- the public provider contract is provider-neutral
- provider customer ids are stored and resolved via `customer_provider_ids`
- runtime provider choice comes from subscription phases
- setup and sign-up flows are no longer hard-coded to Stripe route names or
  use-case names
- legacy Stripe-only runtime fields are removed or clearly dead

## Out Of Scope

- ledger implementation
- settlement webhook processing
- agent usage billing
