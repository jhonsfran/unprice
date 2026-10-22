# @unprice/budgets

## 0.2.0

### Minor Changes

- aa123d4: Budgets for AI SDKs. `@unprice/ai-sdk-budget` adds `budgeted(createProvider, { unprice })`, which wraps every language model of a Vercel AI SDK provider in a budget, takes the budget key per call from `providerOptions.unprice.budget`, creates the budget on first use from `defaults`, and ends loops cleanly with `budgetSpent()`. Prices and limits come from the new `GET /v1/budgets/models` catalog, cached by `unprice.model(id)`; the price table and model-limit options are gone. Every protocol now reserves the byte bound of the request instead of the context window, and OpenAI no longer counts input on every step. `@unprice/budgets` adds `ifMissing` on handles, `created` on authorize, charge, and lease answers, and `budget.wrap({ amount }, fn)` for priced tools keyed by the AI SDK `toolCallId`. `@unprice/pi-budget` keeps `withUnpriceBudget` and prices from Pi's own model definitions.

## 0.1.0

### Minor Changes

- 88a1077: Add `@unprice/budgets`, the budget client on its own: hard caps on any key you choose, without the rest of the API. Its `Unprice` client has the same `unprice.budgets.*` operations, `unprice.budget(key)` handles (remote, or `{ mode: "local" }` from a lease in memory) and `unprice.close()` as `@unprice/api`, so code moves between the two by changing the import. `@unprice/api` now depends on `@unprice/budgets` and re-exports its handles, errors and types; `unprice.budget()` and `unprice.close()` behave as before, and `BudgetExceededError` and the other budget errors are the same classes from either package.

### Patch Changes

- 72a8741: `spend` now throws `BudgetUnavailableError` when the authorization fails with 429 `TOO_MANY_REQUESTS` or 500 `INTERNAL_SERVER_ERROR`, not `BudgetRequestError`. Either answer may follow a committed authorization, so recover it the same way as a network failure: retry with the same estimate, `ttlMs`, and `error.idempotencyKey`. `authorize` and `charge` still return these failures as `{ error }`.
