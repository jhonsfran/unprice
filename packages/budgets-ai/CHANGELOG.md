# @unprice/budgets-ai

## 0.2.0

### Minor Changes

- aa123d4: Budgets for AI SDKs. `@unprice/ai-sdk-budget` adds `budgeted(createProvider, { unprice })`, which wraps every language model of a Vercel AI SDK provider in a budget, takes the budget key per call from `providerOptions.unprice.budget`, creates the budget on first use from `defaults`, and ends loops cleanly with `budgetSpent()`. Prices and limits come from the new `GET /v1/budgets/models` catalog, cached by `unprice.model(id)`; the price table and model-limit options are gone. Every protocol now reserves the byte bound of the request instead of the context window, and OpenAI no longer counts input on every step. `@unprice/budgets` adds `ifMissing` on handles, `created` on authorize, charge, and lease answers, and `budget.wrap({ amount }, fn)` for priced tools keyed by the AI SDK `toolCallId`. `@unprice/pi-budget` keeps `withUnpriceBudget` and prices from Pi's own model definitions.

### Patch Changes

- Updated dependencies [aa123d4]
  - @unprice/budgets@0.2.0
