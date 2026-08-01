# Configure a project's monetization

Two operations own configuration: `monetization.get` reads how a project makes money, and
`monetization.apply` writes it. Both speak the same document, so what `get` returns is what `apply`
accepts.

Configuration is not a runtime path. For `access.check`, `usage.consume`, `usage.record`, and
budgeted runs, read [operation-selection.md](operation-selection.md) instead.

## The agent never publishes

`monetization.apply` only ever creates or reuses **draft** plan versions. A plan version is either
`draft` or `published`, and nothing in the API moves it between them. Publishing is a human action
in the dashboard.

`apply` returns `reviewUrl`, a dashboard link to the first draft it created. Handing that link to
the user is where the agent's work ends. This is a hard stop, not a confirmation prompt to answer on
the user's behalf: do not poll for publication, do not look for a publish method, do not proceed to
integrate against a version that is still a draft.

`reviewUrl` is `null` when every plan came back `unchanged` or `published`. Nothing needs review, so
there is nothing to hand over.

## Workflow

1. **Read the current configuration first.**

   ```ts
   const { result, error } = await unprice.monetization.get()
   ```

   Never write a document without reading one. `apply` takes the whole statement of how the project
   makes money — a plan left out of the document is a plan whose configuration the agent is no
   longer describing.

2. **Handle `unrepresentablePlans` and `warnings` before composing anything.** See the two sections
   below. Both can stop the workflow.

3. **Explain the proposed commercial model to the user, in prose, before writing anything.** Name
   each plan, its price and cadence, which features it includes, and every allowance. Say which plan
   is the default. Say what changes against what `get` returned. Get agreement on the money before
   composing the call, not after.

4. **Compose the document and apply it.**

   ```ts
   const { result, error } = await unprice.monetization.apply({ config })
   ```

5. **Stop, and hand the user `result.reviewUrl`.** Report the per-plan outcomes and any
   `staleDrafts`. Do not continue into integration code in the same breath — the runtime work needs
   a published version, and there isn't one yet.

## Read `unrepresentablePlans` as a stop sign

`unrepresentablePlans` lists plans the project has that the document would **misstate** if it
emitted them — for example a version anchored to a specific day of the month, which the document's
billing cadence cannot express. They are excluded from `config`, never hidden.

When this array is non-empty:

- tell the user, by slug and reason;
- **do not re-add the plan to the document.** Re-adding it from defaults looks like restoring a
  missing plan and is actually a silent rewrite of a live billing setting;
- if the user wants that plan changed, that change belongs in the dashboard.

Applying a document that omits an unrepresentable plan is safe. `apply` touches only the plans the
document names.

## Key warning severity on `code`, never on the message

`warnings` lists stored settings the emitted document is merely **silent** about. Those settings
revert to server defaults if the document is applied back. The plan is still emitted, because hiding
it would be worse.

Severity is a property of the field, carried by `code`. Branch on the code. Do not string-match the
message; message text is not a contract.

| Code | Meaning | Action |
| --- | --- | --- |
| `enforcement_settings_dropped` | Commercial change | Stop. Get explicit human approval |
| `version_settings_dropped` | Commercial change | Stop. Get explicit human approval |
| `feature_settings_dropped` | Cosmetic or inert today | Report and continue |
| `meter_fields_dropped` | Cosmetic or inert today | Report and continue |

**This table is the contract for which codes block.** The blocking subset has no SDK representation
— it is not a named schema in the OpenAPI document, and the server-side constant
`MONETIZATION_BLOCKING_WARNING_CODES` ships from a package that is never published. Do not go
looking for an import; take the two blocking values from the table above.

The four code *values* do reach the installed types, so a typo fails to compile instead of silently
missing a warning. The union is inline, so the reference is the whole path rather than a named
component:

```ts
type WarningCode =
  operations["monetization.get"]["responses"][200]["content"]["application/json"]["warnings"][number]["code"]
// "enforcement_settings_dropped" | "version_settings_dropped"
//   | "feature_settings_dropped" | "meter_fields_dropped"
```

Warnings fire almost exclusively for versions authored in the dashboard. A version `apply` created
never warns.

## There is no configuration file

The agent composes a typed object and passes it to `monetization.apply`. There is no YAML, no JSON
config, no schema file to keep in sync, and no drift check to add to CI. The installed `@unprice/api`
types are the contract — the same precedence rules as the rest of this skill.

Keeping the call as a script in the host project is fine and often useful as a record of what was
sent. Nothing reads it back. Re-running it is safe, and deleting it changes nothing.

## Idempotency and drafts

`apply` is content-addressed. Each plan's desired version is hashed, and the same document sent
twice reuses the version it made the first time.

Per-plan outcomes:

| `status` | Meaning |
| --- | --- |
| `created` | This apply wrote a new draft, or finished one an interrupted apply left half-written |
| `unchanged` | A complete draft already matched |
| `published` | A live version already matches. Nothing was written |

Retrying after a timeout, a crash, or a partial failure means sending the identical request body.
There is no state for the agent to carry and no cleanup to perform.

`staleDrafts` lists drafts made by an earlier, now-superseded document. They are reported, never
deleted. Surface them to the user; removing them is a dashboard action.

A version authored in the dashboard carries no content address, so a document read with `get` and
applied back will mint a draft for those plans. That is expected, not a bug — the read never writes.

## Composing the document

Do not guess field shapes. Inspect the installed `@unprice/api` types.

Rules that are easy to get wrong:

- **Unlimited has exactly one spelling: omit `limit`.** `limit: 0` and `limit: null` are rejected at
  the boundary. A zero allowance is unstorable, and a second spelling of unlimited would hash
  differently and break idempotency.
- **To make a feature unavailable on a plan, leave it out of that plan** — not `limit: 0`.
- **Exactly one plan sets `defaultPlan: true`.** `customers.signUp` without a `planSlug` selects
  that plan, so a project needs one.
- **Every feature a plan prices must be declared in the document's `features`**, and every event a
  meter references must be declared in `events`.
- Prices cross the boundary as decimal strings, for example `"0.000002"`.

## After a human publishes

`apply` returns `integrationContract`: what the application actually has to call at runtime for the
configuration to work — the required event properties per event, and how each feature is integrated
(`flat-access`, `usage-gate`, `usage-evidence`, or `run-budget`).

Use it to pick the runtime path, then follow
[operation-selection.md](operation-selection.md) and
[integration-patterns.md](integration-patterns.md). Its `warnings` flag features whose usage is not
knowable before the work runs, which rules out a guessed `usage.consume` quantity.

Do not write runtime integration code against a draft version. Wait for the user to confirm they
published.
