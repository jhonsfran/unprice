# ADR-0007. Authoritative billing usage snapshots

## Status

Accepted.

## Date

2026-10-27.

## Context

The entitlement processor accepts and prices usage before the reporting queue delivers its facts to Tinybird.
Billing previously read Tinybird and then marked the period invoiced. Delayed reporting could therefore remove accepted usage from an invoice permanently.
Tinybird also expires raw facts after 90 days. It cannot hold the complete evidence for an annual billing period.

## Decision

The entitlement processor owns the monetary total for each subscription usage period.
The processor commits signed ledger-scale amounts and quantities in the same transaction as the accepted event receipt.
Tinybird remains a reporting source. Billing does not query Tinybird for subscription usage charges.

Each snapshot has its entitlement, subscription item, billing period, statement, currency, scale, and service window.
Its lifecycle has three states.

1. `open` accepts new events.
2. `sealed` holds immutable invoice totals and rejects new events. Accepted event replays still return their original receipts.
3. `completed` records that the invoice transaction committed.

Billing period generation registers a zero snapshot before its database transaction commits and before activation can permit usage.
Only this explicit `period_generation_v1` registration establishes zero usage.
A missing snapshot has unknown coverage and blocks billing.

The rollout starts with fresh entitlement IDs, Durable Object state, and matching billing periods.
Existing entitlement state is outside the supported contract. There is no legacy migration or marker metadata.
The processor requires a registered snapshot before subscription usage can be accepted.

New billing period IDs derive from the stable period identity and registration version.
If registration succeeds but the database transaction fails, a retry uses the same ID and adopts the existing snapshot.
A registration that never receives a database commit can retain an unused zero snapshot. It must not be deleted after an ambiguous commit failure.

The internal billing gateway seals all snapshots before it flushes wallet reservations.
The final event commit checks the seal after asynchronous wallet calls.
This prevents accepted usage from entering a snapshot after its corresponding wallet flush.
Billing uses the sealed amounts with its existing deterministic ledger transfer identity.
Periods with wallet captures continue to use those captures and do not receive a second charge.
For capped phases, captured money must equal the sealed period charge before closure.
For uncapped phases, run captures can fund part of the period; billing posts only the remaining amount as a receivable.
All captures, including due credit-line captures, reduce that remainder exactly once.
Captures above the sealed charge block closure.
This check compares money. Capture quantity metadata can repeat across funding legs, so it does not prove an independent quantity total.
After the invoice transaction commits, billing acknowledges completion.
Completion failures remain retryable even when no pending periods remain.

Open and sealed snapshots prevent automatic and manual object deletion.
Completed snapshots remain until the event replay retention window expires.

Signed corrections can reduce an open period's total to zero.
A correction that would make the period total negative requires a credit against an earlier invoice.
The processor rejects that correction atomically with a stable receipt until a separate credit workflow exists.
Trial billing periods produce zero charges even when their accepted facts have a positive priced amount.

## Alternatives

A durable accepted-fact count could block billing until Tinybird contains every accepted fact.
That design preserves the old rating source but still depends on reporting availability and the 90-day fact lifetime.
It also requires a seal before the count can be stable.

Reading current grant totals cannot recover usage for a billing window that cuts through a grant reset window.
Per-billing-period state is required in either design.

## Consequences

Accepted usage no longer depends on reporting delivery before invoice closure.
The processor retains a small durable snapshot for each unfinished billing period.
The change does not support existing entitlement or billing state.
Registration adds an internal API call during period generation. An unavailable API blocks activation and leaves generation retryable.

Deploy the API worker, Durable Object migration, and internal snapshot RPCs before enabling the new billing flow.
Disable old accepting code during cutover. Use fresh entitlement IDs and matching billing state together.
Deleting only Durable Object state while retaining pending historical usage is not a supported reset.
No deployment is part of this change.

## Related decisions

[ADR-0001](ADR-0001-canonical-backend-architecture-boundaries.md) continues to define service and adapter ownership.
[ADR-0003](ADR-0003-wallet-reservation-grant-lifecycle.md) continues to define wallet capture ownership.
