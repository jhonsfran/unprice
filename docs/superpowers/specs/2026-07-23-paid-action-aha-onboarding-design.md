# Paid-Action Aha Onboarding Design

## Goal

Replace setup-oriented onboarding with a short activation flow that proves Unprice's core value:
the same paid action is allowed while budget remains and denied before cost when the budget is
exhausted.

The Aha moment is:

> Unprice stopped the second paid action before it created cost, and showed why.

This design supersedes the completion-speed and frontend-only constraints in
`2026-07-12-onboarding-rail-redesign-design.md`. The current money-path rail remains useful product
language, but backend changes are now in scope because the paid action and proof must be real.

## User And Success

The primary user is a technical SaaS builder who understands API calls and usage pricing but should
not need to understand Unprice's internal plan, subscription, API-key, or reporting model before
seeing value.

Onboarding succeeds when:

- the user names one paid action and assigns a unit price;
- the action is persisted as a real feature, event, meter, and published Sandbox plan version;
- two identical real requests produce an allowed and denied decision;
- the denied decision explicitly shows that no additional cost was created;
- the user reaches the comparison receipt within two minutes of authentication;
- analytics visibility is not required to complete onboarding.

## Considered Approaches

### 1. Extend the canonical template and evidence use cases — recommended

Add a typed paid-action override to the existing plan-template use case and make the onboarding
evidence use case return two real run decisions. The current tRPC adapter remains thin, retries stay
idempotent, and the configured action is normal product data the user can inspect afterward.

Trade-off: this requires focused service-contract and test changes in addition to the React flow.

### 2. Compose generic mutations in the browser

Have React create the project, feature, event, plan, plan version, subscription, and requests using
existing generic procedures.

Trade-off: fewer service changes, but business orchestration and recovery move into the UI. Partial
failure becomes difficult to resume safely, and the same workflow could be duplicated by another
entry point.

### 3. Render a simulated decision comparison

Keep the current backend and display a scripted allow/deny example.

Trade-off: smallest implementation, but it undermines the exact trust onboarding must establish.
This option is rejected.

## Product Flow

The route stays `/{workspaceSlug}/onboarding`. The workspace already exists; project and Sandbox
infrastructure are prepared after the user submits the paid action.

```text
Define paid action -> Prepare Sandbox + run proof -> Allowed receipt -> Reveal denied receipt
```

### Moment 1: Define the paid action

Headline:

> What do customers pay to do?

Visible fields:

- Action name, default `AI generation`
- Price per action, default `4.10`

An inline Advanced disclosure contains:

- Feature slug, derived from the name and editable
- Event slug, derived from the name and editable
- Unit, fixed to `action` in V1

The Sandbox budget is not another form decision. Copy explains:

> We'll give the test customer enough budget for one action.

The primary action is `Create and test paid action`. A quiet `Skip for now` link keeps onboarding
optional and does not mark it complete.

Validation is Zod-backed. Names and slugs must be non-empty, slugs use the established event and
feature rules, and price must be a positive decimal with no more than two fractional digits. V1
creates the hidden Sandbox project in USD so currency does not become another onboarding decision.

### Moment 2: Prepare and run the proof

The UI keeps technical orchestration quiet. It reports only three meaningful states:

1. Preparing Sandbox
2. Running the paid action
3. Testing the guardrail

Internally the existing sequence remains resumable:

- create the Sandbox project and update active-project cookies;
- enable the Sandbox payment provider;
- apply a paid-action-aware plan template and publish its primary plan version;
- create/reuse the test customer, API key, and capped subscription;
- start one budgeted run whose budget equals one action's unit price;
- consume the paid action twice with distinct deterministic idempotency keys;
- close the run.

The first consume must be accepted. The second must return `insufficient_budget` with no increase in
`consumedAmountMinor`. An unexpected second acceptance is a proof failure, not a successful
onboarding result.

Errors state the failed user operation and offer `Retry`. Persisted flow data lets retry resume from
the first incomplete phase without creating parallel resources.

### Moment 3: Decision receipt

Initially show the allowed result:

```text
Allowed · budget check passed
AI generation                    $4.10
Budget before                    $4.10
Run spend                        $4.10
Budget remaining                 $0.00
```

The primary action is:

> Show the over-budget request

The proof mutation has already executed both real requests. This label deliberately says "Show,"
not "Run," so the interface does not misrepresent when the server work happened.

After selection, reveal the denied result:

```text
Denied · insufficient budget
Budget remaining                 $0.00
Additional run spend             $0.00
Paid action                      Not authorized
```

Graduation copy:

> Unprice stopped the action before it created cost.

Completion happens only after the denied receipt is visible. Next actions:

- `Connect my application` — primary
- `Adjust pricing`
- `Explore the project`

