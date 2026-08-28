---
name: integrate-unprice-sdk
description: Integrate and troubleshoot the @unprice/api TypeScript SDK in server-side Node.js, Next.js, Hono, or edge applications. Use when onboarding Unprice customers, checking access, enforcing or recording usage, reserving budgets for multi-step workloads, handling Unprice API results, reviewing an existing Unprice integration, adding customer-spend authorization before paid work runs, or writing a project's plan, feature, price, and limit configuration into Unprice.
license: MIT
---

# Integrate the Unprice SDK

Build the smallest correct Unprice integration at the boundary that owns the paid action. Preserve
the host project's architecture and use the installed SDK types as the exact contract.

Route the request first. Defining or changing the project's plans, prices, features, or limits is
configuration: read [configuration-workflow.md](references/configuration-workflow.md) and stop at
`reviewUrl`. Checking access, enforcing, or recording usage at runtime: read
[operation-selection.md](references/operation-selection.md) and follow the workflow below.

## Workflow

1. Inspect the project before editing.
   - Identify the package manager, framework, server boundary, environment validation, customer
     identity model, logging style, and test conventions.
   - Search for existing `@unprice/api`, `Unprice`, `UNPRICE_TOKEN`, customer ID mappings, feature
     slugs, event slugs, and idempotency helpers.
   - Reuse an existing Unprice client or integration owner instead of creating a parallel path.

2. Identify the commercial decision.
   - Read [operation-selection.md](references/operation-selection.md).
   - Choose one primary runtime path before writing code.
   - Do not infer product configuration from UI labels or plan names.
   - Keep only stable capability and event identifiers in the host. Unprice owns plan names,
     membership, prices, limits, the default signup plan, and feature-to-plan rules.
   - For included metered usage plus overage, or a customer-specific spend cap,
     read [configuration-workflow.md](references/configuration-workflow.md).

3. Confirm prerequisites.
   - Require a published plan version and the actual plan, feature, event, and meter property slugs.
   - Determine whether the application already stores an Unprice `customerId`.
   - Use `customers.signUp` when Unprice must provision or map the customer money path.
   - Ask for missing business identifiers instead of inventing them.

4. Install or reuse the SDK.
   - Use the project's existing package manager.
   - Add `@unprice/api` only when it is absent.
   - Create one server-only `Unprice` client using the project's environment conventions.

5. Implement the integration.
   - Read [integration-patterns.md](references/integration-patterns.md) for the selected path.
   - Keep the API token out of browser bundles, client components, public environment variables,
     logs, fixtures, and committed files.
   - Handle SDK/API errors separately from valid commercial denials.
   - Preserve one stable idempotency key for the same logical mutation across retries.
   - Make fail-open versus fail-closed behavior an explicit host-application policy.

6. Verify before finishing.
   - Read [verification.md](references/verification.md).
   - Add focused tests for success, API error, commercial denial, and retry behavior.
   - Run the smallest relevant formatter, typecheck, and test commands from the host project.
   - Do not make a live Unprice call unless the user requests it and provides an appropriate
     non-production environment.

## Non-negotiable rules

- Keep Unprice API keys server-side.
- Check stable feature slugs; never branch product behavior on plan display names.
- Use `access.entitlements.current` for a customer-wide capability or billing UI snapshot. Use
  `access.check` when one paid action needs one current decision.
- Treat `access.check` as a read-only decision.
- Never use `usage.record` as a spend gate.
- Do not begin paid work after a denied `usage.consume` or rejected run reservation.
- A run reservation authorizes a finite currency envelope; it does not constrain a downstream
  provider by itself. Before starting variable-cost work, derive a conservative worst-case cost
  for the request, reserve that amount, and pass the matching cap to the provider (for example,
  `maxTokens`). If the known input plus the minimum useful output cannot fit, deny before the
  provider call. Never use post-response `runs.consume` as the only spend gate.
- A nonzero `runs.start` reserves wallet funds. An active subscription alone is
  insufficient: provision a wallet grant, credit line, or top-up large enough
  for the expected simultaneous reservations.
- Close short-lived runs in `finally`. For a deliberately long-lived conversation,
  set `expiresAt`, reuse its stable idempotency key throughout that window, and
  explicitly close it on cancellation or failure.
- End a run as `failed` after exceptions or rejected consumption; do not report it as `completed`.
- Reuse the same idempotency key when retrying the same logical mutation.
- Do not replace a repository's existing billing or authorization owner with route-level
  orchestration when a service or use-case layer owns that behavior.
- Do not guess exact request or response fields. Inspect the installed `@unprice/api` types or the
  official OpenAPI contract.

## Contract precedence

When sources disagree, use this order:

1. Installed `@unprice/api` TypeScript types.
2. Current official OpenAPI document at `https://docs.unprice.dev/openapi.json`.
3. Bundled references in this skill for stable behavioral guidance.
4. Individual documentation examples.

If a bundled example no longer typechecks, adapt it to the installed contract and report the drift
instead of weakening type safety.
