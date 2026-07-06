# Durable Idempotency Provider Rollback And Degradation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable HTTP idempotency store, provider failure injection, billing rollback coverage, `/health`, `/ready`, and a fail-open/fail-closed matrix after the runtime and job correctness plan lands.

**Architecture:** Keep HTTP idempotency in API middleware backed by a Cloudflare Durable Object with atomic claim/replay/in-flight lifecycle semantics compatible with `createHttpIdempotencyMiddleware`. Do not use KV-like storage unless it proves equivalent linearizable claim and commit behavior for money-moving requests. Keep provider fault injection and compensation ownership in `internal/services/src/payment-provider` and `internal/services/src/billing`; keep API health endpoints as thin adapters over explicit service health/readiness contracts.

**Tech Stack:** TypeScript, Vitest, Hono, Cloudflare Durable Objects, PaymentProviderService, BillingService, Result/Ok/Err.

---

## Priority Tasks

- [ ] Add an HTTP idempotency Durable Object store under `apps/api/src/middleware` with atomic claim, in-flight replay, response commit, and failure release semantics compatible with `createHttpIdempotencyMiddleware`.
- [ ] Add a Wrangler binding and migration for the idempotency Durable Object in `apps/api/wrangler.jsonc`.
- [ ] Wire `createHttpIdempotencyMiddleware` in `apps/api/src/index.ts` only after the durable store is available and money-moving routes use the atomic lifecycle.
- [ ] Add sandbox provider fault injection options to `internal/services/src/payment-provider/sandbox.ts` for charge, invoice, refund, and settlement failure points.
- [ ] Add billing finalization rollback tests in `internal/services/src/billing/service.finalize.test.ts` that prove provider failures either compensate committed provider effects or roll back local billing state.
- [ ] Add collection rollback tests in `internal/services/src/billing/service.collect.test.ts` that prove duplicate collection, partial provider success, and provider failure paths are compensated or made retry-safe.
- [ ] Implement or fix provider/billing compensation in `internal/services/src/payment-provider` and `internal/services/src/billing` if rollback tests expose a gap.
- [ ] Add explicit service health/readiness check contracts in the owning service or infrastructure layer so API routes do not perform direct dependency orchestration.
- [ ] Add `/health` and `/ready` routes in `apps/api/src/routes/health` as Hono adapters over the service health/readiness contracts.
- [ ] Add fail-open/fail-closed matrix documentation under `docs/architecture`.
- [ ] Add infra degradation tests under `apps/api/src/routes/health`.
