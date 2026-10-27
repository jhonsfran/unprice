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
A missing snapshot has unknown coverage and blocks billing. Existing periods do not receive inferred zero totals.

Registration also requires server-owned `billing_usage_genesis_v1` metadata bound to the entitlement ID.
The entitlement service writes this marker only when it inserts a new subscription entitlement.
Creation retries return existing rows without changing their marker. Caller metadata cannot mark an existing legacy ID.
The new processor requires a registered snapshot before that new ID can accept subscription usage.
Generation refuses every unmarked entitlement, including an old ID whose Durable Object is empty or was deleted.
Legacy entitlement IDs require explicit reconciliation before billing can continue.

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
It also requires explicit legacy coverage and a seal before the count can be stable.

Reading current grant totals cannot recover usage for a billing window that cuts through a grant reset window.
Per-billing-period state is required in either design.

## Consequences

Accepted usage no longer depends on reporting delivery before invoice closure.
The processor retains a small durable snapshot for each unfinished billing period.
Legacy periods without complete snapshots require an explicit reconciliation procedure before billing can continue.
Registration adds an internal API call during period generation. An unavailable API blocks activation and leaves generation retryable.

Deploy the API worker, Durable Object migration, and internal snapshot RPCs before deploying services that write genesis markers.
The marker proves zero coverage only after every accepting processor requires registered snapshots.
An old processor can accept unregistered usage for a marked entitlement during the reverse deployment order.
No deployment is part of this change.

## Related decisions

[ADR-0001](ADR-0001-canonical-backend-architecture-boundaries.md) continues to define service and adapter ownership.
[ADR-0003](ADR-0003-wallet-reservation-grant-lifecycle.md) continues to define wallet capture ownership.
