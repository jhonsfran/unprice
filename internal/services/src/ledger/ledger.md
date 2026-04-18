# pgledger

Double-entry bookkeeping ledger implemented entirely as PostgreSQL functions and views. No application-level code — install the SQL, call the functions.

## Architecture

Three tables, three views, and a small set of SQL functions:

- **pgledger_accounts** — each account has a name, currency, balance, version, and optional balance constraints
- **pgledger_transfers** — each transfer moves a positive amount from one account to another (same currency)
- **pgledger_entries** — two entries per transfer (debit and credit), recording previous and current balance

Views (`pgledger_accounts_view`, `pgledger_transfers_view`, `pgledger_entries_view`) are the public query interface. The entries view joins to transfers to include `event_at` and `metadata`.

All IDs are prefixed ULIDs: `pgla_*` (accounts), `pglt_*` (transfers), `pgle_*` (entries). Generated from UUIDv7 converted to ULID.

## Core API

```sql
-- Create an account (returns pgledger_accounts_view row)
pgledger_create_account(
    name TEXT,
    currency TEXT,
    allow_negative_balance BOOLEAN DEFAULT TRUE,
    allow_positive_balance BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT NULL
) → SETOF pgledger_accounts_view

-- Create a single transfer (returns pgledger_transfers_view row)
pgledger_create_transfer(
    from_account_id TEXT,
    to_account_id TEXT,
    amount NUMERIC,
    event_at TIMESTAMPTZ DEFAULT NULL,
    metadata JSONB DEFAULT NULL
) → SETOF pgledger_transfers_view

-- Create multiple transfers atomically (returns pgledger_transfers_view rows)
pgledger_create_transfers(
    transfer_requests TRANSFER_REQUEST[],
    event_at TIMESTAMPTZ DEFAULT NULL,
    metadata JSONB DEFAULT NULL
) → SETOF pgledger_transfers_view

-- VARIADIC convenience form
pgledger_create_transfers(
    VARIADIC transfer_requests TRANSFER_REQUEST[]
) → SETOF pgledger_transfers_view
```

`transfer_request` is a composite type: `(from_account_id TEXT, to_account_id TEXT, amount NUMERIC)`.

## Key constraints and design decisions

- Amounts must be positive; the direction is determined by from/to
- from_account_id must differ from to_account_id
- Transfers between accounts with different currencies are rejected
- Multi-currency exchange uses 4 accounts (2 user + 2 liquidity) and `pgledger_create_transfers`
- Accounts lock in sorted ID order to prevent deadlocks
- `event_at` records when the real-world event happened; `created_at` records when the ledger entry was written
- Balance constraints are checked after each update — set both `allow_negative_balance=false` and `allow_positive_balance=false` to freeze an account
- Account `version` increments on every transfer touching that account

## Implementation

- `pgledger.sql` — the entire implementation (tables, views, functions)
- `vendor