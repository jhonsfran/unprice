# Architecture Decision Records (ADRs)

This directory contains architecture decisions that are normative for the repo.

## Status Lifecycle

- `Proposed`
- `Accepted`
- `Deprecated`
- `Superseded`
- `Rejected`

## ADR Index

- [ADR-0001: Canonical Backend Architecture Boundaries](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0001-canonical-backend-architecture-boundaries.md) — `Accepted` (2026-04-05)
- [ADR-0002: Wallet And Payment Provider Activation Guardrails](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0002-wallet-payment-provider-activation-guardrails.md) — `Accepted` (2026-05-06)
- [ADR-0003: Wallet Reservation And Grant Lifecycle](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0003-wallet-reservation-grant-lifecycle.md) — `Accepted` (2026-05-17)
- [ADR-0004: API Operation Contracts And SDK Surface](/Users/jhonsfran/repos/unprice/docs/adr/ADR-0004-api-operation-contracts-and-sdk-surface.md) — `Accepted` (2026-06-20)
- [ADR-0005: Rate Cards, Pricing at Write Time, and the Model Cost Catalog](/Users/jhonsfran/repos/unprice/docs/specs/2026-10-14-adr-0005-rate-cards-and-budget-runtime.md) — `Accepted` (2026-10-14, revised 2026-10-16)
- [ADR-0006: The Budget Primitive](/Users/jhonsfran/repos/unprice/docs/specs/2026-10-16-adr-0006-budget-primitive.md) — `Accepted` (2026-10-16)

## How To Use

- Read ADRs before changing architecture-sensitive paths (`apps/api`, `internal/services`, `internal/trpc`).
- Prefer extending existing ADRs over introducing undocumented patterns.
- If you need to break an accepted ADR, create a new ADR that supersedes it.
