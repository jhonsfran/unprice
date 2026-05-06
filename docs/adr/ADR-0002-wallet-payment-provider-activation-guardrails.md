# ADR-0002: Wallet And Payment Provider Activation Guardrails

## Status

Accepted

## Date

2026-05-06

## Context

Recent local E2E work exposed several failure modes in the wallet, ledger, and
payment-provider boundary:

- customer signup returned `200`, but the subscription parked in
  `pending_activation`
- the failure looked like a missing sandbox payment webhook, but openlogs showed
  activation reached wallet provisioning and failed at DB commit
- project funding accounts were not always seeded before customer wallet
  movements
- the deferred wallet invariant compared wallet minor units against pgledger
  decimal balances
- the tiny-tools verifier accepted `feature_missing` for a missing customer,
  hiding an API behavior regression
- free or zero-cost usage can look like paid usage unless the reservation layer
  explicitly checks positive projected cost

These are not isolated bugs. They define the safety contract for building AI-era
usage billing on top of payment providers, wallets, reservations, and pgledger.

## Decision Drivers

- Signup and activation must be deterministic for free, sandbox, and zero-amount
  plans.
- Provider webhooks must settle external payment outcomes, not be required to
  make direct free provisioning work.
- Ledger balance must remain the source of truth for money movement.
- Wallet state must support high-volume usage without per-event ledger writes.
- Tests must distinguish entitlement failures from customer lookup failures.
- Amount units must be explicit at every boundary.

## Decision

We keep the wallet/ledger architecture, with the guardrails below.

### 1) Direct Provisioning Must Not Depend On Payment Webhooks

For free plans, zero-amount plans, and sandbox direct provisioning, signup must
be able to create:

- customer
- subscription
- subscription phase
- billing period
- customer entitlements
- project funding accounts
- customer wallet accounts
- activation grants when applicable

without waiting for a provider webhook.

Provider webhooks remain mandatory for provider-owned outcomes:

- payment succeeded
- payment failed
- refund
- dispute
- provider invoice state changes
- settlement of receivables or top-ups

If a signup parks in `pending_activation`, first inspect activation and wallet
logs. Do not assume webhook delivery is the cause.

### 2) Wallet Activation Is A Recoverable Gate

Activation may fail after the subscription row exists. That state is recoverable,
but ingestion must not treat it as active funding.

Required behavior:

- failed wallet activation parks the subscription in `pending_activation`
- callers surface activation failure instead of returning a false success
- a sweeper or manual retry can re-run activation idempotently
- ingestion is denied while activation is pending

The activation path must be idempotent. Grant idempotency keys must converge on
the same wallet credit and ledger transfer after retries.

### 3) Project Funding Accounts Are First-Class Ledger Accounts

Every project and currency tuple has platform funding accounts:

```text
platform.{projectId}.funding.topup
platform.{projectId}.funding.promo
platform.{projectId}.funding.plan_credit
platform.{projectId}.funding.manual
platform.{projectId}.funding.credit_line
```

Customer accounts are funded from these project accounts:

```text
platform.{projectId}.funding.credit_line -> customer.{customerId}.available.granted
```

The customer-side "plus" may later move through state buckets:

```text
available.granted -> reserved -> consumed
```

Current account balances are state, not history. To answer "what was originally
granted?", read `unprice_wallet_credits.issued_amount` or the original
`pgledger_entries`.

### 4) Account Seeding Must Be Transaction-Aware

Before any wallet movement, seed:

1. project funding accounts
2. customer wallet accounts

If the wallet operation already runs inside a transaction, seeding must use that
executor. Do not open nested transactions from the wallet or ledger gateway.

This matters for activation because activation performs several DB writes under
one customer lock. Seeding outside the correct transaction boundary can produce
commit failures or missing account state.

### 5) Amount Scale Is A Boundary Contract

The application stores wallet and invoice amounts as ledger-scale minor units:

```text
1 EUR    = 100_000_000
100 EUR  = 10_000_000_000
0.10 EUR = 10_000_000
```

pgledger account views expose decimal balances:

```text
100 EUR  -> 100.00000000
0.10 EUR -> 0.10000000
```

Therefore:

- wallet bigint columns compare in minor units
- pgledger balances compare in decimal units
- constraints that compare both must normalize one side
- provider adapters convert to provider minor units at the provider edge
- provider webhooks convert back to ledger-scale minor units before ledger writes

