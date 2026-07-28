# Unprice: Open-Source Customer Money Path for Usage-Based SaaS

[![GitHub stars](https://img.shields.io/github/stars/jhonsfran1165/unprice?style=social)](https://github.com/jhonsfran1165/unprice)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![License: Commercial](https://img.shields.io/badge/License-Commercial-gold.svg)](LICENSE#L665)


> **"Your product is smart, but your pricing is hardcoded."**
>
> Unprice is the open-source customer money path for usage-based SaaS. Sell credits and usage-based plans
> without eating over-budget customer work: authorize in the request path, explain on the invoice,
> and own the money path in open source. "Unprice" means un-hardcoding pricing: moving plan logic
> out of your codebase into one inspectable runtime, not removing price.

## The Problem: Billing Is Too Late

For usage-based products, pricing is not a page or an end-of-cycle invoice job. It is a runtime
decision. By the time billing runs, the expensive work already happened: the LLM call, the data job,
the costly third-party API, the multi-minute workflow.

If the request should have been blocked, the cost is already created. If a customer disputes the
invoice, engineering reconstructs the path from product event to usage counter to billing line by
hand. If you want to change packaging, plan logic is spread across application code, billing scripts,
counters, and support workflows.

## The Solution: Customer Spend In The Request Path

Unprice connects the customer money path so your app can decide **before** the paid work runs.

- **Authorize customer spend before work runs.** Check entitlement, budget, wallet credits, and
  meter rules while the request is still in flight.
- **Meter and gate at runtime.** Check entitlement and consume usage synchronously while the request
  is still in flight.
- **Explain every invoice.** Trace each charge back to rated usage events and ledger captures.
- **One inspectable money path.** Usage, entitlements, budgets, credits, ingestion, and invoices
  share one evidence trail.

AI gateways cap what you spend with providers. Unprice governs what your customer is allowed to
spend, then turns that decision into invoice evidence.

PriceOps is the operating model underneath: metering, entitlements, customer budgets, wallet
credits, and invoice evidence run as one inspectable system in the request path.

## Who It's For

Developer-led AI/API and workflow SaaS teams (Seed to Series A) with customer-triggered paid work,
credits, usage allowances, and hybrid subscription plus usage pricing: **CTOs, founding engineers,
and platform engineers** who own metering, entitlements, and request-path usage enforcement.

## Open & Reciprocal: Dual-Licensed

Unprice is dual-licensed under **AGPL-3.0** and a **Commercial License**.

The published client packages **@unprice/api** and **@unprice/react** are
licensed separately under **MIT**. They are intended to be embedded in customer
applications without applying the AGPL-3.0 core license to the host app.

### Why AGPL? Transparency & Fairness.
We believe the infrastructure that handles your money should be **fully transparent and auditable.**
- **No Hidden Logic**: See exactly how every cent is calculated.
- **Reciprocal Innovation**: Improvements to the core engine benefit the entire community.
- **No Vendor Lock-in**: You own the code. You own the data.

*Note: For businesses that cannot or will not open-source their modifications, we offer a **Commercial
License** that grants full proprietary freedom and dedicated support.*

## Core Capabilities

- **Customer spend authorization**: check entitlement, budget, wallet credits, and meter rules
  before paid work runs.
- **Budgeted runs**: budget envelopes for agents, workflows, jobs, tools, and custom workloads,
  with run-level rejection before the work runs.
- **Runtime entitlements & metering**: check access and consume usage in the product request path.
- **Wallets & credits**: purchased, granted, reserved, and consumed balances, kept distinct from
  entitlement grants.
- **Explainable invoices**: every charge traceable to rated usage events and ledger captures.
- **Bring your own payments**: Stripe-first today, provider-extensible by design — you keep one
  money path while your provider captures payment.
- **Open & inspectable**: explicit schemas for features, meters, entitlements, wallets, and runs,
  plus a generated SDK from OpenAPI contracts.

## Tech Stack

Unprice runs on:
- **Next.js 14** (App Router)
- **Hono API** & **tRPC**
- **Drizzle ORM** & **PostgreSQL**
- **Edge Runtime** support
- **ShadcnUI** & **Tailwind CSS**
- **Stripe** integration (provider-extensible by design)
- **Tinybird** (Optional for high-scale analytics)

## Getting Started

[Visit our documentation](https://docs.unprice.dev) for a 5-minute quickstart guide.

## Agent Skill

Install the Unprice SDK integration playbook in Codex, Claude Code, Cursor, and other
skills-compatible agents:

```bash
npx skills add https://github.com/jhonsfran/unprice --skill integrate-unprice-sdk
```

The same skill is available through the documentation site:

```bash
npx skills add https://docs.unprice.dev --skill integrate-unprice-sdk
```

---

*Unprice is open source. We welcome feedback, bug reports, and feature suggestions that make the
customer money path clearer and safer to run.*