No confetti, analytics chart, synthetic metric count, or eight-step setup checklist appears in the
graduation moment.

## Service Contracts

### Paid-action template input

Extend the canonical plan-template request with an optional Zod-owned paid-action object:

```ts
{
  title: string
  featureSlug: string
  eventSlug: string
  unitOfMeasure: "action"
  unitPrice: string
}
```

When provided, the primary onboarding plan uses this feature and event instead of the hard-coded
Workflow Runs usage feature. Template identity includes the normalized action slug so retrying the
same action reuses the same compatible plan version while a different action cannot silently reuse
an incompatible published version.

The standard template path without `paidAction` remains backward compatible.

### Proof output

Replace the onboarding receipt's aggregate `usage` and single `verification` emphasis with a typed
proof:

```ts
{
  action: {
    title: string
    featureSlug: string
    eventSlug: string
    unitPriceMinor: number
    currency: "USD"
  }
  decisions: [
    {
      sequence: 1
      accepted: true
      reason: "accepted" | "duplicate"
      consumedAmountMinor: number
      remainingAmountMinor: number
    },
    {
      sequence: 2
      accepted: false
      reason: "insufficient_budget"
      consumedAmountMinor: number
      remainingAmountMinor: number
    },
  ]
}
```

The use case verifies the invariant that the second decision did not increase consumed amount. Raw
API tokens remain server-only and are never returned to the browser.

## Frontend Structure

Keep `@onboardjs/react` for persisted step state and completion behavior, but simplify its public
moments:

```text
apps/nextjs/src/components/onboarding/
  paid-action-schema.ts
  decision-receipt.tsx
  onboarding-shell.tsx
  onboarding-wrapper.tsx
  steps/paid-action-step.tsx
  steps/proof-step.tsx
  steps/receipt-step.tsx
```

The existing `ProjectForm`, eight-station `MoneyPathRail`, and setup-heavy welcome moment leave the
primary onboarding path. Existing project creation and service mutations are reused behind the
proof step rather than copied.

The visual register remains the current restrained product system: one lifted panel, familiar form
controls, semantic success/danger states, and state-only motion. The allowed-to-denied reveal uses
the existing 150–250 ms transition vocabulary and has a reduced-motion fallback.

## Persistence And Recovery

OnboardJS flow data stores only reload-safe identifiers and receipt facts:

- paid-action input;
- project ID and slug;
- primary plan-version ID;
- API-key ID, never token;
- customer and subscription IDs;
- action configuration;
- both decision receipts;
- completed build phases;
- whether the denied result has been revealed.

Development must not clear onboarding persistence automatically. Retry and reload should not
recreate settled resources or rerun accepted consumption with a new idempotency identity. Both
consume calls use stable keys derived from the onboarding proof identity. If the browser loses the
first response, replaying those keys returns the Durable Object's cached decisions; the UI never
reconstructs or fabricates the decision reason from aggregate metrics.

## Analytics

Analytics is instrumentation, not onboarding evidence. Track:

- `onboarding_paid_action_submitted`
- `onboarding_proof_completed`
- `onboarding_aha_revealed`
- `onboarding_connect_app_selected`
- `onboarding_skipped`

Do not include email addresses, tokens, raw request payloads, or customer identifiers in these
events.

## Error Handling

- Invalid action input stays inline on the form.
- Project/template/setup failures show the failed user operation and `Retry`.
- A first-request denial is a proof failure with the returned reason.
- A second-request acceptance is a proof failure because the guardrail was not demonstrated.
- A second rejection for any reason other than `insufficient_budget` is shown honestly and does not
  complete onboarding.
- A reporting delay or failure does not affect the receipt because the proof uses synchronous run
  responses.

## Testing

Service/use-case tests prove:

- paid-action input creates the expected feature, event, meter, and unit price;
- retry reuses the compatible action template;
- a different action does not reuse an incompatible published version;
- first consume is accepted;
- second consume is rejected for insufficient budget;
- the rejected request does not increase consumed amount;
- tokens never appear in the output;
- partial setup retries resume safely.

Frontend tests prove:

- paid-action defaults and validation;
- only the action form is interactive before submission;
- allowed receipt appears before denied receipt;
- completion is unavailable until denial is revealed;
- reload reconstructs both receipt states;
- skip does not mark onboarding complete.

Manual verification covers desktop and mobile, light and dark themes, keyboard-only operation,
reduced motion, retry after each build phase, reload before and after the Aha reveal, and the final
handoff to the project.

## Non-goals

- Supporting tiered, sum, latest, or arbitrary-property meters in onboarding V1.
- Configuring Stripe or collecting a card.
- Waiting for Tinybird dashboards.
- Redesigning the wider project dashboard.
- Changing the production OAuth flow.
