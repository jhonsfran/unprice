---
"@unprice/api": minor
---

Add budgets. `unprice.budgets.*` exposes the seven budget operations (`upsert`, `authorize`, `settle`, `release`, `charge`, `record`, `get`). `unprice.budget(key)` returns a handle whose `authorize` and `charge` return `{ allowed: false, blocked }` on a 402 and a `degraded` denial when Unprice cannot be reached. Its `spend({ estimate }, fn)` authorizes, runs `fn`, and settles the returned actual. `spend` throws `BudgetExceededError` when a limit denies the estimate, `BudgetUnavailableError` when Unprice cannot be reached, `BudgetRequestError` on other API errors, `BudgetRecoveryError` (with the hold) when `fn` throws or your own idempotency key replays, and `BudgetSettleError` (with the value and actual) when the settle fails. A hold still open at its `expiresAt` is settled at its full amount. Amounts accept numbers or decimal strings and always come back as decimal strings; instants are epoch milliseconds.
