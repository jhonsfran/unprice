# Security Findings — action list

Audit date: 2026-07-03. Each item: **problem** → **fix**, with exact `file:line`. Fix top-down; add a regression test where noted.

Common root cause across most HIGH items: a query keyed on a **client-supplied id without a `projectId`/tenant predicate** (or without validating a client `customerId` against the caller's own). Most of the codebase does this correctly — these are the deviations.

---

## CRITICAL

### ✅ DONE C1. Signup overwrites any existing user's password (account takeover)
- **Status:** Fixed 2026-07-03. Credentials signup now uses an insert-only path with `onConflictDoNothing` and a non-enumerating error. OAuth/provider signup uses a separate helper that can update profile metadata but never writes `password`. Regression coverage added in `internal/auth/src/utils.test.ts`.
- **Note:** Email-verification enforcement was not added in this pass because the credentials flow currently has no verification email path; enforcing it here would break the existing signup/login flow.
- **Where:** `internal/auth/src/utils.ts:54-62` (`createUser` upsert), from `apps/nextjs/src/actions/signupCredentials.ts:19-25`.
- **Problem:** `.onConflictDoUpdate({ target: [users.email], set: { password, ... } })`. Public unauthenticated signup with a victim's email overwrites their password hash → login as victim. Also sets a password on OAuth-only accounts.
- **Fix:** Split OAuth-adapter upsert from credentials signup. On credentials signup, reject if email exists (`onConflictDoNothing` + non-enumerating error); never overwrite `password`/`emailVerified` on conflict. Require email verification before use.

---

## HIGH

### ✅ DONE H1. Unscoped `getCustomer` — cross-tenant IDOR (one root cause, several symptoms)
- **Status:** Fixed 2026-07-03. `customers.getById` now requires project context and uses `getCustomerByIdInProject`; payment-method list/create routes authenticate once, enforce customer-bound API keys, and scope customer reads to the API key project. The old service footgun was renamed to `getCustomerByIdAcrossProjects` and only remains for the API auth self-reflection fallback. Regression coverage added in `apps/api/src/routes/payments/methods/paymentMethodsV1.test.ts`.
- **Root cause:** `internal/services/src/customers/service.ts:237-247` (`getCustomerData`) and `:285-300` (`getCustomer`) query `where eq(customer.id, customerId)` with **no project filter** (cache key is also `customerId`-only). Scoped twin exists: `getCustomerByIdInProject`.
- **Fix (do once):** Scope `getCustomer`/`getCustomerData` by project (+ fix cache key), OR enforce `customerData.projectId === key.projectId` at each call site. Closes all symptoms:
  - `internal/trpc/src/router/lambda/customers/getById.ts:8,14` — any logged-in user reads any customer's PII. Route callers to `getByIdActiveProject`, or make it `protectedProjectProcedure` + `getCustomerByIdInProject`.
  - `apps/api/src/routes/payments/methods/listPaymentMethodsV1.ts:73-107` — any valid API key reads another tenant's card metadata (`keyAuth` result discarded; `TODO` at line 81).
  - `apps/api/src/routes/payments/methods/createPaymentMethodV1.ts:64-110` — any valid API key creates a Stripe checkout/setup session against another tenant's customer.

### ✅ DONE H2. `subscriptions.getById` reads any subscription across tenants
- **Status:** Fixed 2026-07-03. `subscriptions.getById` now uses `protectedProjectProcedure`, accepts optional `projectSlug`, and passes `ctx.project.id` into `SubscriptionService.getSubscriptionById`; the service now requires `projectId` and forwards it to `findSubscriptionFull`.
- **Where:** `internal/trpc/src/router/lambda/subscriptions/getById.ts:13,20` → `internal/services/src/subscriptions/service.ts:1716-1723` → `internal/services/src/subscriptions/repository.drizzle.ts:133-141` (projectId filter applied only if passed; service never passes it).
- **Fix:** Make it `protectedProjectProcedure`; pass `projectId: ctx.project.id` into `getSubscriptionById`/`findSubscriptionFull` (as `findSubscriptionForMachine` already does).

### ✅ DONE H3. `apikeys.roll` rerolls any project's API key and returns the plaintext
- **Status:** Fixed 2026-07-03. The tRPC route now passes `ctx.project.id`; `rollApiKey` requires `projectId`, scopes the hash lookup by project, and scopes the update by `id + projectId`. Regression coverage added in `internal/services/src/apikey/service.test.ts`.
- **Where:** `internal/trpc/src/router/lambda/apikeys/roll.ts:6,17,22` → `internal/services/src/apikey/service.ts:481-540` (`getData` lookup `:255-292` filters `hash` only; UPDATE `:508-511` filters `id` only). `ctx.project` is unused.
- **Problem:** Client-supplied `hashKey` → `rollApiKey({ keyHash })` mints and returns a fresh valid key with no project scope. Hashes are exposed to the owning project's frontend via `apikeys.listByActiveProject`, so they leak. Sibling `revokeApiKeys`/`bindCustomer` scope correctly by `projectId` — `roll` is the outlier.
- **Fix:** Pass `projectId: ctx.project.id` and scope both `getData` lookup and UPDATE with `and(eq(apikeys.hash, keyHash), eq(apikeys.projectId, projectId))`.

### ✅ DONE H4. `subscriptions.createPhase` writes a phase into another tenant's subscription
- **Status:** Fixed 2026-07-03. `SubscriptionService.createPhase` now passes `projectId` into `findSubscriptionWithPhases`, matching the scoped patterns used by phase update/cancel/remove paths. Regression assertion added in `internal/services/src/subscriptions/service.test.ts`.
- **Where:** `internal/trpc/src/router/lambda/subscriptions/createPhase.ts:16` → `internal/services/src/subscriptions/service.ts:835-837` calls `findSubscriptionWithPhases({ subscriptionId })` **without `projectId`** (repo makes it conditional, `repository.drizzle.ts:104-109`). Only validates `planVersionId` ownership, not `subscriptionId`. `subscriptionId` is client input.
- **Fix:** Pass `projectId` into the `findSubscriptionWithPhases` call at `service.ts:835`, matching `updatePhase` (`:1278-1282`) and `cancel`/`removePhase` (`:1461-1464`).

### ✅ DONE H5. tRPC edge customer endpoints use the root SDK token without validating `customerId`
- **Status:** Fixed 2026-07-03. Workspace/root-SDK payment-method and usage procedures now reject caller-supplied `customerId` values that do not match `ctx.workspace.unPriceCustomerId`. Project customer payment-method flows were split into new `customers.listPaymentMethodsByActiveProject` and `customers.createPaymentMethodByActiveProject` lambda procedures that use internal services with `ctx.project.id`, preserving subscription form behavior without privileged root-token access.
- **Where:** `internal/trpc/src/router/edge/customers/listPaymentMethods.ts:22-28`, `internal/trpc/src/router/edge/customers/createPaymentMethod.ts:13-20`, `internal/trpc/src/router/lambda/analytics/getUsage.ts:20,30-33`. SDK uses the privileged root key (`internal/trpc/src/utils/unprice.ts:4`), which reads across tenants (all workspace billing customers live in the main project).
- **Problem:** A raw client `customerId` is forwarded to the root-token SDK without checking it equals `ctx.workspace.unPriceCustomerId` → read another workspace's payment methods / usage, or open a setup session (with attacker-controlled redirect URLs) against another workspace's billing customer.
- **Fix:** Ignore input `customerId`; always use `ctx.workspace.unPriceCustomerId` (or reject unless equal).

### ✅ DONE H6. Customer-bound API keys not enforced on read endpoints (intra-project cross-customer IDOR)
- **Status:** Fixed 2026-07-03. Added `resolveCustomerIdForApiKeyOrThrow` and routed customer-targeted read endpoints through it. Endpoints with optional customer filters keep project-wide reads for unbound keys, but customer-bound keys are narrowed to the bound customer. Invoice/explain-charge reads enforce the binding against the loaded invoice customer before returning data.
- **Problem:** `defaultCustomerId` binding is enforced on writes via `resolveCustomerIdForApiKey` (`apps/api/src/auth/key.ts:278-306`) but on none of the reads — a key bound to `cus_A` can read `cus_B` in the same project.
- **Fix:** Route every client `customerId` through `resolveCustomerIdForApiKey({ explicitCustomerId, defaultCustomerId: key.defaultCustomerId })` in: `apps/api/src/routes/entitlements/verifyV1.ts:153`, `routes/wallet/getWalletV1.ts:222`, `routes/entitlements/getEntitlementsV1.ts:73`, `routes/entitlements/getEntitlementWindowStatusV1.ts:59`, `routes/subscriptions/getSubscriptionV1.ts:72`, `routes/invoices/getInvoiceV1.ts:112`, `routes/analytics/getUsageV1.ts:115`, `routes/analytics/forecastUsageV1.ts`, `routes/analytics/explainChargeV1.ts`, `routes/analytics/getIngestionStatusV1.ts`.

### ✅ DONE H7. `/v1/access/update` is an unauthenticated no-op (fail-open control)
- **Status:** Fixed 2026-07-03. The endpoint now authenticates API keys, enforces customer-bound keys, resolves the customer in the authorized project (or across projects only for main/root keys), and calls `CustomerService.updateAccessControlList`. Regression coverage added in `apps/api/src/routes/access/updateACLV1.test.ts`.
- **Where:** `apps/api/src/routes/access/updateACLV1.ts:63-80`. Body incl. `keyAuth` commented out; returns `200 {}`. Registered public + in SDK.
- **Fix:** Deregister, OR implement with `keyAuth` + authorization. Anything relying on it to disable a customer / flag usage-limit today silently succeeds without enforcing.

---

## MEDIUM

### ✅ DONE M1. ADMIN can grant/revoke OWNER; no last-OWNER protection
- **Status:** Fixed 2026-07-03. Workspace OWNER assignment now goes through a shared service-layer role policy used by member role changes, invite role changes, and new invites; membership mutations use a per-workspace advisory lock and block removing/demoting the sole remaining OWNER. Regression coverage added in `internal/services/src/workspaces/service.test.ts`.
- **Where:** `internal/trpc/src/router/lambda/workspaces/changeRoleMember.ts:8` → `internal/services/src/workspaces/service.ts:337-379`. Gate `["OWNER","ADMIN"]` accepts an arbitrary target role.
- **Fix:** Only OWNER may assign/remove OWNER; block demoting the sole remaining OWNER (lockout).

### ✅ DONE M2. Mass-assignment on workspace creation (`isInternal`, arbitrary `id`)
- **Status:** Fixed 2026-07-03. `workspaces.signUp` now stamps a server-generated workspace id into the checkout return URL and `workspaces.create` accepts only that `workspaceId`; the server resolves the paid billing customer by `externalId`, verifies it belongs to the active user's email, and creates the workspace with the server-issued id. Client-supplied `id`, `unPriceCustomerId`, `isInternal`, `isMain`, `enabled`, and other DB columns are not accepted.
- **Where:** `internal/trpc/src/router/lambda/workspaces/create.ts:54-58` (spreads `...opts.input`) → `internal/services/src/workspaces/service.ts:109,134,139`; schema `internal/db/src/validators/workspace.ts:17` exposes every column.
- **Problem:** `isInternal` and `id` come from client input. `isInternal` makes API keys **skip rate limiting** (`apps/api/src/auth/key.ts:128`; projects inherit it, `internal/services/src/projects/service.ts:413`).
- **Fix:** Accept only `{ name, unPriceCustomerId }` at the router boundary; set `id`/`isInternal`/`isMain`/`enabled`/`plan` server-side.

### ✅ DONE M3. `projects.transferToWorkspace` doesn't verify membership of the target workspace
- **Status:** Fixed 2026-07-03. The tRPC route now runs `workspaceGuard` for `targetWorkspaceId` and requires OWNER/ADMIN membership in the target workspace before invoking the transfer use case.
- **Where:** `internal/trpc/src/router/lambda/projects/transferToWorkspace.ts:28` → `internal/services/src/use-cases/project/transfer-to-workspace.ts:53-74` (only checks target exists).
- **Problem:** A project OWNER can relocate their project (+ customers/subscriptions/usage) into any workspace they don't belong to, shifting usage costs onto the victim.
- **Fix:** Run `workspaceGuard({ workspaceId: targetWorkspaceId, ctx })` and require OWNER/ADMIN in the target before transferring.

### ✅ DONE M4. Open redirect in dashboard middleware
- **Status:** Fixed 2026-07-03. Dashboard middleware now accepts `next` only when it is a same-origin relative path, rejecting protocol-relative, backslash-normalized, malformed, or missing values before constructing the redirect URL.
- **Where:** `apps/nextjs/src/middleware/app.ts:52,74-77`. `next` param passed unvalidated to `NextResponse.redirect(new URL(next, req.url))`.
- **Fix:** Allow only same-origin/relative paths.

### ✅ DONE M5. No rate limiting in the tRPC layer (email bombing / cost amplification)
- **Status:** Fixed 2026-07-03. Added an opt-in Upstash Redis fixed-window limiter for tRPC procedures, with fail-open logging when Redis is not configured. Applied route-specific limits to workspace invite/resend/signup, payment-method session creation, wallet top-up, and domain verification procedures. Regression coverage added in `internal/trpc/src/rate-limit.test.ts`.
- **Where:** none of `internal/trpc/src` is rate-limited. `workspaces.inviteMember` (`inviteMember.ts:91-101`) + `resendInvite` send email to attacker-chosen addresses; `workspaces.signUp`, edge `customers.createPaymentMethod`, `wallets.initiateTopup` create provider sessions; `domains.verify` hits Vercel.
- **Fix:** Add a `rateLimitedProcedure` (Upstash-backed) keyed by user/workspace/IP for mutations and email/provider-hitting procedures.

### ✅ DONE M6. TOCTOU race in RunBudget Durable Object (budget overrun / double-count)
- **Status:** Fixed 2026-07-03. `RunBudgetDO.applySyncEvent` now serializes the idempotency/read/pricing/commit flow per run object with `blockConcurrencyWhile`, so a second event cannot price against stale remaining budget while the first event is in flight. Regression coverage added in `apps/api/src/ingestion/run-budget/RunBudgetDO.test.ts` for concurrent applies.
- **Where:** `apps/api/src/ingestion/run-budget/RunBudgetDO.ts:124-207`. Reads `consumedAmount`, computes `remaining`, does external RPC (`:162`), commits (`:192`). Input gate open during the `await` → concurrent events read stale `consumed`, both pass, both commit. Duplicate `idempotencyKey` also double-counts (`onConflictDoNothing` dedupes only the idempotency row, not the spend).
- **Fix:** Wrap read-decide-commit in `blockConcurrencyWhile`, or re-check idempotency + recompute `remaining` inside the final transaction and abort on snapshot change.

### ✅ DONE M7. Supply chain: secret-handling action pinned to mutable `@main`
- **Status:** Fixed 2026-07-03. Pinned `cloudposse/github-action-secret-outputs`, `Infisical/secrets-action`, `cardinalby/export-env-action`, `amondnet/vercel-action`, and `tj-actions/branch-names` to commit SHAs in the deploy workflows and adjacent workflows using the same secret-handling actions. Added top-level `permissions: contents: read` to the touched workflows.
- **Where:** `cloudposse/github-action-secret-outputs@main` in `.github/workflows/deploy-preview.yml`, `deploy-production.yml`, `job_deploy_api.yaml` (handles GPG passphrase + Neon `DATABASE_URL`).
- **Fix:** Pin to a commit SHA. SHA-pin other secret-handling actions too (`Infisical/secrets-action`, `cardinalby/export-env-action`, `amondnet/vercel-action`, `tj-actions/branch-names`); add `permissions: contents: read` at workflow top level.

### ✅ DONE M8. Vulnerable runtime dependencies
- **Status:** Fixed 2026-07-03. Bumped API Hono to `^4.12.25` (lockfile `4.12.27`), Nodemailer to `^9.0.1` (lockfile `9.0.3`, including transitive peer resolutions), and forced `fast-xml-parser` to `^5.3.5` (lockfile `5.9.3`) through pnpm workspace overrides. Moved pnpm overrides/package extensions into `pnpm-workspace.yaml` so pnpm 10 applies them. Added a CI audit gate via `pnpm audit:high`; it is baseline-based because a raw high/critical audit currently fails on unrelated pre-existing advisories outside this finding.
- **Fix:** Bump `hono ^4.7.4 → ≥4.12.25` (CORS advisory GHSA-88fw-hqm2-52qc, `apps/api/package.json:52`), `nodemailer → ≥9.0.1`, critical transitive `fast-xml-parser → ≥5.3.5` (via `@aws-sdk`, use `pnpm.overrides`). Add `pnpm audit` as a CI gate.

### ✅ DONE M9. Wildcard CORS
- **Status:** Fixed 2026-07-03. Replaced wildcard CORS with a shared origin allowlist for first-party Unprice/site domains, Vercel PR preview aliases, and localhost development origins. API Hono middleware and Next.js API helpers now reflect only allowed origins with explicit methods/headers and `Vary: Origin`. Regression coverage added in `apps/api/src/cors.test.ts`.
- **Where:** `apps/api/src/index.ts:68` (`app.use("*", cors())`) and `apps/nextjs/src/app/api/_enableCors.ts` (`Access-Control-Allow-Origin: *`).
- **Fix:** Restrict `origin` to first-party domains + preview aliases; explicit `allowHeaders`/`allowMethods`; never combine `*` with allow-credentials.

### ✅ DONE M10. Encrypted payment-provider secrets sent to the browser
- **Status:** Fixed 2026-07-03. Added a `publicPaymentProviderConfigSchema` that omits encrypted provider key material (`key`, `keyIv`, `webhookSecret`, `webhookSecretIv`) from browser-facing config output. Switched all payment-provider tRPC procedure outputs to the public schema and narrowed the dashboard payment settings component prop to `PublicPaymentProviderConfig`, preserving internal service access to encrypted values for provider operations. Regression coverage added in `internal/db/src/validators/paymentConfig.test.ts`.
- **Where:** `internal/db/src/validators/paymentConfig.ts` select schema returns `key`/`keyIv`/`webhookSecret`/`webhookSecretIv`; used by `internal/trpc/src/router/lambda/paymentProvider/getConfig.ts:42` + siblings.
- **Fix:** `.omit({ key, keyIv, webhookSecret, webhookSecretIv })` on the output schema (or select only non-secret columns).

---

## LOW (queue; low risk individually)
- ✅ DONE **Internal error messages returned on 5xx** — Fixed 2026-07-03. API and tRPC 5xx responses now return the generic message `Internal server error` with the existing `requestId`; expected 4xx messages remain specific. tRPC also suppresses `cause` for 5xx responses. Regression coverage added in `apps/api/src/errors/http.test.ts` and `internal/trpc/src/error-format.test.ts`.
- ✅ DONE **`analytics.getPlanClickBySessionId` not project-scoped** — Fixed 2026-07-03. `v1_get_session_event` now requires `project_id`, the analytics client type requires it, and customer signup passes its owning `projectId`. The dashboard new-workspace preselection flow is scoped to the canonical `unprice-admin` main project used by `planVersions.listByProjectUnprice` instead of `protectedProjectProcedure`, because that flow intentionally runs before the user has an active project. Verified with analytics/services/tRPC/Next.js typechecks; `tb build` was attempted but Tinybird Local could not run because no Docker-compatible runtime was available.
- ✅ DONE **No body-size cap on sync ingestion** — Fixed 2026-07-03. Added a shared raw-ingestion guard for `/v1/usage/record` and `/v1/usage/consume`: 128 KiB raw body cap before validation, including requests without `Content-Length`, plus parsed `properties` caps for serialized size (64 KiB), total keys (128), and nesting depth (5) before auth/queue/service work. Added `PAYLOAD_TOO_LARGE`/413 API mapping and regression coverage in async and sync ingestion route tests.
- ✅ DONE **`/v1/access/check` bypasses per-key rate limiting** (`apps/api/src/auth/key.ts:10`) and the limiter fails open (`key.ts:147-168`) — Confirmed intentional 2026-07-03. This endpoint is the latency-sensitive entitlement check hot path; adding the Cloudflare rate limiter would add latency and could deny customer feature access during limiter incidents. The route remains authenticated, read-only, customer-bound-key scoped, and project-scoped. Existing coverage in `apps/api/src/auth/key.test.ts` asserts the bypass is limited to `/v1/access/check` and not the old entitlement path; limiter infrastructure failures continue to fail open with structured logging.
- ✅ DONE **API-key secret entropy ~62 bits** — Fixed 2026-07-03. Added `newApiKeySecret()` with 16 bytes/128 bits of CSPRNG material encoded as the existing 22-character base58 `unprice_live_` shape, then switched API-key create and roll flows to use it instead of timestamp/counter IDs. Regression coverage added in `internal/db/src/utils/id.test.ts` and `internal/services/src/apikey/service.test.ts`.
- ✅ DONE **`AUTH_SECRET`** allows `min(1)` (`internal/auth/src/env.ts:19`) and is reused to HMAC realtime tickets (`apps/api/src/index.ts:110`). Fixed 2026-07-03. Auth and auth-proxy now require 32-character minimum `AUTH_SECRET` values. API runtime env now requires a distinct 32-character `REALTIME_TICKET_SECRET` outside development and the websocket ticket verifier uses that resolved secret; development may temporarily fall back to `AUTH_SECRET` to preserve local `.dev.vars` flows. Regression coverage added in `apps/api/src/env.test.ts`.
- ✅ DONE **`allowDangerousEmailAccountLinking: true`** on both OAuth providers (`internal/auth/src/config.ts:85,90`) + no rate limiting on credentials login/signup. Fixed 2026-07-03. Removed unsafe automatic email-based OAuth account linking so Auth.js requires an explicit/link-safe flow instead of trusting matching emails, and added Upstash-backed fixed-window throttling before credentials login/signup server actions. Login is limited by IP and IP+email over 10 minutes; signup is limited by IP and IP+email over 1 hour. The limiter follows the existing app behavior of failing open with structured logging if Redis is not configured.
- ✅ DONE **Secure cookies only in production** (`config.ts:15,26`) — enable for preview. **`trustHost` unconditionally true** (`config.ts:18`) — gate explicitly. **`authorize` returns full user row incl. password hash** (`config.ts:111-117`) — return only `{id,email,name,image}`. **User-enumeration timing** on login — run a decoy `verifyPassword` when the user is absent. Fixed 2026-07-03. Preview and production now use secure auth cookies, host trust is explicit to local development or deployed environments, credentials auth returns only the safe Auth.js user fields, and missing/OAuth-only users run the same PBKDF2 verifier path against a static decoy hash before failing.
- ✅ DONE **docker-compose** default `postgres`/`postgres` creds bound to `0.0.0.0` — bind to `127.0.0.1`, mark dev-only. Fixed 2026-07-03. The compose file is now explicitly development-only and all exposed local services, including Postgres, bind to loopback instead of all interfaces so the existing local credentials remain local-only.

## Confirmed OK — do not "fix" / regress
Stripe webhook signature verification (raw-body `constructEventAsync`, per-project secret, fails closed) + idempotency (advisory lock + `webhookEvents` dedup + ledger idempotency keys); no client-supplied prices; integer money math (dinero.js); Durable Object IDs derived server-side from authenticated tenant; realtime WebSocket ticket (HMAC + `iss`/`aud`/`exp` + room binding); PBKDF2 password hashing w/ constant-time compare; API keys stored as SHA-256 hash only; the `protectedProjectProcedure`/`protectedWorkspaceProcedure` guards and the many routers that correctly filter `and(eq(id), eq(projectId))`; CI uses `pull_request` (not `pull_request_target`); no committed secrets.