Do not name fields `cents` unless they are actually provider/currency minor
units. Use `amount` plus documentation for ledger-scale amounts.

### 6) `creditLineAmount` Means Period Usage Allowance

The historical column name is misleading. It is not the plan fee and not a
customer creditworthiness score.

`creditLineAmount` means:

- explicit per-period usage allowance
- issued as a `credit_line` wallet grant at activation or renewal
- expires at period end
- drained by reservations for priced usage
- settled by invoicing/payment provider flow later

Default behavior:

- new plan versions default to `0`
- `0` means no explicit allowance
- arrears plans may derive a conservative allowance from finite, priced usage
  limits
- unlimited paid usage requires an explicit allowance or purchased balance

For a 100 EUR allowance, configure `10_000_000_000`, not `100`.

### 7) Reserve Only Positive Cost

Reservations are for money, not entitlement existence.

Required behavior:

- zero-cost usage must not reserve wallet funds
- free usage should verify entitlement and bypass wallet reservation
- priced usage reserves only when projected cost is positive
- if no funds are available for priced usage, return `WALLET_EMPTY`

This keeps free plans usable without artificial wallet balances and prevents
the ledger from filling with zero-value reservation noise.

### 8) Tests Must Prove The Contract

Tiny-tools and service tests should cover:

- signup preflight finds a published plan version and prints its features
- signup creates an active subscription, not `pending_activation`
- entitlements expose usable feature slugs from nested plan-version feature data
- verifying all entitlements passes with real feature slugs
- fake feature returns `feature_missing`
- fake customer uses a real feature slug and returns `customer_not_found`
- positive-cost usage without funds skips or fails as `WALLET_EMPTY`
- project funding accounts exist after wallet activation
- customer wallet accounts exist after wallet activation

When debugging local server behavior, use openlogs first:

```bash
openlogs tail -n 200
```

For activation failures, search for:

```text
pending_activation
activateSubscription
Wallet activation
Failed query: commit
ledger.seed_platform_accounts_failed
ledger.ensure_customer_accounts_failed
```

## Consequences

### Positive

- Free and sandbox signup flows do not depend on provider webhook timing.
- Wallet activation failures become explicit and retryable.
- Ledger balances remain auditable through pgledger entries.
- High-volume usage can run through reservations without per-event ledger writes.
- Payment-provider integration stays focused on settlement and reconciliation.
- Tests catch customer, feature, wallet, and amount-scale regressions separately.

### Negative

- The model has multiple state buckets, so balance rows alone do not explain
  history.
- Engineers must understand ledger-scale minor units versus pgledger decimal
  balances.
- Activation touches several domains and needs strong integration tests.
- Existing plan versions with historical `creditLineAmount` values may need data
  cleanup or republishing.

### Risks And Mitigations

- Risk: a zero or tiny allowance is configured accidentally.
  Mitigation: plan UI and API docs must show scale examples and formatted money.

- Risk: payment-provider adapters double-convert amounts.
  Mitigation: conversion happens only at provider boundaries, with tests.

- Risk: `pending_activation` is ignored by callers.
  Mitigation: E2E asserts active or trialing status before usage tests.

- Risk: account balances appear unbalanced because state buckets moved money.
  Mitigation: inspect `pgledger_entries` and `unprice_wallet_credits`, not only
  current account views.

## Build Process Checklist

Before changing payment, signup, wallet, or usage billing behavior:

1. Read this ADR and the wallet phase plan.
2. Identify whether the flow is direct provisioning, provider checkout, webhook
   settlement, or usage ingestion.
3. Confirm all amount units at the API, DB, ledger, and provider boundary.
4. Confirm project funding accounts and customer accounts are seeded before
   transfers or reservations.
5. Confirm activation is idempotent and recoverable.
6. Confirm zero-cost usage does not touch wallet reservations.
7. Run the signup E2E before the usage E2E.
8. Use openlogs for local server failures before changing provider code.

## Related Documents

- [ADR-0001: Canonical Backend Architecture Boundaries](./ADR-0001-canonical-backend-architecture-boundaries.md)
- [Phase 5: Settlement And Webhook Pipeline](../plans/unprice-phase-05-settlement-webhooks.md)
- [Phase 7: Wallets, Reservations & Credit Lifecycle](../plans/unprice-phase-07-credits-wallets.md)
