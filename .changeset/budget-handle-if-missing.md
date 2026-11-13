---
"@unprice/api": minor
---

`unprice.budget(key, { ifMissing })` takes a budget definition, as `@unprice/budgets` does: the handle's first authorize, charge, or lease creates the budget when the key has none. It also works with `{ mode: "local", lease, ifMissing }`.
