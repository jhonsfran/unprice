# pgledger (vendored)

Source-of-truth ledger SQL installed via `pnpm migrate:custom` after Drizzle's
own migrations run. Owned by this repo — vendored from the upstream so we do
not depend on `CREATE EXTENSION` (Neon, Supabase, and local Postgres all run
the same SQL without platform-specific allowlists).

## Files

| File | Origin | Notes |
|---|---|---|
| `pgledger.sql` | https://github.com/pgr0ss/pgledger | Modified to be idempotent: tables use `IF NOT EXISTS`, functions use `OR REPLACE`, the composite type is created defensively via `DO`/`EXCEPTION`. |
| `ulid.sql` | https://github.com/scoville/pgsql-ulid | Provides `uuid_to_ulid()` consumed by `pgledger_generate_id`. Already idempotent upstream. |
| `VERSION` | – | Pinned upstream commits. The `installPgledger` step in `migrate.ts` reads this and refuses downgrades. |

## Re-applying

Re-running `pnpm migrate:custom` is safe — every statement is idempotent and
the install function wraps the install in a transaction. The
`pgledger_install_version` table records each successful install so version
drift is observable from telemetry.

## Updating the vendored upstream

1. Pull the new SQL from upstream.
2. Re-apply the idempotency rewrites (CREATE OR REPLACE, IF NOT EXISTS, named
   indexes, `DO/EXCEPTION` for the `TRANSFER_REQUEST` type).
3. Bump `VERSION` to the new upstream commit.
4. Run `pnpm migrate:custom` against a clean dev database to verify; then run
   it a second time to confirm the no-op path.
