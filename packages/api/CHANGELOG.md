# @unprice/api

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
