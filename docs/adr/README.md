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

## How To Use

- Read ADRs before changing architecture-sensitive paths (`apps/api`, `internal/services`, `internal/trpc`).
- Prefer extending existing ADRs over introducing undocumented patterns.
- If you need to break an accepted ADR, create a new ADR that supersedes it.
