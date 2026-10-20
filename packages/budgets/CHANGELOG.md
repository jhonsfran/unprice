# @unprice/budgets

## 0.1.0

### Minor Changes

- 88a1077: Add `@unprice/budgets`, the budget client on its own: hard caps on any key you choose, without the rest of the API. Its `Unprice` client has the same `unprice.budgets.*` operations, `unprice.budget(key)` handles (remote, or `{ mode: "local" }` from a lease in memory) and `unprice.close()` as `@unprice/api`, so code moves between the two by changing the import. `@unprice/api` now depends on `@unprice/budgets` and re-exports its handles, errors and types; `unprice.budget()` and `unprice.close()` behave as before, and `BudgetExceededError` and the other budget errors are the same classes from either package.

### Patch Changes

- 72a8741: `spend` now throws `BudgetUnavailableError` when the authorization fails with 429 `TOO_MANY_REQUESTS` or 500 `INTERNAL_SERVER_ERROR`, not `BudgetRequestError`. Either answer may follow a committed authorization, so recover it the same way as a network failure: retry with the same estimate, `ttlMs`, and `error.idempotencyKey`. `authorize` and `charge` still return these failures as `{ error }`.
