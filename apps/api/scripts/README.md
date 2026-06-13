# API scripts: queues + events pipeline

Scripts to provision Cloudflare Queues and the Cloudflare Pipelines + R2 Data Catalog resources used by the API events pipeline.

Reference: [Build an end-to-end data pipeline (Cloudflare)](https://developers.cloudflare.com/r2-sql/tutorials/end-to-end-pipeline/).

## Layout

- `configure-queues.sh` – Creates queue resources from `apps/api/wrangler.jsonc` (`producers`, `consumers`, and `dead_letter_queue`).
- `configure-lakehouse-pipelines.sh` – Configures the **events** stream, sink, and pipeline for one environment.
- `setup-r2.sh` – Applies lifecycle rules to the selected environment bucket.
- `delete-r2-bucket.sh` – Force-deletes an R2 bucket by purging objects first, then deleting the bucket.
- `r2-lifecycle.json` – Lifecycle config used by `setup-r2.sh`.
- `generate-lakehouse-schemas.ts` – Regenerates `schemas/events.json` from the `@unprice/lakehouse` registry.
- `schemas/events.json` – Cloudflare stream schema for lakehouse events.

All scripts are intended to be run from `apps/api`.

## NPM shortcuts

From `apps/api`:

- `npm run scripts:queues -- all` (or `dev` / `preview` / `prod`)
- `npm run scripts:r2-pipelines -- dev` (options: `--skip-lifecycle`, `--skip-compaction`, `--recreate`, `--delete-only`, `--name-prefix`, `--name-suffix`)
- `npm run scripts:r2-lifecycle -- dev` (or `preview` / `prod`)
- `npm run scripts:r2-delete-bucket -- dev --yes` (or `preview` / `prod`)
- `npm run scripts:lakehouse-schemas`

## Prerequisites

1. Wrangler login:

```bash
npx wrangler login
```

2. API token for R2 Data Catalog and Pipelines.
   Recommended permissions:
   - Workers Pipelines: Read, Send, Edit
   - Workers R2 Data Catalog: Read, Edit
   - Workers R2 SQL: Read
   - Workers R2 Storage: Read, Edit

Export token:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN="<your-token>"
```

`CLOUDFLARE_API_TOKEN` is accepted as fallback by `configure-lakehouse-pipelines.sh`.

## Queue setup

Create queues from `wrangler.jsonc`:

```bash
# all env queues (default behavior)
./scripts/configure-queues.sh

# explicit scope
./scripts/configure-queues.sh all
./scripts/configure-queues.sh dev
./scripts/configure-queues.sh preview --dry-run
```

The script is idempotent and treats “already exists” responses as success.

## Events pipeline setup

Configure events stream/sink/pipeline for one environment:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN="<token>"
./scripts/configure-lakehouse-pipelines.sh dev
```

Supported environments: `dev`, `preview`, `prod`.

The script resolves the lakehouse bucket from `apps/api/wrangler.jsonc` by preferring top-level `unprice_lakehouse_prod` for `prod` and `unprice_lakehouse_dev` for `preview`/`dev`, then falling back to a `LAKEHOUSE` binding for compatibility.

### Options

- `--skip-lifecycle` – Do not apply lifecycle rules.
- `--skip-compaction` – Do not enable catalog compaction.
- `--recreate` – Delete existing events pipeline resources and recreate them.
- `--delete-only` – Delete existing events pipeline resources and exit.
- `--name-prefix <prefix>` – Prefix for stream/sink/pipeline names.
- `--name-suffix <suffix>` – Suffix for stream/sink/pipeline names (default: `_<environment>`).

### What gets created

Default names (for env `dev`):

- Stream: `lakehouse_events_stream_dev`
- Sink: `lakehouse_events_sink_dev`
- Pipeline: `lakehouse_events_pipeline_dev`

Catalog target:

- Namespace: `lakehouse`
- Table: `events`

## Lifecycle only

```bash
./scripts/setup-r2.sh dev
```

Lifecycle rules (`r2-lifecycle.json`):

- `lakehouse/raw/` – Delete after 7 days.
- `lakehouse/compacted/` – Delete after 1 year.
- All prefixes – Abort incomplete multipart uploads after 7 days.

## Force-delete bucket (purge + delete)

Wrangler does not support `--force` on `r2 bucket delete`.  
Use this script to empty the bucket first and then delete it.

```bash
./scripts/delete-r2-bucket.sh dev --yes
```

Options:

- `--bucket <name>` – Override resolved LAKEHOUSE bucket.
- `--skip-purge` – Skip object purge and only attempt delete.
- `--dry-run` – Print commands only.
- `--yes` – Skip interactive confirmation.

Required env vars for purge step:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `CLOUDFLARE_ACCOUNT_ID` (or `R2_ACCOUNT_ID`)

## Regenerate events schema JSON

When the lakehouse registry changes:

```bash
npm run scripts:lakehouse-schemas
```

This writes:

- `scripts/schemas/events.json`

## After configuration

1. List streams and ingest endpoints:

```bash
npx wrangler pipelines streams list
```

2. Query table:

```bash
npx wrangler r2 sql query "<WAREHOUSE>" "SELECT * FROM lakehouse.events LIMIT 10"
```

3. Wrangler pipeline binding should point to your created pipeline name for each environment with binding `PIPELINE_EVENTS`.

## Idempotency

- `configure-queues.sh` and `configure-lakehouse-pipelines.sh` are safe to re-run.
- Use `--recreate` (or `--delete-only` followed by a normal run) for clean replacement of events pipeline resources.
