# Lakehouse Schema Evolution Guide

This package is the source of truth for lakehouse event schema.

This package is not a customer-facing query API. It only owns the Pipeline/R2 events schema used by the reporting consumer. Cloudflare Data Catalog partitioning is controlled by the sink's ingestion-time behavior; project_id, customer_id, and event_date are query columns, not partition guarantees.

## Source Of Truth

- Registry: `internal/lakehouse/src/registry.ts`
- Runtime validation: `internal/lakehouse/src/zod.ts` (generated from registry)
- Event TS types: `internal/lakehouse/src/interface.ts` (derived from registry types)
- Cloudflare stream schemas (`apps/api/scripts/schemas/*.json`) are generated from registry.

Do not hand-edit `apps/api/scripts/schemas/*.json`.

## Registry Model

Each source in `internal/lakehouse/src/registry.ts` defines:

- `firstVersion`
- `currentVersion`
- `fields[]` with:
  - `name`
  - `type`
  - `required` (ingestion validation / Cloudflare required flag)
  - `addedInVersion` (field introduction version)
  - `defaultValue` (evolution fallback value)
  - `description`

Use this as the canonical schema history per source.

## Cloudflare Type Mapping

Internal field type -> Cloudflare stream schema type:

- `string` -> `string`
- `int64` -> `int64`
- `int32` -> `int32`
- `float64` -> `f64`
- `float32` -> `f32`
- `boolean` -> `bool`
- `json` -> `json`
- `timestamp` -> `timestamp`
- `datetime` -> `timestamp`
- `bytes` -> `bytes`
- `list` -> `list`
- `struct` -> `struct`

Cloudflare conversions/normalization are handled by `toCloudflarePipelineSchema()` in `internal/lakehouse/src/registry.ts`.

## Safe Changes

### 1) Add a field (recommended, non-breaking)

1. Add field in `internal/lakehouse/src/registry.ts` for the source.
2. Set:
   - `addedInVersion` to the new source version
   - `defaultValue` to the fallback you want for older rows
   - `description` with clear semantics
3. Bump that source `currentVersion` if needed.
4. Prefer `required: false` first unless every producer can immediately populate it.
5. Update event production in API pipeline:
   - `apps/api/src/lakehouse/pipeline.ts`
6. Regenerate Cloudflare stream schemas:
   - `cd apps/api && npm run scripts:lakehouse-schemas`
7. Recreate pipeline resources for the target environment:
   - `cd apps/api && ./scripts/configure-lakehouse-pipelines.sh <env> --recreate`

### 2) Change field type or semantics (breaking)

Recommended approach:

1. Add a new field name (for example `amount_v2`) instead of mutating existing semantics in place.
2. Emit both old + new fields during migration window.
3. Migrate consumers to new field.
4. Remove old field later in a separate change.

Also bump schema version constant if needed:
- `internal/lakehouse/src/registry.ts` -> source `currentVersion`

### 3) Remove a field

Field removal is breaking for downstream readers.

1. First stop usage in consumers.
2. Keep field in schema temporarily as optional if possible.
3. Remove only after all environments are migrated and validated.
4. Regenerate schemas and recreate resources.

## Rollout Process (Per Environment)

Use this sequence for `dev`, then `preview`, then `prod`:

1. `pnpm --filter @unprice/lakehouse typecheck`
2. `cd apps/api && npm run scripts:lakehouse-schemas`
3. `cd apps/api && ./scripts/configure-lakehouse-pipelines.sh <env> --recreate`
4. Verify resources exist:
   - `npx wrangler pipelines streams list | rg "_<env>"`
   - `npx wrangler pipelines sinks list | rg "_<env>"`
   - `npx wrangler pipelines list | rg "_<env>"`
5. Verify catalog tables:
   - `npx wrangler r2 sql query "$WAREHOUSE" "SHOW TABLES IN lakehouse"`

## Resource Naming Convention

Default naming in `configure-lakehouse-pipelines.sh`:

- Stream: `lakehouse_<source>_stream_<env>`
- Sink: `lakehouse_<source>_sink_<env>`
- Pipeline: `lakehouse_<source>_pipeline_<env>`

If you use custom `--name-prefix` or `--name-suffix`, ensure `apps/api/wrangler.jsonc` pipeline bindings match exactly.

## Notes

- R2 bucket lifecycle and bucket creation are separate concerns from pipeline schema.
- R2 Data Catalog partitioning is controlled by Cloudflare sink behavior (`__ingest_ts`), not by this registry.
