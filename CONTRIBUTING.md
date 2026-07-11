# Contributing to Unprice

Unprice is the open-source customer money path for usage-based SaaS: authorize customer spend in
the request path, explain it on the invoice, and own the money logic in open source.

The project is open to focused contributions around the runtime money path. Bug reports, failing
test cases, docs fixes, and integration feedback are as valuable as code because they improve the
request-to-invoice path teams depend on.

## Ways To Contribute

- **Report a bug** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). A
  minimal reproduction (plan version + SDK call + expected vs actual decision) is gold.
- **Propose a feature** — use the
  [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Describe the paid action
  or money-path problem first, the API second.
- **Improve the docs** — the docs site lives in `apps/docs` (Mintlify). Unclear quickstarts are
  bugs; treat them like bugs.
- **Fix or build** — see the workflow below.

For billing-engine changes (subscriptions, invoicing, wallets, ledger), open an issue to discuss
before writing code. This is money-path logic; correctness and evidence trails outrank speed.

## Repo Layout

| Path | What it is |
| --- | --- |
| `apps/api` | The runtime API — Hono on Cloudflare Workers (entitlements, metering, runs, ingestion) |
| `apps/nextjs` | Dashboard and marketing site (Next.js App Router) |
| `apps/docs` | Documentation site (Mintlify) |
| `packages/api`, `packages/react` | Published client SDKs (`@unprice/api`, `@unprice/react`) — MIT |
| `internal/*` | Core engine: `db`, `services` (billing), `stripe`, `analytics`, `jobs`, `money`, `trpc`, … |
| `tooling/*` | Shared configs and dev tools |

Two documents are canonical for engineering conventions — read them before non-trivial changes:

- [`AGENTS.md`](AGENTS.md) — architecture boundaries, Zod contracts, error handling, testing rules.
  you one.

## Development Setup

Prerequisites: **Node 24.x** (see `.nvmrc`; `engineStrict` is on) and **pnpm 10** (the repo blocks
other package managers via `only-allow`). Docker is required for the local stack.

```bash
pnpm install                 # install workspace dependencies
bin/startup.dev              # apply database migrations (never run migrations manually) + start services
```

Environment templates live next to the app that needs them (for example
`apps/api/.dev.vars.example`). Copy them without the `.example` suffix and fill in values. Some
services (Tinybird analytics, Trigger.dev jobs, Stripe) are external; most contributions do not
need them — the test suites use local fakes and the Sandbox payment provider.

## Making Changes

1. Fork and branch from `main`.
2. Keep the change scoped. Fix problems at the owning layer (service/use case, not route or
   component); avoid opportunistic rewrites and formatting churn.
3. Zod schemas own boundary contracts; derive types with `z.infer`. Never use `any`.
4. Add or update tests at the service/use-case layer for business behavior; route tests cover
   adapter contracts. Billing changes should come with golden-case or property tests when they
   touch calculation paths — see `internal/services` for examples.
5. Verify locally, smallest useful scope first:

   ```bash
   pnpm --filter @unprice/services test    # targeted tests
   pnpm --filter api test
   pnpm validate                           # typecheck + workspace lint + format (runs on commit too)
   pnpm test                               # full suite
   ```

6. Commit with conventional commits — `pnpm commit` walks you through it. Husky + lint-staged run
   `pnpm validate` on commit.
7. If your change affects a published package (`packages/api`, `packages/react`), add a changeset:
   `pnpm changeset`. SDK surface is generated from the OpenAPI contract — from `packages/api`, run
   `pnpm generate` then `pnpm build` rather than hand-writing path types.
8. Open a pull request. Explain the money-path behavior that changes, not just the code. Link the
   issue. CI must be green.

## Code Style

Formatting and linting are Biome (`pnpm fmt` to check). Do not run `pnpm fmt:fix` across files you
did not change. Match the surrounding code's naming, error mapping (`Result`/`Ok`/`Err` for
expected failures), and logging patterns (`no console.log`; use the existing logger).

## Licensing Of Contributions

Unprice's core is dual-licensed: [AGPL-3.0](LICENSE) plus a Commercial License. The client SDKs
(`@unprice/api`, `@unprice/react`) are MIT.

By submitting a contribution you agree that:

1. You wrote the contribution or otherwise have the right to submit it (Developer Certificate of
   Origin — sign off your commits with `git commit -s`).
2. Your contribution is licensed under the license of the files it modifies (AGPL-3.0 for the
   core, MIT for the SDK packages), and you grant the project maintainers the right to also
   distribute it under the project's Commercial License.

This grant is what keeps the open-core model viable — the same code stays free under AGPL-3.0.

## Questions

Open a GitHub issue or discussion. For security reports, do not open a public issue — contact the
maintainers privately first.
