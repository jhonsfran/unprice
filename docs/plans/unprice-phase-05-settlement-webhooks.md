# Phase 5: Settlement And Webhook Pipeline

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add settlement and webhook pipeline`  
Branch: `feat/settlement-webhooks`

## Mission

Add normalized provider webhook handling and settlement reconciliation on top of
ledger-backed billing. After this phase, provider payment outcomes can update
invoice state, subscription state, and ledger settlement state through one
normalized webhook pipeline.

## Dependencies

- Phase 2 for webhook storage
- Phase 3 for provider-neutral runtime hooks
- Phase 4 for ledger-backed billing

## Why This Phase Exists

- provider payment outcomes currently are not normalized around a durable
  webhook pipeline
- ledger entries cannot be safely settled from provider outcomes until webhooks
  are durable and idempotent
- subscription state transitions need a single place to consume payment success
  and failure events

## Implementation Guardrails

Read [ADR-0002: Wallet And Payment Provider Activation Guardrails](../adr/ADR-0002-wallet-payment-provider-activation-guardrails.md)
before changing provider checkout, webhook, or settlement behavior. Direct free
and sandbox provisioning must not depend on payment webhooks; webhooks settle
provider-owned outcomes after durable normalization.

## Read First

- [../../apps/api/src/index.ts](../../apps/api/src/index.ts)
- [../../internal/services/src/payment-provider/interface.ts](../../internal/services/src/payment-provider/interface.ts)
- [../../internal/services/src/payment-provider/service.ts](../../internal/services/src/payment-provider/service.ts)
- [../../internal/services/src/billing/service.ts](../../internal/services/src/billing/service.ts)
- [../../internal/services/src/subscriptions/machine.ts](../../internal/services/src/subscriptions/machine.ts)
- [../../internal/services/src/subscriptions/types.ts](../../internal/services/src/subscriptions/types.ts)
- [../../apps/api/src/routes/paymentProvider/stripeSetupV1.ts](../../apps/api/src/routes/paymentProvider/stripeSetupV1.ts)
- [../../apps/api/src/routes/paymentProvider/stripeSignUpV1.ts](../../apps/api/src/routes/paymentProvider/stripeSignUpV1.ts)
- [./unprice-phase-02-provider-data-foundation.md](./unprice-phase-02-provider-data-foundation.md)
- [./unprice-phase-03-provider-runtime-refactor.md](./unprice-phase-03-provider-runtime-refactor.md)
- [./unprice-phase-04-ledger-foundation.md](./unprice-phase-04-ledger-foundation.md)

## Guardrails

- Webhook handling must be idempotent.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Routes should stay thin: parse request, verify signature, pass normalized work
  to a use case.
- The provider adapter normalizes provider-specific payloads; the use case owns
  business side effects.
- Ledger settlement updates must be driven by durable provider outcomes, not by
  optimistic assumptions.

## Primary Touchpoints

- `apps/api/src/routes/` new generic provider webhook route
- `apps/api/src/index.ts`
- `internal/services/src/payment-provider/`
- `internal/services/src/use-cases/` new webhook processing use case
- `internal/services/src/billing/service.ts`
- `internal/services/src/subscriptions/`
- Phase 2 webhook tables in `internal/db`

## Execution Plan

### Slice 1: Add a generic provider webhook route

Create a route under `apps/api/src/routes/` that:

- preserves the raw request body
- captures headers needed for signature verification
- selects the provider explicitly
- calls the provider runtime for verification and normalization

Route responsibilities should stop at:

- request parsing
- provider selection
- handing a normalized event to the use-case layer

### Slice 2: Persist webhook events idempotently

Before side effects run:

- insert or load by `(projectId, provider, providerEventId)`
- skip already processed events
- preserve payload and failure details

This table is the operational safety net for replay and debugging. Treat it as
part of the critical path, not an audit afterthought.

### Slice 3: Create `processWebhookEvent`

Create a dedicated use case that coordinates:

- invoice state transitions
- payment status reconciliation
- subscription machine notifications
- ledger settlement updates

Suggested shape:

- input is a normalized provider event plus project/provider context
- output is a small processing result that can be persisted back to
  `webhook_events`

### Slice 4: Implement Stripe normalization

Add Stripe-specific verification and normalization in the Stripe provider
adapter.

Requirements:

- verify signatures with the stored webhook secret
- normalize supported Stripe events into provider-neutral event types
- return normalized payloads to the route/use-case layer

The normalized event contract should be the only shape that
`processWebhookEvent` consumes.

### Slice 5: Wire payment outcomes into settlement

Use normalized events to:

- mark matching ledger entries settled on successful payment
- record failed payment attempts and update invoice state
- notify the subscription machine of payment success or failure

Make the mapping from provider invoice ids to internal invoice and ledger
artifacts explicit and testable.

### Slice 6: Add replay and correctness tests

Cover:

- duplicate webhook delivery
- invalid signatures
- successful settlement
- failed payment transitions
- refund or dispute reversal handling

Likely affected packages:

- `api`
- `@unprice/services`

## Validation

- `pnpm --filter api test`
- `pnpm --filter @unprice/services test`
- `pnpm --filter @unprice/services typecheck`
- `pnpm --filter api type-check`

## Exit Criteria

- provider webhooks are received through one generic route
- webhook events are persisted and idempotent
- normalized provider events drive invoice, subscription, and ledger updates
- successful payment settles ledger entries safely

## Out Of Scope

- agent usage routing
- trace aggregation
- wallet UX or wallet funding flows
