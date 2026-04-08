# AI Billing & Metering Trends (2024-2026)

> Analysis of billing and metering trends for AI/agent workloads, and how Unprice
> maps to each. Used to inform phases 6-10 of the implementation plan.

## Trend 1: Outcome-Based Pricing Replaces Per-Unit Metering

The biggest paradigm shift. Instead of charging per token or API call, companies
charge for successful results. Sierra charges only when a support conversation
is fully resolved. Zendesk bills per "automated resolution." Intercom's Fin
charges $0.99 per resolved ticket. Paid.ai raised $33M specifically to build
infrastructure for this model.

The key insight: if an AI agent fails, the customer pays nothing — aligning
vendor and buyer incentives completely. Gartner projects 40% of enterprise apps
will feature AI agents by end of 2026, making outcome-based pricing the dominant
model for agentic AI.

**Unprice readiness:** Addressed in Phase 9 (Outcome-Based Pricing & Trace
Aggregation). The `OutcomeAggregationDO` groups events by `groupId`, aggregates
them, and only creates billable facts when an outcome is confirmed.

## Trend 2: Three Billing Archetypes — Copilots, Agents, AI-Enabled Services

Bessemer Venture Partners' framework identifies three distinct billing archetypes:

- **Copilots** — per-seat, enhancing humans (e.g., GitHub Copilot)
- **Agents** — outcome or workflow-based, operating autonomously (e.g., Sierra)
- **AI-Enabled Services** — consumption-based, blending automation with human
  oversight (e.g., EvenUp charging per legal document)

Each has fundamentally different cost structures and metering requirements.

**Unprice readiness:** Architecture covers all three via subscriptions (copilot/
seat-based), agent billing through the ledger (consumption), and outcome meters
(agent/task-based). No additional phase needed.

## Trend 3: Multi-Dimensional Metering Is Table Stakes

AI workloads cannot be captured by a single metric. Billing systems must
simultaneously track tokens (input, output, thinking, cached — each priced
differently), GPU/compute seconds, tool/function calls, session duration, and
data volume.

Platforms like Metronome process billions of events daily using Kafka-based
streaming. The architectural challenge: input tokens are known upfront, but
output tokens are non-deterministic and only finalized server-side after
streaming completes.

**Unprice readiness:** Addressed in Phase 10 (Compound Metering). Single event
→ multiple billing facts per dimension, each with independent aggregation and
burn rate multipliers.

## Trend 4: Credits as the Universal Abstraction Layer

Credits have emerged as the dominant intermediary between raw infrastructure
costs and customer-facing pricing. Customers purchase credit blocks; each action
consumes credits according to a "burn table" (e.g., a GPT-4 call burns 5
credits, a Haiku call burns 1).

This decouples pricing from volatile underlying costs (LLM prices dropped ~90%
annually) and lets companies adjust exchange rates without changing customer
contracts. OpenAI, Vercel, Netlify, and most AI-native companies now use
credit-based systems.

**Unprice readiness:** Addressed in Phase 7 (Credits, Wallets & Settlement
Router). Versioned credit burn rates with `effectiveAt`/`supersededAt` handle
price changes without modifying subscriptions.

## Trend 5: Ledger-First Architecture for Billing Integrity

The technical architecture trend is toward append-only financial ledgers as the
single source of truth. Three layers: an Event Layer (records usage with unique
IDs), a Meter Layer (aggregates consumption), and a Ledger Layer (immutable
transaction history).

Every transaction uses idempotency keys to prevent double-charging from
at-least-once delivery pipelines. Atomic balance checks prevent race conditions
where concurrent requests overdraft an account.

**Unprice readiness:** Already implemented (Phase 4). The `LedgerService` with
append-only entries, deterministic `sourceType + sourceId` idempotency, and
transactional running balance is the correct foundation.

## Trend 6: Hybrid Pricing Dominates in Practice

