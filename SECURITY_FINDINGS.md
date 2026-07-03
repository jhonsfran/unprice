# Security Findings — action list

Audit date: 2026-07-03. Each item: **problem** → **fix**, with exact `file:line`. Fix top-down; add a regression test where noted.

Common root cause across most HIGH items: a query keyed on a **client-supplied id without a `projectId`/tenant predicate** (or without validating a client `customerId` against the caller's own). Most of the codebase does this correctly — these are the deviations.

---

## CRITICAL

### C1. Signup overwrites any existing user's password (account takeover)
- **Where:** `internal/auth/src/utils.ts:54-62` (`createUser` upsert), from `apps/nextjs/src/actions/signupCredentials.ts:19-25`.
- **Problem:** `.onConflictDoUpdate({ target: [users.email], set: { password, ... } })`. Public unauthenticated signup with a victim's email overwrites their password hash → login as victim. Also sets a password on OAuth-only accounts.
- **Fix:** Split OAuth-adapter upsert from credentials signup. On credentials signup, reject if email exists (`onConflictDoNothing` + non-enumerating error); never overwrite `password`/`emailVerified` on conflict. Require email verification before use.

---

## HIGH

### H1. Unscoped `getCustomer` — cross-tenant IDOR (one root cause, several symptoms)
- **Root cause:** `internal/services/src/customers/service.ts:237-247` (`getCustomerData`) and `:285-300` (`getCustomer`) query `where eq(customer.id, customerId)` with **no project filter** (cache key is also `customerId`-only). Scoped twin exists: `getCustomerByIdInProject`.
- **Fix (do once):** Scope `getCustomer`/`getCustomerData` by project (+ fix cache key), OR enforce `customerData.projectId === key.projectId` at each call site. Closes all symptoms:
  - `internal/trpc/src/router/lambda/customers/getById.ts:8,14` — any logged-in user reads any customer's PII. Route callers to `getByIdActiveProject`, or make it `protectedProjectProcedure` + `getCustomerByIdInProject`.
  - `apps/api/src/routes/payments/methods/listPaymentMethodsV1.ts:73-107` — any valid API key reads another tenant's card metadata (`keyAuth` result discarded; `TODO` at line 81).
  - `apps/api/src/routes/payments/methods/createPaymentMethodV1.ts:64-110` — any valid API key creates a Stripe checkout/setup session against another tenant's customer.

### H2. `subscriptions.getById` reads any subscription across tenants
- **Where:** `internal/trpc/src/router/lambda/subscriptions/getById.ts:13,20` → `internal/services/src/subscriptions/service.ts:1716-1723` → `internal/services/src/subscriptions/repository.drizzle.ts:133-141` (projectId filter applied only if passed; service never passes it).
- **Fix:** Make it `protectedProjectProcedure`; pass `projectId: ctx.project.id` into `getSubscriptionById`/`findSubscriptionFull` (as `findSubscriptionForMachine` already does).

### H3. `apikeys.roll` rerolls any project's API key and returns the plaintext
- **Where:** `internal/trpc/src/router/lambda/apikeys/roll.ts:6,17,22` → `internal/services/src/apikey/service.ts:481-540` (`getData` lookup `:255-292` filters `hash` only; UPDATE `:508-511` filters `id` only). `ctx.project` is unused.
- **Problem:** Client-supplied `hashKey` → `rollApiKey({ keyHash })` mints and returns a fresh valid key with no project scope. Hashes are exposed to the owning project's frontend via `apikeys.listByActiveProject`, so they leak. Sibling `revokeApiKeys`/`bindCustomer` scope correctly by `projectId` — `roll` is the outlier.
- **Fix:** Pass `projectId: ctx.project.id` and scope both `getData` lookup and UPDATE with `and(eq(apikeys.hash, keyHash), eq(apikeys.projectId, projectId))`.

### H4. `subscriptions.createPhase` writes a phase into another tenant's subscription
- **Where:** `internal/trpc/src/router/lambda/subscriptions/createPhase.ts:16` → `internal/services/src/subscriptions/service.ts:835-837` calls `findSubscriptionWithPhases({ subscriptionId })` **without `projectId`** (repo makes it conditional, `repository.drizzle.ts:104-109`). Only validates `planVersionId` ownership, not `subscriptionId`. `subscriptionId` is client input.
- **Fix:** Pass `projectId` into the `findSubscriptionWithPhases` call at `service.ts:835`, matching `updatePhase` (`:1278-1282`) and `cancel`/`removePhase` (`:1461-1464`).

### H5. tRPC edge customer endpoints use the root SDK token without validating `customerId`
- **Where:** `internal/trpc/src/router/edge/customers/listPaymentMethods.ts:22-28`, `internal/trpc/src/router/edge/customers/createPaymentMethod.ts:13-20`, `internal/trpc/src/router/lambda/analytics/getUsage.ts:20,30-33`. SDK uses the privileged root key (`internal/trpc/src/utils/unprice.ts:4`), which reads across tenants (all workspace billing customers live in the main project).
- **Problem:** A raw client `customerId` is forwarded to the root-token SDK without checking it equals `ctx.workspace.unPriceCustomerId` → read another workspace's payment methods / usage, or open a setup session (with attacker-controlled redirect URLs) against another workspace's billing customer.
- **Fix:** Ignore input `customerId`; always use `ctx.workspace.unPriceCustomerId` (or reject unless equal).

### H6. Customer-bound API keys not enforced on read endpoints (intra-project cross-customer IDOR)
- **Problem:** `defaultCustomerId` binding is enforced on writes via `resolveCustomerIdForApiKey` (`apps/api/src/auth/key.ts:278-306`) but on none of the reads — a key bound to `cus_A` can read `cus_B` in the same project.
- **Fix:** Route every client `customerId` through `resolveCustomerIdForApiKey({ explicitCustomerId, defaultCustomerId: key.defaultCustomerId })` in: `apps/api/src/routes/entitlements/verifyV1.ts:153`, `routes/wallet/getWalletV1.ts:222`, `routes/entitlements/getEntitlementsV1.ts:73`, `routes/entitlements/getEntitlementWindowStatusV1.ts:59`, `routes/subscriptions/getSubscriptionV1.ts:72`, `routes/invoices/getInvoiceV1.ts:112`, `routes/analytics/getUsageV1.ts:115`, `routes/analytics/forecastUsageV1.ts`, `routes/analytics/explainChargeV1.ts`, `routes/analytics/getIngestionStatusV1.ts`.

### H7. `/v1/access/update` is an unauthenticated no-op (fail-open control)
- **Where:** `apps/api/src/routes/access/updateACLV1.ts:63-80`. Body incl. `keyAuth` commented out; returns `200 {}`. Registered public + in SDK.
- **Fix:** Deregister, OR implement with `keyAuth` + authorization. Anything relying on it to disable a customer / flag usage-limit today silently succeeds without enforcing.

---

## MEDIUM

### M1. ADMIN can grant/revoke OWNER; no last-OWNER protection
- **Where:** `internal/trpc/src/router/lambda/workspaces/changeRoleMember.ts:8` → `internal/services/src/workspaces/service.ts:337-379`. Gate `["OWNER","ADMIN"]` accepts an arbitrary target role.
- **Fix:** Only OWNER may assign/remove OWNER; block demoting the sole remaining OWNER (lockout).

### M2. Mass-assignment on workspace creation (`isInternal`, arbitrary `id`)
- **Where:** `internal/trpc/src/router/lambda/workspaces/create.ts:54-58` (spreads `...opts.input`) → `internal/services/src/workspaces/service.ts:109,134,139`; schema `internal/db/src/validators/workspace.ts:17` exposes every column.
- **Problem:** `isInternal` and `id` come from client input. `isInternal` makes API keys **skip rate limiting** (`apps/api/src/auth/key.ts:128`; projects inherit it, `internal/services/src/projects/service.ts:413`).
- **Fix:** Accept only `{ name, unPriceCustomerId }` at the router boundary; set `id`/`isInternal`/`isMain`/`enabled`/`plan` server-side.

### M3. `projects.transferToWorkspace` doesn't verify membership of the target workspace
- **Where:** `internal/trpc/src/router/lambda/projects/transferToWorkspace.ts:28` → `internal/services/src/use-cases/project/transfer-to-workspace.ts:53-74` (only checks target exists).
- **Problem:** A project OWNER can relocate their project (+ customers/subscriptions/usage) into any workspace they don't belong to, shifting usage costs onto the victim.
- **Fix:** Run `workspaceGuard({ workspaceId: targetWorkspaceId, ctx })` and require OWNER/ADMIN in the target before transferring.

### M4. Open redirect in dashboard middleware
- **Where:** `apps/nextjs/src/middleware/app.ts:52,74-77`. `next` param passed unvalidated to `NextResponse.redirect(new URL(next, req.url))`.
- **Fix:** Allow only same-origin/relative paths.

### M5. No rate limiting in the tRPC layer (email bombing / cost amplification)
- **Where:** none of `internal/trpc/src` is rate-limited. `workspaces.inviteMember` (`inviteMember.ts:91-101`) + `resendInvite` send email to attacker-chosen addresses; `workspaces.signUp`, edge `customers.createPaymentMethod`, `wallets.initiateTopup` create provider sessions; `domains.verify` hits Vercel.
- **Fix:** Add a `rateLimitedProcedure` (Upstash-backed) keyed by user/workspace/IP for mutations and email/provider-hitting procedures.

### M6. TOCTOU race in RunBudget Durable Object (budget overrun / double-count)
- **Where:** `apps/api/src/ingestion/run-budget/RunBudgetDO.ts:124-207`. Reads `consumedAmount`, computes `remaining`, does external RPC (`:162`), commits (`:192`). Input gate open during the `await` → concurrent events read stale `consumed`, both pass, both commit. Duplicate `idempotencyKey` also double-counts (`onConflictDoNothing` dedupes only the idempotency row, not the spend).
- **Fix:** Wrap read-decide-commit in `blockConcurrencyWhile`, or re-check idempotency + recompute `remaining` inside the final transaction and abort on snapshot change.

### M7. Supply chain: secret-handling action pinned to mutable `@main`
- **Where:** `cloudposse/github-action-secret-outputs@main` in `.github/workflows/deploy-preview.yml`, `deploy-production.yml`, `job_deploy_api.yaml` (handles GPG passphrase + Neon `DATABASE_URL`).
- **Fix:** Pin to a commit SHA. SHA-pin other secret-handling actions too (`Infisical/secrets-action`, `cardinalby/export-env-action`, `amondnet/vercel-action`, `tj-actions/branch-names`); add `permissions: contents: read` at workflow top level.

### M8. Vulnerable runtime dependencies
- **Fix:** Bump `hono ^4.7.4 → ≥4.12.25` (CORS advisory GHSA-88fw-hqm2-52qc, `apps/api/package.json:52`), `nodemailer → ≥9.0.1`, critical transitive `fast-xml-parser → ≥5.3.5` (via `@aws-sdk`, use `pnpm.overrides`). Add `pnpm audit` as a CI gate.

### M9. Wildcard CORS
- **Where:** `apps/api/src/index.ts:68` (`app.use("*", cors())`) and `apps/nextjs/src/app/api/_enableCors.ts` (`Access-Control-Allow-Origin: *`).
- **Fix:** Restrict `origin` to first-party domains + preview aliases; explicit `allowHeaders`/`allowMethods`; never combine `*` with allow-credentials.

### M10. Encrypted payment-provider secrets sent to the browser
- **Where:** `internal/db/src/validators/paymentConfig.ts` select schema returns `key`/`keyIv`/`webhookSecret`/`webhookSecretIv`; used by `internal/trpc/src/router/lambda/paymentProvider/getConfig.ts:42` + siblings.
- **Fix:** `.omit({ key, keyIv, webhookSecret, webhookSecretIv })` on the output schema (or select only non-secret columns).

---

## LOW (queue; low risk individually)
- **Internal error messages returned on 5xx** — `apps/api/src/errors/http.ts:266-314`, `internal/trpc/src/trpc.ts:317`. Return generic message + `requestId`; stacks already stripped.
- **`analytics.getPlanClickBySessionId` not project-scoped** — `internal/trpc/src/router/lambda/analytics/getPlanClickBySessionId.ts:6,18-21`. Move to `protectedProjectProcedure` + add `project_id` to the pipe query.
- **No body-size cap on sync ingestion** — `apps/api/src/routes/events/ingestEventsV1.ts:62` (`properties: z.record(z.string(), z.unknown())` unbounded). Add max body size + cap key count/depth.
- **`/v1/access/check` bypasses per-key rate limiting** (`apps/api/src/auth/key.ts:10`) and the limiter fails open (`key.ts:147-168`) — confirm intentional.
- **API-key secret entropy ~62 bits** — `internal/db/src/utils/id.ts` reused for the secret in `internal/services/src/apikey/service.ts:133` (embeds timestamp/counter). Use a dedicated ≥128-bit CSPRNG for key secrets.
- **`AUTH_SECRET`** allows `min(1)` (`internal/auth/src/env.ts:19`) and is reused to HMAC realtime tickets (`apps/api/src/index.ts:110`). Raise to `min(32)`; use a distinct `REALTIME_TICKET_SECRET`.
- **`allowDangerousEmailAccountLinking: true`** on both OAuth providers (`internal/auth/src/config.ts:85,90`) + no rate limiting on credentials login/signup. Gate linking on `email_verified`; add lockout (amplifies C1).
- **Secure cookies only in production** (`config.ts:15,26`) — enable for preview. **`trustHost` unconditionally true** (`config.ts:18`) — gate explicitly. **`authorize` returns full user row incl. password hash** (`config.ts:111-117`) — return only `{id,email,name,image}`. **User-enumeration timing** on login — run a decoy `verifyPassword` when the user is absent.
- **docker-compose** default `postgres`/`postgres` creds bound to `0.0.0.0` — bind to `127.0.0.1`, mark dev-only.

## Confirmed OK — do not "fix" / regress
Stripe webhook signature verification (raw-body `constructEventAsync`, per-project secret, fails closed) + idempotency (advisory lock + `webhookEvents` dedup + ledger idempotency keys); no client-supplied prices; integer money math (dinero.js); Durable Object IDs derived server-side from authenticated tenant; realtime WebSocket ticket (HMAC + `iss`/`aud`/`exp` + room binding); PBKDF2 password hashing w/ constant-time compare; API keys stored as SHA-256 hash only; the `protectedProjectProcedure`/`protectedWorkspaceProcedure` guards and the many routers that correctly filter `and(eq(id), eq(projectId))`; CI uses `pull_request` (not `pull_request_target`); no committed secrets.
