# Unprice: The PriceOps Infrastructure for SaaS

[![GitHub stars](https://img.shields.io/github/stars/jhonsfran1165/unprice?style=social)](https://github.com/jhonsfran1165/unprice)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![License: Commercial](https://img.shields.io/badge/License-Commercial-gold.svg)](LICENSE#L665)


> **"Your product is smart, but your pricing is hardcoded."**
>
> Unprice is the open-source PriceOps infrastructure that decouples your revenue from your codebase. Built for transparency, performance, and growth.

## The Problem: The "Black Box" of Revenue

Most SaaS billing tools are black boxes. You send them your events, and they tell you how much to charge. You have zero visibility into the logic, and zero control over the infrastructure that powers your most critical business asset: **Your Revenue.**

## The Solution: Open & Reciprocal PriceOps

Unprice is dual-licensed under **AGPL-3.0** and a **Commercial License**.

### Why AGPL? Transparency & Fairness.
We believe the infrastructure that handles your money should be **fully transparent and auditable.**
- **No Hidden Logic**: See exactly how every cent is calculated.
- **Reciprocal Innovation**: Improvements to the core engine benefit the entire community.
- **No Vendor Lock-in**: You own the code. You own the data. You own your destiny.

*Note: For businesses that cannot or will not open-source their modifications, we offer a **Commercial License** that grants full proprietary freedom and dedicated support.*

## Core Features

- **Edge-Native Entitlements**: Check customer permissions at the edge with <100ms latency.
- **High-Volume Metering**: Process 100k+ events/sec for real-time usage tracking.
- **Vendor Freedom**: Decouple from Stripe/Paddle. Swap providers without touching your app code.
- **Atomic Consistency**: Built for mission-critical revenue. Never miss a cent.
- **Dual-Licensed for Growth**: Start with the transparent AGPL core, scale with a commercial license when you're ready.

## Tech Stack

Unprice is built for performance and scale:
- **Next.js 14** (App Router)
- **Hono API** & **tRPC**
- **Drizzle ORM** & **PostgreSQL**
- **Edge Runtime** support
- **ShadcnUI** & **Tailwind CSS**
- **Stripe** integration
- **Tinybird** (Optional for high-scale analytics)

## Getting Started

[Visit our documentation](https://docs.unprice.dev) for a 5-minute quickstart guide.

---

*Unprice is currently in Alpha. We would love your feedback and feature suggestions.*
