# Run Settlement Endpoint Design

## Goal

Record usage that a provider already incurred and reconcile its funded cost against an existing run
reservation without closing the parent run.

## Public Contract

Add `POST /v1/runs/settle/{runId}` as `runs.settle`. The request uses the same feature event shape as
`runs.consume`. The response uses the existing run sync decision shape and contains the final run
summary.

`runs.consume` remains the pre-work enforcement operation. It enforces the feature limit and run
budget and leaves an accepted run open. `runs.settle` is the post-work accounting operation. It does
not enforce the feature or run-budget limit because the provider cost already exists. It records
the full usage, funds as much as the original run reservation covers, and leaves the run open. The
run budget is a hard capture ceiling. Settlement never enlarges it.

For this post-work endpoint, `accepted: true` means that Unprice recorded the usage. It does not
mean that the reservation funded the full cost. Callers use `fundingStatus`, `fundedAmountMinor`,
and `unfundedAmountMinor` to inspect coverage.

## Processing

The API adapter authenticates the key, validates the event timestamp, resolves the run and its
entitlement, and calls the settlement use case. The use case delegates one serialized settlement
mutation to the Run Budget Durable Object. The mutation applies and prices the event with
`enforceLimit: false`, persists full run spend, and creates capture buckets only for the funded
portion. `runs.end` later flushes captures, releases unused reserved funds, and closes the run.

The use case then updates the Postgres run summary and enqueues the meter facts for reporting. These
external writes cannot share one database transaction with Durable Object storage. Retry safety is
the consistency mechanism: the event uses a stable idempotency key, a retry replays the stored apply
decision, and the close operation is idempotent.

## Failure Rules

- A feature-limit crossing is recorded and does not reject settlement.
- A run-budget crossing records full usage and returns `partially_funded` or `unfunded`.
- Settlement never captures more than the amount authorized when the run started.
- A settlement error leaves the lifecycle retryable with the same idempotency key.
- An accepted settlement returns a running summary. Only `runs.end` closes the run.
- The settlement path authenticates and scopes the run, but it does not run the pre-work customer
  bouncer. A customer state change after provider work must not suppress accounting evidence.

## SDK Facade

The generated SDK exposes `runs.settle`. The handwritten `reservations` facade calls settlement and
then `runs.end`, so one-step callers still receive a terminal run.

## Verification

Tests cover feature-limit bypass, partially funded settlement, full usage reporting, funded capture
capping, API auth and input mapping, generated operation exposure, and SDK facade closure.
