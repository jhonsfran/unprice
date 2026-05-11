# Service Test SQL Seeds

Seed files in this directory are restored by `seedTestDb` in the order passed
by the test or `TEST_DB_FIXTURES`.

Create fixtures from real dashboard/script-created rows, then trim the dump to
the smallest deterministic dataset needed by the scenario:

```bash
pg_dump --data-only --inserts \
  --table='unprice_*' \
  --exclude-table='unprice_audit_*' \
  -d unprice \
  > internal/services/src/test-fixtures/seeds/<fixture-name>.sql
```

Available fixtures:

- `base-project.sql`
- `plan-monthly-arrear.sql`
- `plan-monthly-advance.sql`
- `customer-active.sql`
- `subscription-monthly-arrear-active.sql`
- `subscription-monthly-arrear-capped-active.sql`
- `subscription-monthly-advance-active.sql`
- `subscription-monthly-advance-capped-active.sql`
