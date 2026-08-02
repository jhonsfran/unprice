# Agent-Native Monetization Configuration Design

Date: 2026-08-01

Status: approved in conversation. Supersedes the declarative-manifest version of this document,
recoverable with `git show 36548ad43:docs/superpowers/specs/2026-08-01-agent-native-monetization-configuration-design.md`.

## Goal

Let a coding agent configure a project's monetization through the public SDK, then integrate the
application's runtime money path — without a dashboard round trip for the modelling work, and
without the agent ever publishing money-affecting configuration on its own.

> Describe how your app makes money; Unprice turns it into reviewable draft pricing.

## Design in one paragraph

Two public operations. `monetization.get` returns the project's current configuration.
`monetization.apply` takes the whole desired configuration as one JSON object and creates or reuses
**draft** plan versions, content-addressed so re-sending the same object is a no-op. Publishing
stays where it already is: the dashboard. `apply` returns a deep link to the draft so a human
reviews the real UI and clicks publish. There is no configuration file, no revision protocol, no
deployment journal, no drift engine, and no client-held state between calls.

## Why not a declarative manifest

The v1 design proposed `unprice.yaml` as the authoritative desired state, reconciled by a
revision-aware server engine. It was rejected for three reasons.

**The domain cannot reconcile.** A desired-state engine earns its complexity by converging in both
directions. Unprice never deletes events, features, or plans, and never edits a published plan
version. An engine that can only create is `get-or-create` with a diff report bolted on, but it
still pays the full price: hashes, base revisions, a deployment state machine, drift detection,
adoption semantics, and a `delete candidate` classification that resolves to a warning.

**Preview duplicates the draft.** Terraform needs plan/apply because apply is destructive and
immediate. Applying here creates unpublished drafts that no customer can see. The draft *is* the
dry run, and the dashboard already renders it properly through `plan-version-form.tsx`,
`feature-config-form.tsx`, and `version-context-strip.tsx`. A server-side preview would be a second
implementation of "what would change" that must stay consistent with the first one forever.

**The approval gate was theatre.** v1 conceded that a CLI confirmation string "is not presented as
cryptographic proof of human intent." Correct — so it should not be built. `planVersions.publish`
already enforces `verifyRole(["OWNER","ADMIN"])` and already surfaces `payment_provider_error`,
`no_features`, and `price_calculation_error` in a UI that shows the consequences.

### Industry precedent

Three standards exist, selected by whether resources can be deleted.

| Standard | Example | Requires |
| --- | --- | --- |
| Desired-state reconciliation | LaunchDarkly Terraform provider | mutable + deletable resources; a state file; and telling customers not to edit in the UI |
| Replace-and-archive reconciliation | Stripe Terraform provider (`create_before_destroy` on immutable Prices) | archive-as-delete, plus a logical-name-to-ID state mapping |
| Ordered idempotent recipe | Stripe CLI fixtures | nothing; it is a sequence of API calls, not a reconciler |

Stripe ships both the second and the third for the same objects, because "my catalog in a
reviewable file" and "converge my account" are different problems. v1 took the machinery of the
first, over a domain shaped like the second with archive explicitly out of scope, to get the
ergonomics of the third.

For agent-facing writes the 2026 convention is a narrow write surface with explicit human
confirmation in the vendor's own surface — Stripe's MCP server puts a `human_confirmation` object
on money-moving tools. Nobody ships "agent writes the file, agent applies it, agent publishes it."

If customers later demand real config-as-code with CI and drift, the answer is a Terraform
provider over a clean API, not a proprietary manifest format. That path stays open; this design
does not close it.

## API Surface

### `monetization.get`

Returns the project's current configuration in the same shape `apply` accepts, plus each plan's
current published and draft version IDs. Read-only. Lets an agent inspect before it writes and diff
locally if it wants to.

### `monetization.apply`

Input: the whole configuration object. No hash, no revision, no idempotency key, no deployment ID.

Behaviour:

1. Validate the document and resolve every cross-reference.
2. `get-or-create` events by slug, then features by slug. Incompatible existing slug is a conflict.
3. `get-or-create` plans by slug; set exactly one `defaultPlan`.
4. For each plan, compute `configHash` over the canonical desired version — currency, billing
   config, payment provider, and the slug-sorted feature list with prices.
5. If a version with that `configHash` already exists on the plan, reuse it. If that version is a
   published one, report `published`. If it is a complete draft, report `unchanged`. If it is an
   incomplete draft, resume materializing it.
6. Otherwise create a new draft version and materialize its features and prices.
7. Never touch a published version.

Output:

```jsonc
{
  "plans": [
    { "slug": "pro", "planVersionId": "pv_...", "status": "created" },   // created | unchanged | published
  ],
  "staleDrafts": ["pv_..."],           // drafts from a previous, now-superseded apply
  "integrationContract": { /* see below */ },
  "reviewUrl": "https://app.unprice.dev/<workspaceSlug>/<projectSlug>/plans/pro/pv_..."
}
```