Pure usage-based models correlate with 70% churn and negative margins (per
Paid.ai's analysis of 250+ companies). The winning pattern is: base subscription
(set at roughly 2x delivery cost) + variable usage/outcome credits.

This gives finance teams predictable revenue while capturing expansion upside.
Relevance AI and Lovable use fixed recurring charges plus included usage
thresholds with overage options.

**Unprice readiness:** Already supported. Subscription billing (phases, items,
grants) combined with agent usage through the same ledger pipeline naturally
supports base + usage. No additional phase needed.

## Trend 7: Agent Session/Trace Billing — Grouping Multi-Step Operations

AI agents execute complex multi-step workflows (tool calls, retrieval, reasoning
loops). Billing must aggregate these into meaningful billable units rather than
charging per micro-operation.

Companies track "session duration, actions per session, and the sequence of
activities within sessions." Attribution rules must be codified for workflows
spanning multiple agents and human approvals. Observability tools (distributed
tracing) are being repurposed for billing.

**Unprice readiness:** Addressed in Phase 6 (`traceId`/`sessionId` in event
schema) and Phase 9 (`OutcomeAggregationDO` for group-level billing). Phase 8
uses session grouping for per-session spending caps.

## Trend 8: Real-Time Spending Controls and Budget Guardrails

Only 44% of organizations have financial guardrails for AI (expected to double
by end of 2026). "Agentic Resource Exhaustion" — where a single agent in an
infinite loop racks up thousands in compute — has driven a Fortune 500-wide
$400M "leak" in unbudgeted cloud spend.

The response: hard caps (API returns 429 when exceeded), soft caps (alerts at
75%/90%/100% thresholds), per-session spending limits, tiered rate limits tied
to billing plans, and real-time balance enforcement via atomic check-and-deduct
operations. Coinbase launched "Agentic Wallets" with programmable spending caps
specifically for autonomous AI agents.

**Unprice readiness:** Addressed in Phase 7 (wallet balance as enforcement
primitive) and Phase 8 (Financial Guardrails — spending limits, budget alerts,
circuit breakers).

## Trend 9: Margin Compression and Cost Pass-Through Challenges

AI gross margins are 50-60%, versus 80-90% for traditional SaaS. The core
tension: "your best users are your most expensive users." A support ticket
costing $0.04 for simple questions and $2.80 for complex issues creates
unpredictable margins on a flat $0.99/ticket price.

Successful companies target 60-70% AI gross margin by using one customer-facing
metric (outcomes, credits) and one internal metric to protect margin. PostHog
openly charges a 20% markup on LLM costs. As foundation model prices drop
rapidly, companies pricing on raw tokens face constant margin compression.

**Unprice readiness:** Addressed in Phase 10 (Cost Attribution). Cost tables
track cost-to-serve per feature/dimension. Margin analytics enable per-customer
and per-feature profitability tracking.

## Trend 10: The Billing Platform Arms Race

- **Metronome** (acquired by Stripe) powers OpenAI and Databricks, processing
  billions of events with real-time Kafka architecture.
- **Orb** positions as the "revenue design" platform for GenAI with flexible
  pricing logic and real-time dashboards.
- **Lago** offers open-source self-hosted billing (15K events/second).
- **Paid.ai** is purpose-built for outcome-based AI billing.
- **Flexprice** targets AI startups with a Kafka + ClickHouse + Temporal stack.
- **LedgerUp** focuses on B2B AI with token metering and tiered pricing.
- **Blnk** provides ledger-based infrastructure for AI billing with double-entry
  accounting.

The market has fragmented into specialized AI billing vendors versus
general-purpose platforms adding AI features.

**Unprice readiness:** Well positioned. Cloudflare DO-based metering is a
differentiator (lower latency than Kafka-based competitors). Provider
abstraction prevents vendor lock-in. Vertical integration of metering + rating +
ledger + settlement is competitive.

## Trend 11: Token-Based Pricing Is an Anti-Pattern for End Users

While token-based billing remains standard for API-level (developer-to-developer)
transactions, it is increasingly seen as poor customer UX for end-user products.
Customers "think in outcomes ('implement authentication') rather than
infrastructure consumption ('8,347 input tokens')."

Token pricing maps to infrastructure cost, not business value, and creates
self-limiting behavior where users avoid the product to control costs.

**Unprice readiness:** Feature slugs already abstract billing units from
infrastructure. Credits (Phase 7) complete the abstraction — customers see
credit balance, not token counts.

## Trend 12: Agentic Payments and Crypto Wallet Infrastructure

A nascent but growing trend: AI agents that autonomously transact require their
own payment infrastructure. Coinbase's Agentic Wallets provide autonomous
spending/earning/trading with built-in guardrails (spending caps, contract
allowlists, multi-party approvals).

Stablecoins are emerging as "default agent money" because spending limits and
conditional flows can be enforced at the protocol layer. The x402 payment
protocol is being explored for machine-to-machine micropayments between AI
agents.

**Unprice readiness:** The `one_time` settlement mode in the SettlementRouter
(Phase 7) and the provider abstraction layer leave explicit room for
crypto-backed collectors without requiring dedicated implementation now.

## Trend 13: FinOps for AI as a Distinct Discipline

AI FinOps has emerged as a specialized practice. Organizations need per-customer
cost attribution (which customers drive margin), per-feature profitability
analysis, per-workload tracking (voice vs. text vs. multimodal), and anomaly
detection for cost spikes.

Tools like Kubecost, CloudZero, and dedicated AI FinOps agents proactively
detect cost anomalies. The hierarchical attribution model tracks "cost per token
by model, cost per GPU-second by workload class, cost per customer by feature."

**Unprice readiness:** Addressed in Phase 10 (cost tables, margin analytics) and
Phase 8 (anomaly detection via circuit breaker). Cost metadata on meter facts
enables Tinybird-based FinOps dashboards.

## Trend 14: The Price War Dynamic in Foundation Models

Anthropic and OpenAI are in an active price war — model pricing drops roughly
10x per year. Vercel's AI Gateway passes through provider pricing at zero
markup.

This rapid deflation means billing systems must be designed for frequent rate
changes. Companies building on top of LLMs must decouple their customer pricing
from underlying model costs or face constant margin erosion.

**Unprice readiness:** Versioned credit burn rates (Phase 7) with
`effectiveAt`/`supersededAt` handle rate changes. Plan versioning supports price
updates at the subscription level. Cost tables (Phase 10) track the deflating
cost side independently.

---

## Summary: Unprice Readiness Scorecard

| # | Trend | Status | Phase |
|---|-------|--------|-------|
| 1 | Outcome-based pricing | Planned | 9 |
| 2 | Three billing archetypes | Ready | — |
| 3 | Multi-dimensional metering | Planned | 10 |
| 4 | Credits / wallets | Planned | 7 |
| 5 | Ledger-first architecture | Done | 4 |
| 6 | Hybrid pricing | Ready | — |
| 7 | Session/trace billing | Planned | 6, 9 |
| 8 | Spending controls | Planned | 7, 8 |
| 9 | Margin compression / cost attribution | Planned | 10 |
| 10 | Billing platform positioning | Strong | — |
| 11 | Token abstraction for end users | Ready (with Phase 7) | 7 |
| 12 | Agentic payments / crypto | Door open | 7 |
| 13 | AI FinOps | Planned | 8, 10 |
| 14 | Rapid price changes | Planned | 7, 10 |

## Sources

- [Bessemer Venture Partners: The AI Pricing and Monetization Playbook](https://www.bvp.com/atlas/the-ai-pricing-and-monetization-playbook)
- [Sierra: Outcome-Based Pricing for AI Agents](https://sierra.ai/blog/outcome-based-pricing-for-ai-agents)
- [Orb: Pricing AI Agents](https://www.withorb.com/blog/pricing-ai-agents)
- [Chargebee: The 2026 Playbook for Pricing AI Agents](https://www.chargebee.com/blog/pricing-ai-agents-playbook/)
- [Paid.ai: Usage-Based Pricing for SaaS](https://paid.ai/blog/ai-monetization/usage-based-pricing-for-saas-what-it-is-and-how-ai-agents-are-breaking-it)
- [Chargebee: Usage-Based Billing for AI](https://www.chargebee.com/blog/usage-based-billing-reimagined-for-the-age-of-ai/)
- [Flexprice: AI Usage-Based Pricing](https://flexprice.io/blog/why-ai-companies-have-adopted-usage-based-pricing)
- [Growth Unhinged: AI Agent Pricing Framework](https://www.growthunhinged.com/p/ai-agent-pricing-framework)
- [AnalyticsWeek: AI FinOps 2026](https://analyticsweek.com/finops-for-agentic-ai-cloud-cost-2026/)
- [Coinbase: Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)
- [Blnk Finance: AI Billing](https://www.blnkfinance.com/blog/ai-billing-how-to-build-monetization-cost-tracking-for-ai-agents-with-blnk)
