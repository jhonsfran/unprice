# Unprice: Open-Source PriceOps Infrastructure for Usage-Based SaaS

[![GitHub stars](https://img.shields.io/github/stars/jhonsfran1165/unprice?style=social)](https://github.com/jhonsfran1165/unprice)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![License: Commercial](https://img.shields.io/badge/License-Commercial-gold.svg)](LICENSE#L665)


> **"Your product is smart, but your pricing is hardcoded."**
>
> Unprice is open-source PriceOps infrastructure for usage-based SaaS. It puts a real-time budget
> around your most expensive action — rejecting over-budget work before it runs — and explains every
> invoice line from the same money path. "Unprice" means un-hardcoding pricing: moving plan logic out
> of your codebase into one inspectable runtime, not removing price.

## The Problem: Billing Is Too Late

For usage-based products, pricing is not a page or an end-of-cycle invoice job. It is a runtime
decision. By the time billing runs, the expensive work already happened: the LLM call, the data job,
the costly third-party API, the multi-minute workflow.

If the request should have been blocked, the cost is already created. If a customer disputes the
invoice, engineering reconstructs the path from product event to usage counter to billing line by
hand. If you want to change packaging, plan logic is spread across application code, billing scripts,
counters, and support workflows.

## The Solution: Pricing in the Request Path

Unprice connects the runtime money path so your app can decide **before** the expensive work runs.

- **Stop runaway usage before it runs.** Put a real-time budget around a customer or workload and
  reject over-budget work in the request path.
- **Meter and gate at runtime.** Check entitlement and consume usage synchronously while the request
  is still in flight.
- **Explain every invoice.** Trace each charge back to rated usage events and ledger captures.
- **One inspectable money path.** Usage, entitlements, budgets, credits, ingestion, and invoices
  share one evidence trail.

PriceOps means operating pricing as live infrastructure — metering, entitlements, budgets, credits,
and invoice evidence run as one inspectable system in the request path, the way DevOps operates
deploys and FinOps operates cloud spend.

## Who It's For

Developer-led AI/API SaaS teams (Seed to Series A) with expensive per-request usage and hybrid
subscription plus usage/credit pricing: **CTOs, founding engineers, and platform engineers** who own
metering, entitlements, and request-path usage enforcement.

## Open & Reciprocal: Dual-Licensed

Unprice is dual-licensed under **AGPL-3.0** and a **Commercial License**.

### Why AGPL? Transparency & Fairness.
We believe the infrastructure that handles your money should be **fully transparent and auditable.**
- **No Hidden Logic**: See exactly how every cent is calculated.
- **Reciprocal Innovation**: Improvements to the core engine benefit the entire community.
- **No Vendor Lock-in**: You own the code. You own the data. You own your destiny.

*Note: For businesses that cannot or will not open-source their modifications, we offer a **Commercial
License** that grants full proprietary freedom and dedicated support.*

## Core Capabilities

- **Real-time spend budgets**: budgeted runs for agents, workflows, jobs, tools, and custom
  workloads, with run-level rejection before the work runs.
- **Runtime entitlements & metering**: check access and consume usage in the product request path.
- **Wallets & credits**: purchased, granted, reserved, and consumed balances, kept distinct from
  entitlement grants.
- **Explainable invoices**: every charge traceable to rated usage events and ledger captures.
- **Bring your own payments**: Stripe-first today, provider-extensible by design (Paddle, Lemon
  Squeezy, and others) — you keep one pricing runtime.
- **Open & inspectable**: explicit schemas for features, meters, entitlements, wallets, and runs,
  plus a generated SDK from OpenAPI contracts.

## Tech Stack

Unprice is built for performance and scale:
- **Next.js 14** (App Router)
- **Hono API** & **tRPC**
- **Drizzle ORM** & **PostgreSQL**
- **Edge Runtime** support
- **ShadcnUI** & **Tailwind CSS**
- **Stripe** integration (provider-extensible by design)
- **Tinybird** (Optional for high-scale analytics)

## Getting Started

[Visit our documentation](https://docs.unprice.dev) for a 5-minute quickstart guide.

---

*Unprice is currently in Alpha. We would love your feedback and feature suggestions.*
