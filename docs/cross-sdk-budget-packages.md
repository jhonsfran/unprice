# Cross-SDK budget packages

- [x] Ground the existing budget client, Pi regression fixes, workspace release rules, and AI SDK V4 contract.
- [x] Compare shared-core and subpath designs. Use a neutral AI package and separate SDK adapters.
- [x] Add `@unprice/budgets-ai`, `@unprice/pi-budget`, and `@unprice/ai-sdk-budget` to Unprice.
- [x] Keep one owner for the neutral request boundary; keep SDK conversion in adapters.
- [x] Build and test the packages, then run the requested thermo-nuclear review and fix accepted findings.
- [x] Pack and install the real Unprice package archives into the Pi project. Remove the local duplicate implementation.
- [x] Run Pi's full suite, package import checks, and production dry run. Leave all changes uncommitted.

The existing budget SDK remains the canonical reservation engine. Shared AI code owns final request validation, counting, output bounds, pricing, and operation deadlines. Initial protocol support stays explicit: OpenAI Responses text and local functions. Adding an AI SDK integration does not imply support for unbounded provider features.

The API contract is `createBudgetSession(options)`, returning one physical dispatch transport, idempotent settlement, and read-only authorization/error state. Each SDK creates a session per model invocation. Pi converts its reported USD cost. AI SDK converts its usage with application-supplied pricing. AI SDK correlates native middleware and its paired fetch with per-call opaque headers and strips them before network I/O.

Independent work: root owns neutral code, Pi migration, metadata, packaging, and consumer verification; one worker owns AI SDK adapter and tests; an independent reviewer audits the completed change. No shared file writers.

## Review result

The independent thermo-nuclear review approved the implementation after fixes. Stream reads now follow consumer demand, terminal provider errors wait for settlement, explicit cancellation propagates settlement errors, and nonstream settlement failures preserve the native result through BudgetSettleError.value. Pricing tier thresholds are required and validated before paid dispatch. No structural or correctness blockers remain in scope.

The Pi consumer installed built archives and passed 167 tests, including all existing budget request and deadline regressions. Shared code and native adapters use mocked provider and Unprice HTTP responses in their tests; no paid API calls or deployments were needed.

## Final verification

- `pnpm validate` passed across the Unprice workspace, including 29 typecheck/build tasks, package manifest checks, and formatting/lint.
- All five public package suites passed: 156 tests total, including 51 tests in the new integrations.
- The Pi project passed 167 tests, `pnpm check`, and the external archive consumer check after installing the Unprice archives.
- Independent archive consumers verified AI SDK ESM/CommonJS exports and public types. Pi uses ESM imports or dynamic import from CommonJS because Pi AI does not provide CommonJS entry points.
- Existing Unprice dependency resolutions were preserved; the frozen filtered install succeeds. No commits, package publication, paid model calls, or deployments were performed.

## Anthropic and Gemini follow-up

- [x] Separate and verify the Pi anonymous identity baseline. Commit only that baseline as requested.
- [x] Read provider and native SDK contracts. Use shared protocol policies and trusted model input limits for estimated count APIs.
- [x] Keep provider validation in the neutral package and SDK event conversion in each adapter. Add native Pi and AI SDK tests for both providers.
- [x] Run strict maintainability review, fix findings, build archives, and retest the Pi consumer.

The throughput checkpoint is the shared protocol boundary. Anthropic and Gemini policies were developed independently, then integrated into both adapters. Gemini needs an explicit Pi REST transport because Pi 1.3 rejects a custom fetch. The bridge reuses public Pi codecs and does not mutate global fetch. Package changes remain uncommitted.

### Follow-up verification

- The auth-only Pi baseline is commit `bd114ea`. All budget and provider changes remain uncommitted.
- Independent thermo-nuclear review approved after fixes for preliminary usage, synthetic SDK finish events, and completed Anthropic refusals. Raw completion evidence now lives in the shared package.
- All 382 public package tests pass. Unprice `pnpm validate` and the publishable-package guard pass. Existing workspace dependency resolutions were preserved and frozen installs pass.
- Pi consumed rebuilt archives and passed 169 tests, `pnpm check`, and the external archive consumer check with native Anthropic and Gemini dispatch. Tests used mocked provider and Unprice responses. No paid calls, package publication, or deployment occurred.
- The final AI SDK archive passed separate ESM, CommonJS, public TypeScript, and required model-limit configuration checks. Both repository indexes are empty.
