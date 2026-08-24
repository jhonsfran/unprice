# SDK Reservation Facade Design

## Goal

Let an application reserve a developer-defined maximum cost before it starts an expensive operation. The application can then settle actual feature usage or release the reservation.

The first release must support the `agent-trail` and `ai-chatbot` demos without a new ledger model, a new currency, or new API routes.

## Decision

Add a `reservations` facade to `@unprice/api`. It starts a run through `runs.start`, records and
reconciles incurred usage through `runs.settle`, closes settled runs through `runs.end`, and
releases known non-billable work through `runs.end`.

One reservation protects one expensive operation:

```text
reserve maximum cost
  -> denied: do not start provider work
  -> accepted: start provider work
       -> settle actual feature usage
       -> or release the reservation
```

The developer supplies the maximum amount in the customer's plan currency, in minor units. This
amount is a hard capture ceiling. Settlement records actual usage above it but never increases the
reservation or captures the unfunded difference. Unprice does not calculate a model-specific
maximum in this release. A provider limit such as `maxOutputTokens` can keep provider usage within
the reserved amount.

## Public Interface

The client exposes:

```ts
const { result: reservation, error } = await unprice.reservations.reserve({
  customerId,
  maximumAmountMinor: 10,
  idempotencyKey: messageId,
})
```

An accepted reservation returns a handle with stable reservation data and two terminal methods:

```ts
await reservation.settle({
  featureSlug: "ai-tokens",
  eventSlug: "ai-completion",
  properties: {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  },
})

await reservation.release()
```

The facade follows the SDK's existing `ApiResult` convention. A successful `reserve` result is the authorization. An API error means the application must not start the protected work.

`reserve` derives no pricing data. It maps `maximumAmountMinor` to the existing run budget and lets the API resolve the plan currency.

`settle` uses an idempotency key derived from the reservation key. The server records one incurred
feature event without feature or run-budget enforcement and returns its funding outcome. The facade
then closes the run and returns the settlement decision with the final run summary. In this
post-work response, `accepted` means that Unprice recorded the usage. The funding fields state how
much of that usage the reservation covered.

`release` ends the run as `canceled` without recording usage. The developer chooses whether failed provider work has billable usage: call `settle` when usage is known, or `release` when no usage must be charged.

The existing run expiry remains the recovery mechanism when the process stops before settlement.
When the caller omits `expiresAt` or passes `null`, Unprice sets it to one hour after the run starts.
Callers can select an earlier or later absolute timestamp, up to 24 hours after the run starts. The
start-run use case resolves this timestamp before it creates the Postgres row and passes the same
value to the Durable Object. The Durable Object applies the same policy as a defensive check for
direct internal calls. Its alarm expires the run and releases unused reserved funds.

## Scope

This release includes:

- one SDK facade implemented on top of generated run resources;
- one first-class `runs.settle` API operation that leaves its parent run open;
- focused SDK tests for reserve, settle, rejection, release, and request failures;
- SDK documentation with one non-streaming example and streaming lifecycle guidance.

This release does not include:

- a credits currency or a ledger refactor;
- provider price catalogs or automatic token-to-cost estimation;
- AI SDK middleware;
- multi-event or nested reservation abstractions.

## Failure And Idempotency Rules

- If `runs.start` returns an error, `reserve` returns that error and no handle.
- If settlement returns an API error, the caller retries with the same deterministic idempotency key.
- If settlement is accepted, the facade ends the run as completed.
- Budget exhaustion does not reject incurred usage. It returns `partially_funded` or `unfunded`.
- If settlement is rejected for a non-budget reason, the facade ends the run as failed.
- `release` is safe to retry through the existing idempotent run-ending behavior.

## Tradeoffs

The SDK facade keeps one reservation engine. Settlement and run closure are separate retry-safe
requests because low-level callers can settle many events before ending a run. The Durable Object,
Postgres read model, and reporting queue cannot share one database transaction. Stable idempotency
makes partial completion recoverable.

The method-bearing handle gives the demos a small interface, but it is an in-process object and cannot be serialized. Durable workflows must keep the `runId` or continue to use the lower-level `runs` API until a first-class reservation protocol exists.