### Publishing

Not exposed. The human opens `reviewUrl` and publishes from the dashboard.

This deletes, in one decision: a public publish endpoint, a publish capability scope, publish
idempotency keys, partial-publish resume, cross-plan publication locking, provider-precondition
error handling in the agent path, and the honesty problem about what a confirmation flag proves.

## Idempotency without a protocol

`configHash` on the plan version is the whole mechanism. The agent holds no state; a retry is
literally the same request body.

Crash recovery needs no journal because **the draft row is the progress record**. A half-materialized
draft carries the right hash and an incomplete feature set; the next apply finds it and finishes it.
`applyPlanTemplate` already does exactly this with tags and `isTemplatePlanVersionComplete` — the
hash replaces the tag heuristic and makes the lookup exact instead of approximate.

Superseded drafts are reported in `staleDrafts` and left alone. `planVersions/remove.ts` already
deletes drafts from the dashboard.

Storage: one nullable `configHash text` column on plan versions, with a partial index on
`(projectId, planId, configHash) where config_hash is not null`.

## Configuration Document

The request body reuses the existing insert validators rather than defining a second pricing model.
Three substitutions at the boundary, all of which already have code:

| Internal | At the boundary | Resolution |
| --- | --- | --- |
| `meterConfig.eventId` | `eventSlug` | server resolves after events are created |
| `planId` / `featureId` | `planSlug` / `featureSlug` | server resolves |
| `config.price` as a Dinero snapshot | decimal string | `toDineroPrice()` in `materialize.ts` |

Arrays with an explicit `slug` field, not slug-keyed maps — the validators already use arrays, and
arrays hash deterministically after sorting without a canonicalization layer.

```ts
await unprice.monetization.apply({
  events: [
    { slug: "chat_request", name: "Chat request" },
    { slug: "ai_completion", name: "AI completion" },
  ],
  features: [
    { slug: "chat-messages", title: "Chat messages", unitOfMeasure: "message" },
    { slug: "reasoning-model", title: "Reasoning model", unitOfMeasure: "access" },
  ],
  plans: [
    {
      slug: "free",
      title: "Free",
      defaultPlan: true,
      version: {
        currency: "USD",
        billingConfig: { name: "monthly", interval: "month", intervalCount: 1 },
        paymentProvider: "stripe",
        features: [
          {
            featureSlug: "chat-messages",
            featureType: "usage",
            config: { usageMode: "unit", price: "0.00" },
            meterConfig: { eventSlug: "chat_request", aggregationMethod: "count" },
            limit: 20,
            resetConfig: { interval: "day" },
          },
        ],
      },
    },
  ],
})
```

No configuration file. The agent composes a typed object; the installed SDK types validate it at
compile time, which is rule 1 of the skill's existing contract-precedence list. If a project wants a
re-runnable artifact it can keep the call in a script — nothing reads it back, so re-running it is
safe and deleting it changes nothing.

This deletes the restricted YAML parser, the YAML safety profile, the generated JSON Schema, the
committed `.mjs` bundle, and the CI gate that proved the bundle matched its source.

## Integration Contract

`apply` returns the piece that makes this agent-native rather than merely an API: per paid action,
which runtime call to add and why.

- event slugs and their required numeric properties;
- feature slugs, classified as flat access, synchronous usage gate, asynchronous evidence, or run
  budget input;
- the default plan, and the note that omitting `planSlug` in `customers.signUp` selects it;
- warnings where actual usage is unknown before the work runs, so the correct call is
  `usage.record` or a budgeted run rather than a guessed `usage.consume`.

The server does not generate host code. The skill turns the contract into code that fits the host
architecture.

## Credentials

One nullable column on `apikeys`: `type: 'config' | 'runtime'`. Existing keys behave as `runtime`.
Config keys reach only the monetization operations; runtime keys cannot reach them. The dashboard
key-creation form gains one choice.

Not a capability system. `isRoot` already exists on the table and is unreferenced in
`apps/api/src/auth`; a capability grammar designed for an MCP OAuth flow that is an explicit
non-goal is speculative work. If hosted MCP ships, migrate then.

## Agent Workflow

1. Inspect the application for customer identity, paid actions, provider costs, and existing limits.
2. Call `monetization.get` to see what already exists.
3. Explain the proposed commercial model and its trade-offs to the user before writing anything.
4. Call `monetization.apply`.
5. Show the user `reviewUrl` and stop. The user reviews and publishes in the dashboard.
6. Implement the integration contract: `customers.signUp`, access checks, consumption, usage
   evidence, budgeted runs, at the server boundaries that own the paid action.
7. Add focused tests. Report anything still requiring live dashboard or payment-provider work.

Step 5 is a hard stop, not an approval prompt the agent answers itself.

