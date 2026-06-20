# ADR-0004: API Operation Contracts And SDK Surface

## Status

Accepted

## Date

2026-06-20

## Context

The public Hono API, generated OpenAPI types, docs OpenAPI JSON, and TypeScript SDK can drift independently. Recent drift examples include SDK-generated OpenAPI types mentioning operations that the current API source no longer registers, docs OpenAPI missing current routes, stale docs containing removed realtime operations, and public route operation IDs that expose implementation terms instead of product jobs.

Developers using Unprice think in product workflows: checking access, recording usage, consuming usage with an immediate decision, managing runs, reading wallet/invoice state, configuring customers/plans/features/subscriptions/payment methods, and inspecting analytics or ingestion health. They should not need to know whether a workflow is internally implemented as entitlements, events, analytics, Durable Objects, or provider callbacks.

## Decision

Every API route must declare an Unprice endpoint contract next to its Hono OpenAPI route declaration. The contract records:

- `audience`: `public`, `internal`, or `callback`.
- `category`: `runtime`, `configuration`, `money`, `analytics`, or `operations`.
- `docs.expose` when an operation should be visible in generated public docs.
- `sdk.path` for SDK-exposed public operations, or `sdk: false` when an operation should not generate a first-class SDK method.
- `idempotency` metadata for side-effecting public operations.

For every SDK-exposed public endpoint, `operationId` must equal `sdk.path.join(".")`. The first OpenAPI tag and first public path segment must match the top-level SDK namespace using product language.

The TypeScript SDK public resource tree is generated from the OpenAPI document by reading public endpoint contracts whose `sdk` field is not `false`. Hand-written SDK transport logic remains centralized in one generic operation caller; individual endpoint wrappers are generated.

Internal and provider-callback routes may appear in OpenAPI for operational visibility, but they must set `sdk: false` and never generate public SDK resources.

## Consequences

New public endpoint development becomes contract-first: route metadata, OpenAPI, docs JSON, and SDK resources are generated or checked from one declared product operation.

The SDK becomes less hand-written, which reduces polish drift but requires moving endpoint-specific ergonomic defaults into the API contract itself.

Renaming public operations is an explicit API design step. This ADR allows a breaking migration because backwards compatibility is not required for this project stage.

## Rules

- SDK-exposed public endpoint `operationId` equals SDK method path.
- Public endpoints that should stay out of the SDK set `sdk: false`.
- Public SDK methods are one-object calls, except zero-input methods.
- Side-effecting public operations declare idempotency metadata.
- Internal and callback routes set `audience` plus `sdk: false` and are ignored by SDK generation.
- Docs OpenAPI and SDK generated OpenAPI types come from the same local API document.
- `packages/react` is out of scope for this ADR.
