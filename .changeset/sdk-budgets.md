---
"@unprice/api": minor
---

Add budgets. `unprice.budgets.*` exposes the seven budget operations (`upsert`, `authorize`, `settle`, `release`, `charge`, `record`, `get`). `unprice.budget(key)` returns a handle whose `authorize` and `charge` return `{ allowed: false, blocked }` on a 402 and a `degraded` denial when Unprice cannot be reached. Its `spend({ estimate }, fn)` authorizes, runs `fn`, settles the returned actual, and releases the hold when `fn` throws. `spend` throws `BudgetExceededError` on denial, `BudgetRequestError` on other API errors, and `BudgetSettleError` (with the value and actual) when the settle fails. Amounts accept numbers or decimal strings and always come back as decimal strings.
