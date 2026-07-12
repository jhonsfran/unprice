# Onboarding Rail Redesign — "The Path Builds Itself"

## Goal

Rebuild the workspace onboarding (`/[workspaceSlug]/onboarding`) as a money-path rail that renders
its own state: ghost stations become a settled receipt with real IDs while the flow runs. Optimize
for comprehension of the money-path model and brand parity with the landing page; completion speed
is secondary. Frontend-only: reuse the existing tRPC mutations unchanged.

## Flow

Six onboardjs steps compress to four moments on the same engine:

```text
welcome -> project -> build -> receipt
             |          |
        ProjectForm     +- paymentProvider.setEnabled(sandbox)
        (reused as-is)  +- planVersions.applyTemplate (publish: true)
                        +- planVersions.seedEvidence
```

- `welcome`: pitch + one amber CTA ("Build the Sandbox money path") + ghost link "Skip for now →"
  to `/{workspaceSlug}` without setting `onboardingCompleted` (the dashboard "Create project"
  button already routes back here). The skip link is a deliberate small product addition.
- `project`: heading + existing 3-field `ProjectForm`; on success the Project station settles and
  the flow auto-advances.
- `build`: runs the three mutations sequentially with no clicks between phases. Sequencing,
  idempotency, and retry reuse the current context flags (`templatePlansCreated`,
  `seededMetrics`); retry resumes at the failed phase only. Phase→station mapping is honest:
  `setEnabled` drives station 2, `applyTemplate` drives station 3, and `seedEvidence` drives
  stations 4–8 together — those five go live simultaneously (that is what the server is doing)
  and settle with a `data-reveal` stagger when the single real response lands. No fabricated
  per-station sequencing.
- `receipt`: verdict block + fully-settled rail + one amber CTA "Inspect project overview".
  Completion behavior (`setOnboardingCompleted`, redirect to project, `router.refresh`) is
  unchanged from the current final step.

`StepNavigator` is deleted; the rail is the progress display. localStorage key bumps to
`unprice_onboarding_v3`. Funnel events are untouched.

## Layout

Composition mirrors the landing hero: content left, evidence right.

- Page ground (`surface-page`): persistent header — mono uppercase eyebrow `SANDBOX · MONEY PATH`,
  `text-display-3` headline with two-tone emphasis (setup clause `text-background-text`, operative
  clause `text-background-textContrast`), one-line sub. Copy changes per moment; anatomy is fixed.
- One lifted panel below (`rounded-lg border border-background-border bg-surface-panel
  shadow-raised`), capped at `max-w-4xl`: grid with moment content left, rail right inside a
  quiet inset well (`bg-background-bgSubtle`, `border-l border-background-border`). No other
  elevated surface on the page (one lifted panel per view; one solid amber per viewport).
- Mobile: single column, moment content first, rail below.

## The rail

Eight stations in build order, each `StationDot + label + Leader + mono fact`:

| Station | Settled fact |
| --- | --- |
| Project | slug |
| Payment provider | `sandbox · enabled` |
| Plan versions | `3 published` + sub-rows Starter/Pro/Enterprise with `planVersionId`s |
| API key | truncated key id (never the token) |
| Customer | test customer email |
| Subscription | truncated id |
| Budgeted run | `{eventsRecorded}/{targetCount} events` |
| access.check | `allowed` / `denied` |

States use landing vocabulary exactly:

- ghost: dashed dot, muted label, fact "no entry";
- live: `bg-info ring-2 ring-info-bg` dot, gerund fact ("publishing…");
- settled: `bg-success-solid` dot, real mono fact;
- skipped: warning tone;
- failed: danger tone — system failure only;
- denied: danger text on the fact while the dot settles — business outcome, not failure.

Amber never appears on the rail. Blue = live request path, green = settled, per the token docs.

`StationDot`, `Leader`, and `LedgerRow` are promoted from
`apps/nextjs/src/components/landing/station.tsx` to a new `@unprice/ui/station` subpath export;
landing re-imports from there. `SectionShell` and `StationHeader` stay in landing.

## Receipt content

- Verdict chip `access.check · allowed` with line "Allowed: run within budget." (denied branch
  renders honestly with the danger treatment).
- "Your app's first two calls" mono code block: `unprice.customers.signUp(...)` then
  `unprice.access.check(...)` (names confirmed in `packages/api/src/generated/sdk-resources.ts`),
  preloaded with the real `planVersionId` and `featureSlug` from this run. No secrets: show the
  API key id only, never a token.
- If usage was skipped: "No usage-based feature with meter configuration was found. Usage evidence
  will appear after you attach a meter to a plan version."
- Error copy follows the brand pattern: "[Operation] could not [verb]. [Reason]. [Recovery]",
  e.g. "Plan versions could not publish. {reason}. Retry resumes from this station."

## Motion

No fourth animation system. The build is event-driven (mutation latency is unknown), so no
scripted WAAPI timeline:

- station state changes: `transition-colors duration-regular ease-out-quad`;
- inter-station segments fill downward via scaleY at `duration-deliberate ease-out-cubic`;
- ledger/sub-rows enter with the existing `data-reveal` stagger grammar;
- live station reuses the landing beacon ping, extracted from `money-path.tsx` (not duplicated);
- final state renders by default; `prefers-reduced-motion` gets instant jumps;
- legacy `animate-content/button/title` utilities are removed from onboarding usage.

Auto-advance build → receipt after one `duration-deliberate` beat once all stations settle.

## Architecture

```text
apps/nextjs/src/components/onboarding/
  onboarding-shell.tsx     persistent header + panel grid + rail slot
  money-path-rail.tsx      renders RailState; <ol> with aria-current="step"; status is
                           always text + color, never color alone; on moment change focus
                           moves to the moment heading
  rail-state.ts            pure fn: onboardjs flowData -> RailState (unit-tested)
  steps/welcome-step.tsx   rewritten
  steps/project-step.tsx   rewritten wrapper around ProjectForm
  steps/build-step.tsx     new 3-phase sequencer
  steps/receipt-step.tsx   rewrite of final-step
  deleted: payment-provider-step, template-plan-step, seed-metrics-step, step-navigator
```

The build step persists everything the rail and receipt render into onboardjs context
(`appliedTemplates`, `apiKeyId`, usage counts, verification verdict) so a mid-flow reload
reconstructs the rail from `flowData` alone. `rail-state.ts` is the single derivation source.

## Non-goals

- Backend/endpoint changes of any kind.
- Changing funnel analytics events or the signup-funnel work in flight.
- Exposing an API token in onboarding.
- Touching the tenant `sites.css` surface (no token changes required).

## Verification

- Unit tests for `rail-state.ts` (ghost/live/settled/skipped/failed/denied derivations, reload
  reconstruction).
- Typecheck, lint, and React diagnostics pass.
- Playwriter pass against the dev server: all four moments, dark + light, mobile width,
  reduced motion, and the failure/retry path.
