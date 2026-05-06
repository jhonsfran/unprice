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
