---
"@unprice/budgets": minor
"@unprice/api": minor
---

Add `@unprice/budgets`, the budget client on its own: hard caps on any key you choose, without the rest of the API. Its `Unprice` client has the same `unprice.budgets.*` operations, `unprice.budget(key)` handles (remote, or `{ mode: "local" }` from a lease in memory) and `unprice.close()` as `@unprice/api`, so code moves between the two by changing the import. `@unprice/api` now depends on `@unprice/budgets` and re-exports its handles, errors and types; `unprice.budget()` and `unprice.close()` behave as before, and `BudgetExceededError` and the other budget errors are the same classes from either package.