## Error Model

Three domain errors, plus normal transport and auth failures:

| Code | Meaning |
| --- | --- |
| `invalid_config` | schema failure, with JSON paths and remediation |
| `slug_conflict` | an existing event or feature with that slug is incompatible |
| `unresolved_reference` | a feature meters an event absent from both the document and the project |

Every error carries the Unprice request ID. Commercial denials at runtime stay distinct from API
errors, as today.

## Observability

One wide event per configuration operation: operation, project, workspace, API-key ID and type,
config hash per plan, counts of created / unchanged / published / resumed, duration, outcome,
request ID, SDK version. Never log the token or customer PII.

## Deferred, With the Trigger to Revisit

| Deferred | Safe because | Revisit when |
| --- | --- | --- |
| Concurrency control | one writer per project at a handful of lifetime config writes; published versions are immutable | two writers actually collide — then add `If-Match` on a plan version, not a revision system |
| Drift detection and GitOps | cannot converge in an additive domain | customers ask for CI-managed pricing — then ship a Terraform provider |
| Archive / delete | drafts are removable from the dashboard; published versions must persist for active subscriptions | archival is designed with active-subscription impact and rollback semantics |
| MCP server | the same two operations adapt thinly later | a hosted MCP with OAuth is actually being built |
| Recipes / presets | the manifest contract should stabilize first | after real agent usage, as a client-side helper that compiles to the same object |

## Rollout

1. Add the `configHash` column and generalize the `plan-template` internals into an
   `applyMonetizationConfig` use case reusing `materialize.ts`. Service tests only, no route.
2. Add `apikeys.type` and the dashboard key-creation choice. Existing keys unchanged.
3. Add the two routes, OpenAPI contract tests, and the generated SDK methods.
4. **Prove it before releasing.** Configure and integrate the AI chatbot end to end against a
   non-production project using a linked SDK build.
5. Extend `skills/integrate-unprice-sdk` with one `configuration-workflow.md` reference and a router
   line in `SKILL.md`. No script bundle, no schema generation, no drift gate.
6. Publish `@unprice/api` with a changeset.

Step 4 is deliberately before the release. The proof is the only step that produces information
about whether the shape is right, and the document shape you would design after watching an agent
use it is not the one written here.

## Verification

**Apply**

- Applying the same document twice creates nothing the second time.
- Reordering features or plans in the document produces no new versions.
- A price, limit, or reset change produces a new draft and leaves the published version live.
- A crash after partial materialization is finished by the next apply, with no duplicate version.
- An incompatible existing feature slug fails with `slug_conflict` before anything is written.
- A feature metering an unknown event fails with `unresolved_reference`.
- Two plans claiming `defaultPlan` fails validation.
- A published version is never edited.
- `staleDrafts` lists superseded drafts and nothing else.

**Get**

- Round-trips: `get` output fed back into `apply` produces zero changes.
- Resources created in the dashboard appear in `get`.

**Credentials**

- Runtime keys are rejected from monetization operations; config keys are rejected from
  customer-bound runtime contexts.
- Existing keys keep current behaviour and gain nothing.
- Tokens never appear in output, errors, telemetry, or fixtures.

**End-to-end (AI chatbot, non-production project)**

1. The agent configures the model and stops at `reviewUrl`; nothing is published without a human.
2. After publish, `customers.signUp` without `planSlug` selects the default plan and the customer ID
   is persisted.
3. Signup failure in Unprice does not create a local account.
4. Entitlements control model visibility without a deploy.
5. `usage.consume` denies an exhausted allowance before the model cost is incurred.
6. `usage.record` reports actual input and output tokens after completion.
7. Wallet or charge evidence explains the resulting spend.
8. API errors and commercial denials render differently.

No production customer, usage, payment, or publication is created by automated tests.

## Non-Goals

- A configuration file of any format as authoritative state.
- A server-side preview or diff engine.
- A public publish endpoint.
- Client-supplied idempotency keys, revisions, or manifest hashes.
- A deployment record, journal, or state machine.
- Drift detection, adoption semantics, or delete classification.
- A capability grammar for API keys.
- YAML parsing, JSON Schema generation, or bundled scripts in `@unprice/api` or the skill.
- Physically deleting removed resources, or editing published versions.
- Choosing prices for the user without explaining the assumptions.
- Implementing the AI chatbot integration in this plan.

## Decision Summary

- Public surface: `monetization.get` and `monetization.apply`. Two operations, not four.
- Apply creates drafts only, idempotent by server-computed content hash.
- Publishing stays in the dashboard; `apply` returns a deep link.
- No configuration file; the agent composes a typed object against the installed SDK types.
- Request body reuses existing validators with three slug/decimal substitutions.
- One new nullable column on plan versions, one on API keys. No new tables.
- Three domain error codes.
- Proof against the AI chatbot happens before the SDK release, not after it.
