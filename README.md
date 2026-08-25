# Unprice: open-source billing for AI credits and agent usage

[![GitHub stars](https://img.shields.io/github/stars/jhonsfran1165/unprice?style=social)](https://github.com/jhonsfran1165/unprice)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![License: Commercial](https://img.shields.io/badge/License-Commercial-gold.svg)](LICENSE#L665)

> "Your product is smart, but your pricing is hardcoded."
>
> Sell AI credits and usage without paying for unfunded agent work. Authorize each agent run or paid
> workflow before it creates cost, reserve customer credits up front, then trace settled usage to
> the invoice.

## Billing is too late

For AI products, billing cannot start at the end of the cycle. By then, the model call, agent run,
or paid workflow already created cost.

If the request should have been blocked, you already paid for it. When a customer disputes an
invoice, engineering must reconstruct the path from product event to usage counter to billing line.
Changing a package also means finding plan logic across application code, billing scripts, counters,
and support workflows.

## Put customer spend in the request path

Every AI charge starts with an authorization. Unprice gives your app that decision before the work
runs.

- **Authorize before work runs.** Check the plan, budget, wallet credits, and meter rules before an
  agent or workflow creates cost.
- **Keep invoice evidence.** Trace each charge to rated usage events and ledger captures.
- **Inspect one money path.** Usage, entitlements, budgets, credits, ingestion, and invoices share
  one evidence trail.

AI gateways cap what you spend with providers. Unprice governs what your customer is allowed to
spend, then turns that decision into invoice evidence.

PriceOps is Unprice's operating model for versioned plan rules, entitlements, customer budgets,
wallet credits, and invoice evidence.

## Who it is for

Unprice is for developer-led AI products that sell prepaid credits, metered AI usage, agent runs,
or paid workflows. It is built for CTOs, founding engineers, and platform engineers who own the
path from customer authorization to invoice.

## Licenses

Unprice is dual-licensed under **AGPL-3.0** and a **Commercial License**.

The published **@unprice/api** client package uses the **MIT License**. You can embed it in an
application without applying the AGPL-3.0 core license to that application.

### Why AGPL?

Money logic should be open to inspection.

- **Read the calculation.** Inspect how the engine rates usage and moves money.
- **Share core changes.** If you distribute a modified core, the AGPL requires you to publish those
  changes under the same license.
- **Keep control.** Run the code in your account and keep your data there.

Use the **Commercial License** if you need to keep modifications to the core private.

## Core capabilities

- **Customer spend authorization.** Check entitlement, budget, wallet credits, and meter rules
  before paid work runs.
- **Budgeted runs.** Set budget envelopes for agents, workflows, jobs, tools, and custom workloads,
  with run-level rejection before the work runs.
- **Runtime entitlements and metering.** Check access and consume usage in the product request path.
- **Wallets and credits.** Keep purchased, granted, reserved, and consumed balances separate from
  entitlement grants.
- **Invoice evidence.** Trace every charge to rated usage events and ledger captures.
- **Bring your own payments.** Stripe is the production provider today. Your provider captures the
  payment while Unprice keeps the customer money path.
- **Open and inspectable.** Read the schemas for features, meters, entitlements, wallets, and runs,
  plus a generated SDK from OpenAPI contracts.

## Tech stack

Unprice uses:

- **Next.js 15** with the App Router
- **Hono API** and **tRPC**
- **Drizzle ORM** and **PostgreSQL**
- **Cloudflare Workers**
- **shadcn/ui** and **Tailwind CSS**
- **Stripe** payments today
- **Tinybird** for analytics

## Get started

[Read the quickstart](https://docs.unprice.dev) to put one agent action on the money path.

## Agent skill

Install the Unprice SDK integration playbook in Codex, Claude Code, Cursor, and other
skills-compatible agents:

```bash
npx skills add https://github.com/jhonsfran/unprice --skill integrate-unprice-sdk
```

The same skill is available through the documentation site:

```bash
npx skills add https://docs.unprice.dev --skill integrate-unprice-sdk
```

Unprice is open source. Bug reports, documentation fixes, and focused feature proposals are
welcome.
