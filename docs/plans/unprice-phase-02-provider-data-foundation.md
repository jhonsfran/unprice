# Phase 2: Payment Provider Data Foundation

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add provider data foundation`  
Branch: `feat/provider-data-foundation`

## Mission

Lay down the target database model for provider-neutral billing so runtime code
can stop depending on Stripe-specific customer fields and plan-version-level
provider coupling in later phases.

Also land minimal UI compatibility updates so existing dashboard forms keep
working as schema contracts evolve in this phase.

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
- Keep UI work to compatibility updates only. Full provider-neutral UX cutover
  belongs to Phase 3.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Prefer the target model over temporary transition tables or dual-read notes.
- Keep the provider model normalized enough for Stripe, sandbox, and the next
  provider.

## UI Patterns (Agent Notes)

When touching `apps/nextjs`, follow existing patterns:

- App Router split: server components load data via
  `~/trpc/server` (`api.<router>.<procedure>`), client components own user
  interactions.
- Client data/mutations use `useTRPC()` + React Query
  (`useQuery`, `useMutation`) instead of ad hoc fetch wrappers.
- Forms use `useZodForm` with `@unprice/db/validators` schemas and UI controls
  from `@unprice/ui/form`.
- Mutation UX pattern: `toastAction(...)` for feedback plus `router.refresh()`
  or `revalidateAppPath(...)` to refresh stale views.
- Route context pattern: use `useParams()` for
  `[workspaceSlug]/[projectSlug]` scoped pages.

## Primary Touchpoints

- `internal/db/src/schema/customers.ts`
- `internal/db/src/schema/subscriptions.ts`
- `internal/db/src/schema/paymentConfig.ts`
- `internal/db/src/schema/` new provider-related tables
- `internal/db/src/validators/` matching validators
- `internal/db/src/schema.ts`
- `internal/db/src/validators.ts`
- `internal/db/src/migrations/`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/payment/_components/stripe-payment-config-form.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions/subscription-phase-form.tsx`
- `internal/trpc/src/router/lambda/paymentProvider/`

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

### Slice 6: Keep UI and tRPC contracts compatible with schema additions

Apply only compatibility-safe updates required so dashboard flows do not break
once Phase 2 schema/validator changes land.

Done when:

- payment-provider config inputs/outputs can carry new config fields introduced
  in this phase (for example webhook secret fields) without forcing the full UX
  rewrite yet
- payment settings UI copy no longer implies Stripe-only ownership for generic
  provider config primitives
- subscription phase create/update payloads include the new phase-level
  provider field from schema/validator contracts
- existing onboarding and customer flows still work with sandbox and Stripe
  after Phase 2 schema changes

### Slice 7: Generate and review the migration

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
- `pnpm --filter @unprice/trpc typecheck`
- `pnpm --filter nextjs typecheck`

## Exit Criteria

- provider identity no longer depends on a single Stripe-only customer column
- webhook persistence primitives exist
- runtime provider choice can move from plan versions to subscription phases
- all schema and validator exports are available from the canonical barrels

## Out Of Scope

- resolver refactors
- provider-neutral route and runtime refactors
- full provider-neutral UI redesign (settings, onboarding, and payment method
  flows)
- webhook processing logic
- deletion of legacy Stripe runtime fields
