# Phase 2: Payment Provider Data Foundation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add provider data foundation`  
Branch: `feat/provider-data-foundation`

## Mission

Lay down the target database model for provider-neutral billing so runtime code
can stop depending on Stripe-specific customer fields and plan-version-level
provider coupling in later phases.

## Why This Phase Exists

- `customers.stripeCustomerId` is globally unique and does not fit
  multi-tenant provider mappings.
- runtime provider choice should live on subscription phases, not only on plan
  versions
- provider webhooks need durable storage and replayability before runtime
  webhook processing is added

## Read First

- [../../internal/db/src/schema/customers.ts](../../internal/db/src/schema/customers.ts)
- [../../internal/db/src/schema/subscriptions.ts](../../internal/db/src/schema/subscriptions.ts)
- [../../internal/db/src/schema/paymentConfig.ts](../../internal/db/src/schema/paymentConfig.ts)
- [../../internal/db/src/validators/customer.ts](../../internal/db/src/validators/customer.ts)
- [../../internal/db/src/validators/subscriptions/subscription.ts](../../internal/db/src/validators/subscriptions/subscription.ts)
- [../../internal/db/src/schema.ts](../../internal/db/src/schema.ts)
- [../../internal/db/src/validators.ts](../../internal/db/src/validators.ts)

## Guardrails

- This phase is schema-first. Do not start rewriting runtime reads and writes
  here.
- Prefer the target model over temporary transition tables or dual-read notes.
- Keep the provider model normalized enough for Stripe, sandbox, and the next
  provider.

## Primary Touchpoints

- `internal/db/src/schema/customers.ts`
- `internal/db/src/schema/subscriptions.ts`
- `internal/db/src/schema/paymentConfig.ts`
- `internal/db/src/schema/` new provider-related tables
- `internal/db/src/validators/` matching validators
- `internal/db/src/schema.ts`
- `internal/db/src/validators.ts`
- `internal/db/src/migrations/`

## Execution Plan

### Slice 1: Fix `stripeCustomerId` uniqueness

Replace the global uniqueness on `customers.stripeCustomerId` with a
project-scoped constraint that still supports legacy data until runtime reads
move away from this column.

Implementation notes:

- keep the column for now
- change only the constraint shape in this phase
- review indexes carefully so lookups stay efficient

### Slice 2: Add phase-level provider choice

Extend `subscription_phases` with `paymentProvider`.

Done when:

- new phases persist the provider at the phase level
- validators expose the new field
- later runtime work can read provider directly from `subscription_phases`

### Slice 3: Add `customer_provider_ids`

Create a normalized mapping table with these invariants:

- one row per `(projectId, customerId, provider)`
- unique lookup by `(projectId, provider, providerCustomerId)`
- composite foreign key back to `customers`
- `metadata` JSON for provider-owned facts such as subscription ids and default
  payment method ids

This table is the future home for provider identity. Avoid baking Stripe-only
semantics into the column names.

### Slice 4: Add webhook storage

Extend provider config and webhook persistence:

- add `webhookSecret` and `webhookSecretIv` to `payment_provider_config`
- add `webhook_events` with provider, provider event id, raw payload, status,
  and error payload

The storage model needs to support:

- idempotent processing
- replay/debugging
- signature verification inputs
- operational debugging after failed webhook handling

### Slice 5: Add validators and barrel exports

Add validators for:

- `customer_provider_ids`
- `webhook_events`
- updated `payment_provider_config`
- updated `subscription_phases`

Export everything from the real barrels:

- [../../internal/db/src/schema.ts](../../internal/db/src/schema.ts)
- [../../internal/db/src/validators.ts](../../internal/db/src/validators.ts)

### Slice 6: Generate and review the migration

Run:

- `pnpm --filter @unprice/db generate`

Then review:

- generated SQL
- migration snapshots in `internal/db/src/migrations/meta/`
- naming of new indexes and constraints

Done when:

- the migration is deterministic
- the new schema can be consumed by runtime refactors without more schema work

## Validation

- `pnpm --filter @unprice/db generate`
- `pnpm --filter @unprice/db typecheck`
- `pnpm --filter @unprice/db test`

## Exit Criteria

- provider identity no longer depends on a single Stripe-only customer column
- webhook persistence primitives exist
- runtime provider choice can move from plan versions to subscription phases
- all schema and validator exports are available from the canonical barrels

## Out Of Scope

- resolver refactors
- route changes
- webhook processing logic
- deletion of legacy Stripe runtime fields
