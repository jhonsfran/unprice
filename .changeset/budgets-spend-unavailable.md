---
"@unprice/budgets": patch
---

`spend` now throws `BudgetUnavailableError` when the authorization fails with 429 `TOO_MANY_REQUESTS` or 500 `INTERNAL_SERVER_ERROR`, not `BudgetRequestError`. Either answer may follow a committed authorization, so recover it the same way as a network failure: retry with the same estimate, `ttlMs`, and `error.idempotencyKey`. `authorize` and `charge` still return these failures as `{ error }`.
