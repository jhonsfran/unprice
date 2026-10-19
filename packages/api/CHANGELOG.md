# @unprice/api

## 0.5.0

### Minor Changes

- 88a1077: Add `@unprice/budgets`, the budget client on its own: hard caps on any key you choose, without the rest of the API. Its `Unprice` client has the same `unprice.budgets.*` operations, `unprice.budget(key)` handles (remote, or `{ mode: "local" }` from a lease in memory) and `unprice.close()` as `@unprice/api`, so code moves between the two by changing the import. `@unprice/api` now depends on `@unprice/budgets` and re-exports its handles, errors and types; `unprice.budget()` and `unprice.close()` behave as before, and `BudgetExceededError` and the other budget errors are the same classes from either package.
- 36065fd: Add local mode for budgets. In a long-lived process, `unprice.budget(key, { mode: "local", lease: { amount } })` returns a handle whose `authorize`, `settle`, `release`, `charge`, and `spend` answer in memory against a lease the API debits up front, with the same results as the remote handle; `record` and `get` stay remote. The handle reports consumption every `flushIntervalMs` (1 s), tops the lease back up below `lowWater`, and returns it after `idleMs` (10 s) with no spending and no open hold. A client holds one lease per key however many handles it takes, and `unprice.close()` returns every open lease, resolving with the keys it could not return; a lease never closed expires after `ttlMs` (60 s) and counts in full. `ttlMs` must exceed three flush intervals, and after a refused lease the key answers with that denial from memory for one flush interval. The client also accepts `waitUntil` and `onSettleError`: with `waitUntil`, `spend` returns as soon as the work finishes and settles in the background, and a settle that fails goes to `onSettleError` while its hold expires at its full estimate. `unprice.budgets.lease` and `unprice.budgets.report` are the operations local mode uses.

### Patch Changes

- Updated dependencies [88a1077]
- Updated dependencies [72a8741]
  - @unprice/budgets@0.1.0

## 0.4.0

### Minor Changes

- c79c7e8: Add budgets. `unprice.budgets.*` exposes the seven budget operations (`upsert`, `authorize`, `settle`, `release`, `charge`, `record`, `get`). `unprice.budget(key)` returns a handle whose `authorize` and `charge` return `{ allowed: false, blocked }` on a 402 and a `degraded` denial when Unprice cannot be reached. Its `spend({ estimate }, fn)` authorizes, runs `fn`, and settles the returned actual. `spend` throws `BudgetExceededError` when a limit denies the estimate, `BudgetUnavailableError` when Unprice cannot be reached, `BudgetRequestError` on other API errors, `BudgetRecoveryError` (with the hold) when `fn` throws or your own idempotency key replays, and `BudgetSettleError` (with the value and actual) when the settle fails. A hold still open at its `expiresAt` is settled at its full amount. Amounts accept numbers or decimal strings and always come back as decimal strings; instants are epoch milliseconds.

## 0.3.1

### Patch Changes

- 11be10a: Use `no-store` as the default fetch cache mode so SDK requests work in Cloudflare Workers.

## 0.3.0

### Minor Changes

- 5b27a7e: adding current entitlement endpoint

## 0.2.0

### Minor Changes

- 9927200: Add the `monetization` namespace, and correct the type contract for operations the SDK had been
  describing inaccurately.

  ### New: `monetization.apply` and `monetization.get`

  `monetization.apply` turns one configuration document into draft plan versions for the project the
  key belongs to. `monetization.get` reads the current configuration back in the shape `apply`
  accepts, alongside `unrepresentablePlans` and `warnings` for what the document cannot carry. Both
  require a **config** API key; a runtime key is rejected.

  Nothing is published. `apply` writes drafts only, and a human reviews and publishes them from the
  dashboard — `result.reviewUrl` links to the first draft a call created. There is no publish method
  in this SDK, by design.

  ### Corrected: the SDK's description of existing operations

  The checked-in OpenAPI document these types are generated from had gone stale, so the published SDK
  has been describing several endpoints incorrectly. **The server did not change; the types were
  wrong and are now right.** Regenerating against the live API corrects them.

  The one that can break a compile:
  - **`customers.signUp`** accepts **`creditLineAmountMinor`** (integer, currency minor units). The
    SDK previously typed this field as **`creditLineAmount`**, which the API does not accept — code
    written against the old type was already failing at runtime, so this corrects a type that was
    lying rather than removing working functionality. For corroboration, this repo's own end-to-end
    tool (`tooling/tiny-tools/plan-signup.ts`) has been sending `creditLineAmountMinor` all along,
    against SDK types that said otherwise. Its `metadata` also accepts `usageLimitReached`.

  The rest are additive — fields the API already returns that the SDK did not admit existed:
  - **Every operation** can return **`413 PAYLOAD_TOO_LARGE`**. This status is now part of the
    `ErrorResponse` and `ApiError` unions; previously a 413 body matched no member of either, so it
    could not be narrowed. The union is now derived from the generated components instead of being
    hand-listed, which is what let it fall behind.
  - **Every error response** carries an optional **`details`** object (`{ kind, issues? }`), used by
    the monetization operations to report which part of a submitted document was rejected. It is
    optional everywhere and only `kind` is required when present.
  - **`planVersions.get`**, **`planVersions.list`**, and **`subscriptions.get`** return **`configHash`**
    and **`metadata.includedCreditAmount`** on a plan version.
  - **`ingestionEvents.status`** returns **`facets`**, plus **`ingestionMode`**, **`runId`**,
    **`traceId`**, **`parentRunId`**, **`workloadType`**, and **`workloadId`** on each recent event.
  - **`ingestionEvents.replay`** documents `replayed` and `skipped` as non-negative.
  - **`runs.start`**, **`runs.consume`**, **`runs.end`**, and **`runs.get`** document
    `budgetAmountMinor`, `consumedAmountMinor`, and `remainingAmountMinor` as currency minor units.
    Types are unchanged.

  Released as a minor: for a `0.x` package this is where a correction of this size belongs, and
  bringing the types in line with what the API has always accepted is not the same as breaking a
  contract that worked.

- 7557276: Add the `reservations` SDK facade for one expensive operation. Applications can reserve a maximum
  cost before provider work starts, settle actual feature usage, or release a known non-billable
  reservation. Settlement uses the first-class `runs.settle` endpoint so incurred usage bypasses the
  feature and run-budget limits, reports whether the full cost was funded, and records full usage.
  The declared maximum remains a hard capture ceiling when actual provider usage costs more.
  The one-operation facade then closes the underlying run.

### Patch Changes

- 1470785: License the public API SDK under MIT and include its package-local license file so published
  tarballs do not inherit the root AGPL license text.

## Legacy history (`@jhonsfran/unprice`)

### 0.4.1

#### Patch Changes

- building again

### 0.4.0

#### Minor Changes

- changing headers

### 0.3.0

#### Minor Changes

- fix: add authorization header
- c790eb7: republishing
