# Phase 7: Trace Aggregation DO (Optional Extension)

Source: [../unprice-implementation-plan.md](../unprice-implementation-plan.md)  
PR title: `feat: add trace aggregation durable object`  
Branch: `feat/trace-aggregation`

## Mission

Add a trace-level aggregation durable object only if event-level rating is no
longer the correct billing unit for agent workloads. This phase should group
multiple raw usage events into a trace-scoped output that then flows through the
same rating and ledger path built in Phase 6.

## Dependencies

- Phase 6 must be complete first.

## When To Do This Phase

Do this only if product requirements say billing must happen at the trace level,
not per event. If event-level billing remains correct, skip this phase.

## Read First

- [../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts](../../apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts)
- [../../apps/api/src/ingestion/audit/IngestionAuditDO.ts](../../apps/api/src/ingestion/audit/IngestionAuditDO.ts)
- [../../apps/api/src/index.ts](../../apps/api/src/index.ts)
- [../../apps/api/wrangler.jsonc](../../apps/api/wrangler.jsonc)
- [./unprice-phase-06-agent-billing.md](./unprice-phase-06-agent-billing.md)

## Guardrails

- Reuse existing Durable Object and SQLite patterns already established in the
  repo.
- Do not introduce TypeScript `any` types. Use concrete types or `unknown`
  with explicit narrowing where needed.
- Keep the output of aggregation compatible with the standard rating path.
- Preserve idempotency for duplicate events and for repeated completion signals.
- Keep alarms and cleanup explicit so dormant trace state does not accumulate
  forever.

## Primary Touchpoints

- `apps/api/src/ingestion/` new trace aggregation DO
- `apps/api/src/index.ts`
- `apps/api/wrangler.jsonc`
- ingestion routing and queue path where trace-scoped events are identified
- tests alongside existing ingestion DO tests

## Execution Plan

### Slice 1: Create the DO skeleton

Create a new `TraceAggregationDO` using the patterns already used by
`EntitlementWindowDO` and `IngestionAuditDO`.

Include:

- deterministic state lookup
- SQLite-backed storage if trace state needs durability
- a narrow RPC surface for append, complete, and inspect

### Slice 2: Add trace-aware routing

Update ingestion to:

- detect trace-scoped events
- route them to the trace aggregator under a stable trace key
- emit aggregated output back into the standard rating pipeline on explicit
  completion or timeout

Do not fork a second billing pipeline for aggregated traces.

### Slice 3: Add timeout and cleanup

Use alarms to:

- flush abandoned traces after timeout
- clean up completed state
- avoid duplicated completion on restart or retry

Mirror existing self-destruction and cleanup patterns where they fit.

### Slice 4: Add integration tests

Cover:

- explicit completion
- timeout completion
- duplicate event handling
- multi-feature aggregation

## Validation

- `pnpm --filter api test`
- `pnpm --filter api type-check`

## Exit Criteria

- trace-scoped usage can be aggregated safely before rating
- aggregated output still uses the standard pricing, ledger, and settlement
  path
- duplicate delivery and timeout paths are safe

## Out Of Scope

- changing pricing math
- replacing the standard event billing path when trace billing is not required
