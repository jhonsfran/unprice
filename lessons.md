# Lessons

This file is durable working memory for agents and maintainers. Add a lesson
when a task reveals a repo-specific rule, failure mode, build process detail, or
debugging shortcut that should influence future work.

## How To Use

- Read this file before making non-trivial changes.
- Add concise, dated entries when new durable lessons are learned.
- Prefer concrete rules over narrative. Include affected files, commands, or
  docs when useful.
- Do not record secrets, tokens, private customer data, or one-off local noise.
- If a lesson changes an architecture rule, update or create an ADR and link it.

## 2026-05-06: Wallet, Payment Provider, And Activation Lessons

- `pay_in_advance` only means fixed subscription charges bill at period start.
  Usage charges are actuals-based and must invoice at period end; otherwise a
  start-of-cycle zero rating can void the usage billing periods before usage
  exists.
- Billing-period rating must resolve the active customer entitlement grants for
  the subscription item. Calling `RatingService.rateBillingPeriod` without
  grants intentionally returns no charges.
- Zero-total billing periods still need a local invoice row. Finalization can
  void or skip provider collection later, but the statement must exist so the
  dashboard can show what was invoiced for the period.
- Zero-cost invoice items do not have ledger entries. Invoice read models must
  merge ledger-backed lines with invoiced billing periods so statement details
  still show every item at `0`.
- Feature reset configs may use `resetAnchor: "dayOfCreation"`. Rating must
  resolve that anchor from the customer entitlement effective date before
  calling monthly cycle/proration helpers; coercing it to `0` breaks monthly
  invoice generation.
- Invoice finalization must validate the invoice row (`status` and `dueAt`)
  before loading the subscription machine. Draft invoices scheduled in the
  future should return a domain error such as "not ready to finalize yet"
  instead of leaking raw subscription-machine query failures to the dashboard.
- Direct free, zero-amount, and sandbox provisioning must not depend on payment
  webhooks. Webhooks settle provider-owned outcomes; they should not be required
  to make direct signup activation work.
- If signup returns `200` but the subscription parks in `pending_activation`,
  inspect wallet activation first. Search openlogs for `pending_activation`,
  `activateSubscription`, `Wallet activation`, and `Failed query: commit`.
- Project funding accounts are required before customer wallet movements:
  `platform.{projectId}.funding.topup`, `promo`, `plan_credit`, `manual`, and
  `credit_line`.
- Customer wallet account balances are state buckets, not history. A grant can
  move `available.granted -> reserved -> consumed`. Use `pgledger_entries` or
  `unprice_wallet_credits.issued_amount` to inspect the original grant.
- Wallet bigint amounts are ledger-scale minor units. Pgledger account views are
  decimal balances. Normalize before comparing both sides.
- Ledger scale examples: `1 EUR = 100_000_000`, `100 EUR = 10_000_000_000`,
  `0.10 EUR = 10_000_000`.
- `creditLineAmount` means explicit period usage allowance. It is not the plan
  fee and not customer creditworthiness.
- For arrears plans, `creditLineAmount = 0` may derive a conservative allowance
  from finite priced usage limits. Unlimited paid usage still requires an
  explicit allowance or purchased balance.
- Reservations are for positive projected cost only. Zero-cost usage should
  verify entitlement and bypass wallet reservation.
- Tiny-tools E2E should verify real feature slugs from nested entitlement data.
  Fake customer tests must use a real feature slug and expect
  `customer_not_found`, not `feature_missing`.
- Use the signup E2E before usage E2E when validating local provisioning:
  `UNPRICE_TOKEN=unprice_dev_1234567890 pnpm --filter @unprice/tiny-tools e2e:signup:local`.

Related: [ADR-0002: Wallet And Payment Provider Activation Guardrails](docs/adr/ADR-0002-wallet-payment-provider-activation-guardrails.md).

## 2026-05-08: Wallet Read API Display Amounts

- Public wallet reads should expose customer-facing money objects, not only ledger-scale integers.
  Include the raw `ledger_amount` for precision/debugging plus exact major-unit `amount`,
  `currency`, and localized `display_amount`.
- Capped subscription usage is wallet-backed. Tiny-tools usage E2E should detect
  `subscriptionPhase.creditLinePolicy === "capped"` from entitlements and verify the wallet read
  shape while reporting reserved and consumed wallet deltas.

## 2026-05-08: API SDK Endpoint Drift Guard

- Public Hono API routes that should be callable from `@unprice/api` should use SDK-shaped
  `operationId`s. The SDK metadata test compares route operation IDs in `apps/api/src/routes/**`
  with namespace methods exposed by `Unprice`; it intentionally excludes payment-provider
  callback/webhook routes. Do not add a separate endpoint registry when the OpenAPI path types and
  client method surface can be checked directly.
- Keep public route `operationId`s aligned with the SDK namespace/method shape, not necessarily
  with the API route folder that owns the HTTP handler. Keep the first OpenAPI tag aligned with the
  operation namespace. The first path segment after `/v1` must also match the route namespace. For
  example, `/v1/entitlements/get` should use `entitlements.get`
  and tag `entitlements` so the generated OpenAPI contract points at the intuitive SDK call.
- Keep SDK resource methods as one-object calls and group them by product concepts, not raw route
  owners: `entitlements.get({ customerId })`, `subscriptions.get({ customerId })`,
  `payments.methods.list({ customerId, provider })`, `usage.get({ range })`,
  `features.list()`, `plans.getVersion({ planVersionId })`, and `invoices.get({ invoiceId })`.
- Keep payment method endpoints under `/v1/payments/methods/*` and provider callback/webhook
  endpoints under `/v1/payments/providers/*`; both live in `apps/api/src/routes/payments`.

## 2026-05-07: Payment Method Setup UX Cache Refresh

- After returning from a provider payment-method setup flow, the dashboard must bypass the
  `customerPaymentMethods` service cache and poll briefly before showing a permanent empty state.
  Otherwise a freshly attached provider method can be hidden behind a cached `[]`.
- Keep subscription creation drafts open while provider setup runs in a separate tab/window. The
  original form should enter a confirming state, refetch `customers.listPaymentMethods` with
  `skipCache`, and auto-select the first returned method.

## 2026-05-07: Day-Based Subscription Billing Starts

- Recurring `day`, `week`, `month`, and `year` billing treats subscription and grant starts as the
  beginning of their UTC day for cycle and proration math. This avoids charging a prorated first
  flat fee just because the subscription was created mid-day.
- Keep `minute` billing timestamp-exact so short-cycle local testing and sub-day billing behavior
  remain precise.

## 2026-05-07: Stripe Invoice Webhook Success Event

- Stripe can emit both `invoice.payment_succeeded` and `invoice.paid` for the same successful
  invoice payment. Use `invoice.paid` as the canonical success signal because it also covers free,
  credit-balance, and out-of-band paid invoices. Treating both as actionable can race subscription
  reconciliation and surface `SUBSCRIPTION_BUSY` from the subscription machine lock.
- Stripe Connect webhook routes should reject unsupported event types immediately after signature
  verification, before connected-account lookup or webhook-event persistence, so an over-broad
  Stripe endpoint does not amplify DB load across many connected accounts.

## 2026-05-07: Stripe Connect Standard Account Email

- For Stripe Connect Standard accounts, pass the owner email when creating the connected account,
  but do not update `account.email` on reused accounts. Stripe can reject platform updates with
  "not authorized to edit the parameter 'email'" because the connected account owner controls that
  field through onboarding.
