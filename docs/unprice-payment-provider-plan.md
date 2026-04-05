# Unprice Multi-Payment-Provider Architecture Plan

## The Key Insight: Unprice Is Not Delegating Subscriptions

After auditing the codebase, the most important realization is this:

**Unprice already owns the entire subscription lifecycle.** The `SubscriptionMachine` (xstate) handles trials, renewals, cancellations, and state transitions. `BillingService` handles billing periods, invoice generation, proration, credits, and usage computation. The payment provider is used for exactly three things:

1. **Onboarding** — collect a payment method from the customer (`createSession`, `signUp`)
2. **Invoicing** — mirror an already-computed invoice to the provider and collect payment
3. **Payment method management** — list/validate saved payment methods

Unprice does NOT use Stripe Subscriptions, Stripe Billing, or any provider-managed recurring billing. This is a massive advantage — it means the payment provider is a **payment collection backend**, not a billing engine. The refactor should formalize this role.

---

## Current Architecture Problems

### 1. Plan versions are coupled to a single payment provider

```
plan_versions.paymentProvider = "stripe"  ← baked in at plan design time
```

This means to offer the same plan via Paddle, you'd duplicate the entire plan version. Wrong. The plan defines **what** is sold (features, pricing, billing interval). The provider defines **how** payment is collected.

### 2. Customer has a hardcoded `stripeCustomerId` column

```sql
customers.stripe_customer_id TEXT UNIQUE
```

Adding Paddle means adding `paddle_customer_id`, then `coinbase_customer_id`, etc. This doesn't scale.

### 3. `getProviderCustomerId()` is a switch on provider name

```typescript
if (provider === "stripe") return customerData?.stripeCustomerId
if (provider === "sandbox") return customerData?.id
return customerData?.stripeCustomerId  // fallback to stripe (!?)
```

### 4. `PaymentProviderInterface.upsertProduct` takes `Stripe.ProductCreateParams`

A Stripe SDK type in the provider-agnostic interface.

### 5. Invoice has `paymentProvider` baked in

The invoice knows its provider at creation time (copied from plan version). If the customer switches providers mid-subscription, old invoices can't be re-collected through a different provider.

### 6. No webhook processing

The system uses redirect callbacks only. Payment failures, disputes, and async payment confirmations (especially relevant for crypto) go undetected.

---

## Proposed Architecture

### Principle: The provider is a payment rail, not a billing engine

Unprice computes what is owed. The provider collects money. That's it.

```
┌─────────────────────────────────────────────────────────┐
│                    UNPRICE (owns everything)             │
│                                                         │
│  Plans → Versions → Features → Subscriptions → Invoices │
│  Metering → Usage → Entitlements → Credits              │
│  State machine → Renewals → Billing periods             │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │         PaymentCollector Interface               │    │
│  │  (what providers actually do for us)             │    │
│  │                                                  │    │
│  │  • ensureCustomer(email, name) → providerId      │    │
│  │  • setupPaymentMethod(customerId) → redirect/url │    │
│  │  • createInvoice(items, total) → providerInvId   │    │
│  │  • collectPayment(invoiceId, methodId) → status  │    │
│  │  • getPaymentStatus(invoiceId) → status          │    │
│  │  • refund(paymentId, amount) → status            │    │
│  │  • handleWebhook(raw) → NormalizedEvent[]        │    │
│  └──────┬──────────────┬───────────────┬────────────┘    │
│         │              │               │                 │
│    ┌────┴────┐   ┌─────┴─────┐   ┌─────┴──────┐        │
│    │ Stripe  │   │  Paddle   │   │   Crypto   │        │
│    │Collector│   │ Collector │   │  Collector  │        │
│    └─────────┘   └───────────┘   └────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### What changes vs. what stays

| Component | Change? | Notes |
|---|---|---|
| Plans, versions, features | **Minor** | Remove `paymentProvider` from `plan_versions`. Add `supportedCurrencies` to provider config. |
| `SubscriptionMachine` | **No change** | Stays exactly as-is. It never touches the provider directly. |
| `BillingService` (compute side) | **No change** | Usage calculation, proration, credit application — all internal. |
| `BillingService` (provider sync) | **Refactor** | `_upsertPaymentProviderInvoice` and `_collectInvoicePayment` call the new interface. |
| `PaymentProviderInterface` | **Replace** | Renamed to `PaymentCollector`. Smaller, cleaner contract. |
| `PaymentProviderService` (switch router) | **Delete** | Replace with constructor-resolved delegation. |
| Customer schema | **Migrate** | `stripeCustomerId` → `customer_provider_ids` table. |
| Invoice schema | **Migrate** | `paymentProvider` moves from plan-time to payment-time decision. |
| Webhook handling | **New** | Add normalized webhook pipeline. |

---

## Phase 1: Schema Changes (DB migration)

### 1a. New table: `customer_provider_ids`

```sql
CREATE TABLE customer_provider_ids (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  provider    payment_providers NOT NULL,  -- reuse existing enum
  provider_customer_id TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,

  UNIQUE (project_id, customer_id, provider),
  UNIQUE (project_id, provider, provider_customer_id),
  FOREIGN KEY (customer_id, project_id) REFERENCES customers(id, project_id)
);
```

**Why:** One customer can exist in Stripe, Paddle, and a crypto wallet simultaneously. Each row maps `(customer, provider) → provider_customer_id`. Migration: copy existing `customers.stripe_customer_id` into this table, then drop the column.

### 1b. Remove `paymentProvider` from `plan_versions`

The payment provider is resolved at **subscription phase** level, not plan level. Why? Because:

- The same "Pro Plan v2" should be purchasable via Stripe in the US and via crypto in LATAM
- The plan defines pricing (currency + amount + features). The provider is a payment rail.

Where does the provider go? It's already implicitly on the **subscription phase** — the phase has `paymentMethodId`, which belongs to a specific provider. Make it explicit:

```sql
ALTER TABLE subscription_phases ADD COLUMN payment_provider payment_providers NOT NULL DEFAULT 'stripe';
```

The invoice's `paymentProvider` is then copied from the active phase at invoice creation time (which is already what happens, just indirectly through plan version today).

### 1c. Add `supportedCurrencies` to `payment_provider_config`

```sql
ALTER TABLE payment_provider_config ADD COLUMN supported_currencies TEXT[] NOT NULL DEFAULT '{USD}';
```

Validation rule at subscription creation:

```
phase.planVersion.currency ∈ providerConfig[phase.paymentProvider].supportedCurrencies
```

### 1d. New table: `webhook_events` (idempotency)

```sql
CREATE TABLE webhook_events (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  provider              payment_providers NOT NULL,
  provider_event_id     TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending | processed | failed
  payload               JSONB,
  error                 TEXT,
  created_at            BIGINT NOT NULL,
  processed_at          BIGINT,

  UNIQUE (project_id, provider, provider_event_id)
);
```

---

## Phase 2: New `PaymentCollector` Interface

### The contract

This is the only thing a payment provider needs to implement. Notice what's missing vs. the current interface: no `upsertProduct`, no `getSession`, no Stripe types anywhere.

```typescript
interface PaymentCollector {
  readonly providerId: string  // "stripe" | "paddle" | "crypto_usdc"

  // ── Customer ──
  ensureCustomer(input: {
    email: string
    name: string
    metadata?: Record<string, string>
  }): Promise<Result<{ providerCustomerId: string }, PaymentCollectorError>>

  // ── Payment method setup ──
  // Returns a URL/token for the customer to add a payment method
  setupPaymentMethod(input: {
    providerCustomerId: string
    returnUrl: string
    cancelUrl: string
  }): Promise<Result<SetupResult, PaymentCollectorError>>

  // ── List saved payment methods ──
  listPaymentMethods(input: {
    providerCustomerId: string
    limit?: number
  }): Promise<Result<NormalizedPaymentMethod[], PaymentCollectorError>>

  // ── Invoice & collect ──
  // Unprice has already computed the invoice. This mirrors it to the provider.
  createInvoice(input: {
    providerCustomerId: string
    currency: string
    items: InvoiceLineItem[]
    description: string
    dueDate?: number
    collectionMethod: "charge_automatically" | "send_invoice"
    metadata?: Record<string, string>
  }): Promise<Result<{ providerInvoiceId: string; invoiceUrl: string }, PaymentCollectorError>>

  // Attempt to collect payment for a finalized invoice
  collectPayment(input: {
    providerInvoiceId: string
    paymentMethodId: string
  }): Promise<Result<NormalizedPaymentResult, PaymentCollectorError>>

  // Check current payment status
  getPaymentStatus(input: {
    providerInvoiceId: string
  }): Promise<Result<NormalizedPaymentResult, PaymentCollectorError>>

  // ── Refunds ──
  refund(input: {
    providerInvoiceId: string
    amountCents: number
    reason?: string
  }): Promise<Result<{ refundId: string; status: string }, PaymentCollectorError>>

  // ── Webhooks ──
  // Parse and normalize a raw webhook into domain events
  parseWebhook(input: {
    body: string
    headers: Record<string, string>
    signingSecret: string
  }): Promise<Result<NormalizedWebhookEvent[], PaymentCollectorError>>

  // ── Capabilities ──
  // Providers declare what they can do. This avoids "not implemented" runtime errors.
  capabilities: ProviderCapabilities
}
```

### Normalized types (provider-agnostic)

```typescript
type SetupResult =
  | { type: "redirect"; url: string }                    // Stripe Checkout, Paddle
  | { type: "wallet_connect"; chainId: number; token: string } // Crypto
  | { type: "none" }                                     // Sandbox

type NormalizedPaymentMethod = {
  id: string
  type: "card" | "bank" | "wallet" | "crypto_wallet"
  label: string        // "Visa •••• 4242" or "0x1a2b...3c4d (USDC)"
  isDefault: boolean
  expiresAt?: number   // unix ms, undefined for crypto
}

type NormalizedPaymentResult = {
  status: "paid" | "pending" | "failed" | "void"
  paidAt?: number
  providerInvoiceUrl?: string
  failureReason?: string
}

type NormalizedWebhookEvent = {
  providerEventId: string
  type: WebhookEventType
  data: WebhookEventData
}

type WebhookEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.refunded"
  | "payment_method.updated"
  | "payment_method.expired"
  | "customer.updated"
  | "dispute.created"

// Discriminated union — each event type has its own data shape
type WebhookEventData =
  | { type: "payment.succeeded"; providerInvoiceId: string; paidAt: number; amountCents: number }
  | { type: "payment.failed"; providerInvoiceId: string; reason: string; attemptCount: number }
  | { type: "payment.refunded"; providerInvoiceId: string; refundAmountCents: number }
  | { type: "payment_method.expired"; providerCustomerId: string; methodId: string }
  | { type: "dispute.created"; providerInvoiceId: string; reason: string; amountCents: number }
  // ... etc

type ProviderCapabilities = {
  supportsAutoCharge: boolean      // can charge a saved payment method
  supportsSendInvoice: boolean     // can email an invoice link to customer
  supportsRefunds: boolean
  supportsPartialRefunds: boolean
  requiresProductSync: boolean     // Paddle needs products, Stripe doesn't
  supportsWebhooks: boolean        // crypto might be polling-based
  supportedCurrencies: string[]    // ["USD", "EUR"] for Stripe, ["USDC", "USDT"] for crypto
  settlementType: "fiat" | "crypto"
}
```

### Why no `upsertProduct`?

Because unprice owns the product catalog (features, plans, versions). Most providers don't need a pre-registered product to create an invoice line item:

- **Stripe**: Invoice items work fine with just `description` + `amount` + `quantity`. No product needed.
- **Paddle**: Requires products. But this is Paddle's problem to solve in their collector implementation — `PaddleCollector.createInvoice()` internally calls `paddle.products.create()` and caches the mapping. The interface doesn't expose it.
- **Crypto**: No concept of products. You send an amount to a contract.

If a provider needs products, it manages that mapping internally (e.g., a `provider_products` cache table). This is an implementation detail, not an interface concern.

---

## Phase 3: Provider Implementations

### 3a. Stripe Collector

Stripe is the simplest because your current flow is already "invoice-first":

```
Current flow (stays the same, just cleaner):
  1. BillingService computes invoice internally
  2. StripeCollector.createInvoice() → creates Stripe draft invoice with line items
  3. StripeCollector.collectPayment() → finalizes + pays via saved payment method
  4. OR customer pays via hosted invoice link
```

**Key simplification:** Stop using `Stripe.ProductCreateParams` in the interface. Stripe invoice items accept `amount` directly — no product needed. Your current `_upsertPaymentProviderInvoice` already does this (it calls `addInvoiceItem` with amounts, not product IDs). Formalize it.

**Migration effort:** Low. The current `StripePaymentProvider` class is ~650 lines. The new `StripeCollector` will be ~300 lines because half the current code is for session management that can be simplified.

### 3b. Paddle Collector

Paddle is webhook-heavy and requires products, but since unprice owns the lifecycle:

```
Flow:
  1. BillingService computes invoice
  2. PaddleCollector.createInvoice():
     - For each line item, ensure a Paddle product exists (internal cache table)
     - Create a Paddle "transaction" (their equivalent of an invoice) 
     - Return the transaction ID + checkout URL
  3. Customer pays via Paddle checkout overlay
  4. Paddle webhook fires → parseWebhook() → NormalizedEvent
  5. Unprice processes "payment.succeeded" → marks invoice as paid
```

**Why Paddle works in this model:** Paddle manages payments and taxes (they're a Merchant of Record). But unprice doesn't need Paddle Subscriptions. Use Paddle's one-time transaction API to collect payment for each billing cycle. Paddle handles tax, fraud, and payment method management. Unprice handles everything else.

**Product sync:** The `PaddleCollector` maintains an internal `paddle_product_cache` table mapping `(featureSlug, currency) → paddle_product_id`. Created lazily on first invoice. Not exposed in the interface.

### 3c. Crypto Collector (Stablecoin Micro-transactions)

This is where the architecture pays off. A crypto payment rail is fundamentally different from Stripe/Paddle, but the interface handles it cleanly:

```
Flow:
  1. BillingService computes invoice ($4.20 for API usage this month)
  2. CryptoCollector.createInvoice():
     - Convert amount to USDC (1:1 for stablecoins, or via oracle for others)
     - Generate a payment intent: unique wallet address or smart contract call
     - Return providerInvoiceId = "payment_intent_0xabc..."
     - Return invoiceUrl = link to payment page
  3. CryptoCollector.collectPayment():
     - For auto-charge: submit on-chain tx from customer's pre-approved allowance
     - For manual: return the payment page URL
  4. Payment confirmation:
     - Option A: Poll chain for tx confirmation (no webhook needed)
     - Option B: Use a service like Coinbase Commerce / Circle that provides webhooks
```

**Implementation approach — start practical, not custom:**

Don't build a custom on-chain payment system. Use an existing crypto payment rail:

| Option | Effort | Best for |
|---|---|---|
| **Circle (USDC)** | Medium | Enterprise, high-value invoices |
| **Coinbase Commerce** | Low | General crypto payments, provides webhooks |
| **Superfluid** | Medium | Real-time streaming payments (true micro-tx) |
| **Request Network** | Low | Invoice-native, supports USDC/DAI |
| **Custom ERC-20 allowance** | High | Full control, lowest fees |

**Recommended start:** Use **Request Network** or **Coinbase Commerce** as the crypto collector backend. Both provide invoice APIs and webhook notifications. You can swap to a custom on-chain solution later — the `PaymentCollector` interface doesn't change.

**Stablecoin micro-transactions specifically:**

For usage-based billing where amounts are tiny ($0.002 per API call), there are two practical approaches:

1. **Batch into periodic invoices** (recommended): Unprice already does this — metered usage is accumulated and invoiced per billing cycle. A $4.20 monthly invoice in USDC is a normal transaction. No micro-tx overhead.

2. **Pre-paid credit balance**: Customer deposits USDC into a smart contract or custodial balance. Unprice debits internally per usage event. Periodic on-chain settlement reconciles the balance. This maps perfectly to your existing `credit_grants` table.

```
Customer deposits 100 USDC → credit_grant { totalAmount: 10000, currency: "USDC" }
Usage happens → internal debit (no on-chain tx)
Monthly settlement → reconcile credit_grant.amountUsed with on-chain balance
Top-up webhook → new credit_grant when deposit detected
```

---

## Phase 4: Provider Resolution (Runtime Wiring)

### Delete the switch/case router

Current `PaymentProviderService` has 14 identical switch blocks. Replace with:

```typescript
function resolveCollector(
  provider: PaymentProvider,
  token: string,
  providerCustomerId: string | undefined,
  logger: Logger
): PaymentCollector {
  switch (provider) {
    case "stripe":
      return new StripeCollector({ token, providerCustomerId, logger })
    case "paddle":
      return new PaddleCollector({ token, providerCustomerId, logger })
    case "crypto_usdc":
      return new CryptoCollector({ token, providerCustomerId, logger })
    case "sandbox":
      return new SandboxCollector({ logger, providerCustomerId })
    default:
      throw new Error(`Unknown payment provider: ${provider}`)
  }
}
```

This is called **once** when the service needs a provider. All subsequent calls go through the `PaymentCollector` interface. No more switch/case per method.

### Update `CustomerService.getPaymentProvider()`

```typescript
// BEFORE: returns PaymentProviderService (the switch router)
// AFTER: returns PaymentCollector (the resolved implementation)

public async getPaymentCollector(input: {
  customerId?: string
  projectId: string
  provider: PaymentProvider
}): Promise<Result<PaymentCollector, ...>> {
  const config = await this.db.query.paymentProviderConfig.findFirst(...)
  const token = await decrypt(config.key, config.keyIv)

  // Look up provider customer ID from the new mapping table
  let providerCustomerId: string | undefined
  if (input.customerId) {
    const mapping = await this.db.query.customerProviderIds.findFirst({
      where: (t, { and, eq }) => and(
        eq(t.customerId, input.customerId),
        eq(t.provider, input.provider),
        eq(t.projectId, input.projectId),
      )
    })
    providerCustomerId = mapping?.providerCustomerId
  }

  return Ok(resolveCollector(input.provider, token, providerCustomerId, this.logger))
}
```

---

## Phase 5: Webhook Pipeline

### Why webhooks matter for this architecture

Since unprice owns the subscription lifecycle, you might think: "I poll the provider in `_collectInvoicePayment` already, why do I need webhooks?"

Because polling only works when **you initiate the check**. These scenarios happen asynchronously:

| Event | When it happens | How you learn about it |
|---|---|---|
| Stripe retries a failed payment and it succeeds 3 hours later | Async | Webhook only |
| Customer's card expires | Async | Webhook only |
| Paddle issues a refund via their dashboard | Async | Webhook only |
| USDC transfer confirms after 2 block confirmations | Async | Webhook or chain poll |
| Customer disputes a charge | Async | Webhook only |
| Crypto payment received on pre-approved allowance | Async | Webhook or chain poll |

**Without webhooks, your invoice stays in `unpaid`/`waiting` state until the next billing job polls it.** That could be hours or days. With webhooks, the state updates in seconds.

### Implementation

```typescript
// In your Hono API routes:
app.post("/api/v1/webhooks/:provider", async (c) => {
  const provider = c.req.param("provider")  // "stripe" | "paddle" | "crypto"
  const body = await c.req.text()
  const headers = Object.fromEntries(c.req.raw.headers.entries())

  const config = await getProviderConfig(projectId, provider)
  const collector = resolveCollector(provider, config.token, undefined, logger)

  // 1. Parse (provider-specific) → normalized events
  const { val: events, err } = await collector.parseWebhook({
    body, headers, signingSecret: config.webhookSecret
  })
  if (err) return c.json({ error: "Invalid webhook" }, 400)

  // 2. Process each event with idempotency
  for (const event of events) {
    const existing = await db.query.webhookEvents.findFirst({
      where: (t, { and, eq }) => and(
        eq(t.providerEventId, event.providerEventId),
        eq(t.provider, provider),
        eq(t.projectId, projectId),
      )
    })
    if (existing?.status === "processed") continue  // idempotent skip

    // 3. Process based on event type
    await processWebhookEvent(event, projectId, db)

    // 4. Mark as processed
    await db.insert(webhookEvents).values({
      id: newId("webhook_event"),
      projectId,
      provider,
      providerEventId: event.providerEventId,
      eventType: event.type,
      status: "processed",
      createdAt: Date.now(),
      processedAt: Date.now(),
    }).onConflictDoNothing()
  }

  return c.json({ received: true })
})

async function processWebhookEvent(event: NormalizedWebhookEvent, projectId: string, db: Database) {
  switch (event.data.type) {
    case "payment.succeeded": {
      // Find internal invoice by providerInvoiceId → update status to "paid"
      await db.update(invoices)
        .set({ status: "paid", paidAt: event.data.paidAt })
        .where(eq(invoices.invoicePaymentProviderId, event.data.providerInvoiceId))
      break
    }
    case "payment.failed": {
      // Append to payment attempts, update status
      break
    }
    case "payment_method.expired": {
      // Notify customer, maybe pause subscription
      break
    }
    case "dispute.created": {
      // Flag invoice, alert admin
      break
    }
  }
}
```

---

## Phase 6: The Checkout Standardization

### The problem

Every provider has a different checkout UX:
- **Stripe**: Redirect to Checkout, or embedded Elements
- **Paddle**: Overlay/iframe checkout
- **Crypto**: Connect wallet → approve allowance → sign transaction

### The solution: don't standardize the UX, standardize the result

The checkout produces exactly one outcome that unprice cares about: **a `providerCustomerId` and optionally a `paymentMethodId`**.

```typescript
// SetupResult from the interface
type SetupResult =
  | { type: "redirect"; url: string }         // Stripe, Paddle
  | { type: "wallet_connect"; ... }           // Crypto
  | { type: "none" }                          // Sandbox

// After checkout completes (via redirect callback or webhook):
type CheckoutComplete = {
  providerCustomerId: string
  paymentMethodId?: string
}
```

The frontend handles the UX differences:

```typescript
// Frontend pseudo-code
const result = await api.setupPaymentMethod({ provider: "stripe" })

if (result.type === "redirect") {
  window.location.href = result.url
} else if (result.type === "wallet_connect") {
  await connectWallet(result.chainId, result.token)
}
// After completion, backend processes the callback/webhook and stores the mapping
```

**The backend callback** (your existing `stripeSetupV1` and `stripeSignUpV1`) becomes a generic handler:

```typescript
// POST /api/v1/checkout/callback/:provider
// Called after redirect-based checkouts complete
app.get("/api/v1/checkout/callback/:provider", async (c) => {
  const { provider } = c.req.param()
  const collector = resolveCollector(provider, ...)

  // Provider-specific session retrieval happens inside the collector
  // The result is always the same normalized shape
  const sessionData = await collector.completeSetup({
    sessionId: c.req.query("session_id")
  })

  // Store the mapping
  await db.insert(customerProviderIds).values({
    customerId: sessionData.internalCustomerId,
    provider,
    providerCustomerId: sessionData.providerCustomerId,
    ...
  })

  // Redirect to success page
  return c.redirect(sessionData.successUrl)
})
```

---

## Answering: Why Not Worry About Provider Subscription State?

You're right — you don't need to. Here's the clean mental model:

```
┌──────────────────────────────────────────────────────┐
│              UNPRICE OWNS (internal state)            │
│                                                      │
│  Subscription: active / trialing / past_due / ended  │
│  Billing periods: pending → invoiced → closed        │
│  Invoices: draft → open → paid / failed / void       │
│  Entitlements: computed from active sub items         │
│  Usage: metered via Tinybird, reported internally     │
│  Credits: grant → apply → deplete                    │
│  Renewals: subscription machine handles autonomously  │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│          PROVIDER OWNS (external state)              │
│                                                      │
│  Customer record (providerCustomerId)                │
│  Payment methods (cards, wallets)                    │
│  Invoice/transaction (mirror of internal invoice)    │
│  Payment attempt results (paid/failed)               │
│  Dispute state                                       │
└──────────────────────────────────────────────────────┘
```

**What you sync to the provider each billing cycle:**

```
Internal invoice (computed by BillingService)
  → createInvoice(items: [
      { description: "Pro Plan - API Access", amount: 2900, qty: 1 },
      { description: "API Calls (1,247 used)", amount: 1247, qty: 1 },
      { description: "Credits applied", amount: -500, qty: 1 },
    ], total: 3647)
  → collectPayment(invoiceId, paymentMethodId)
  → result: paid | failed
```

That's it. You're already doing this in `_upsertPaymentProviderInvoice`. The provider never sees your subscription, plan, phase, or entitlement state. It just sees: "charge this customer $36.47."

**You don't need provider subscription objects.** No `stripe.subscriptions.create()`. No Paddle subscription API. Each billing cycle, you create a one-off invoice/transaction and collect it. This is the correct model for a system that owns its own subscription lifecycle.

### What you DO need to worry about from the provider

1. **Payment state**: Did the charge succeed? Webhooks tell you about retries, failures, disputes.
2. **Customer state**: Is their payment method still valid? Webhooks tell you about expiry.
3. **Compliance state**: For providers like Paddle (MoR), tax receipts and compliance docs come from them.

---

## Implementation Priority & Effort

| Phase | What | Effort | Risk |
|---|---|---|---|
| **1** | Schema migration (customer_provider_ids, move paymentProvider to phase, webhook_events) | 2-3 days | Medium — data migration for existing customers |
| **2** | New `PaymentCollector` interface + `StripeCollector` implementation | 3-4 days | Low — mostly reshaping existing code |
| **3** | Delete `PaymentProviderService` switch router, update `CustomerService` | 1 day | Low |
| **4** | Remove `Stripe.*` types from interface | 1 day | Low |
| **5** | Webhook pipeline (generic handler + Stripe parser) | 2-3 days | Medium |
| **6** | Paddle collector | 3-5 days | Medium — new provider, needs testing |
| **7** | Crypto collector (via Coinbase Commerce or Request Network) | 3-5 days | Medium — new domain |
| **8** | Checkout standardization (generic callback handler) | 2 days | Low |

**Total: ~3-4 weeks of focused work.** Phases 1-5 can ship independently and immediately improve the architecture. Phases 6-7 are additive — each new provider is a single file implementing `PaymentCollector`.

---

## Phase 7: Checkout Flow Refactor

### Current Flow (What Exists Today)

The checkout has two branches decided in `sign-up.ts`:

```
signUp()
  → resolvePlanVersion() (by slug, sessionId, or versionId)
  → if planVersion.paymentMethodRequired && !sandbox:
      → handlePaymentRequiredFlow()    ← STRIPE-SPECIFIC
  → else:
      → handleDirectProvisioningFlow() ← PROVIDER-AGNOSTIC (already clean)
```

**The direct provisioning flow is fine.** It creates customer + subscription + phase in a DB transaction and returns `successUrl`. No provider involved. This handles free plans and sandbox.

**The payment-required flow is the problem.** Here's what it does:

1. Creates a `customer_sessions` row storing: customer intent + plan version snapshot
2. Calls `paymentProviderService.signUp()` which creates a **Stripe Checkout session in `mode: "setup"`**
3. Returns the Stripe Checkout URL to the SDK
4. User fills payment details on Stripe's hosted page
5. Stripe redirects to `/v1/paymentProvider/stripe/signUp/{sessionId}/{projectId}`
6. The callback handler retrieves the Stripe session, upserts the customer with `stripeCustomerId`, creates the subscription + phase

### Problems with the Current Checkout

**1. The `customer_sessions` table stores Stripe-typed JSON**

```typescript
// customers.ts schema
customer: json("customer").$type<z.infer<typeof stripeSetupSchema>>()
planVersion: json("plan_version").$type<z.infer<typeof stripePlanVersionSchema>>()
```

The session table is named generically but the data shape is Stripe-specific.

**2. Provisioning happens in TWO places**

- `handleDirectProvisioningFlow()` creates customer + subscription in the use case
- `stripeSignUpV1.ts` callback ALSO creates customer + subscription (lines 155-236)

This is duplicated logic. If you add Paddle, you'd need a third copy in `paddleSignUpV1.ts`.

**3. The callback route is hardcoded per provider**

```
/v1/paymentProvider/stripe/signUp/{sessionId}/{projectId}  ← Stripe
/v1/paymentProvider/stripe/setup/{sessionId}/{projectId}   ← Stripe setup
```

Each new provider means a new route with duplicated provisioning logic.

**4. The provider is determined by the plan version**

```typescript
const paymentProvider = planVersion.paymentProvider  // ← baked into plan
```

After removing `paymentProvider` from plan versions (Phase 1), the sign-up flow needs a different way to know which provider to use.

### Proposed Checkout Architecture

The key insight: **split "collect payment method" from "provision subscription"**. These are two independent operations that happen to run in sequence today.

```
┌────────────────────────────────────────────────────────────────┐
│  Step 1: signUp() — ALWAYS provisions immediately             │
│                                                                │
│  Creates: customer + subscription + phase (status: pending)    │
│  Returns: { customerId, subscriptionId, setupRequired: bool }  │
│                                                                │
│  No provider interaction. Pure DB operation.                   │
└───────────────────────────┬────────────────────────────────────┘
                            │
                   setupRequired?
                   ┌────────┴────────┐
                   │ NO              │ YES
                   │                 │
            ┌──────┴──────┐   ┌─────┴──────────────────────────┐
            │ Activate    │   │ Step 2: setupPaymentMethod()   │
            │ subscription│   │                                 │
            │ immediately │   │ Input: customerId + provider    │
            └─────────────┘   │ Output: SetupResult             │
                              │   redirect → provider URL       │
                              │   wallet_connect → chain info   │
                              │   none → sandbox (auto-activate)│
                              └─────┬──────────────────────────┘
                                    │
                              ┌─────┴──────────────────────────┐
                              │ Step 3: Callback/Webhook       │
                              │                                 │
                              │ POST /api/v1/checkout/complete  │
                              │   OR webhook event              │
                              │                                 │
                              │ 1. Store providerCustomerId     │
                              │ 2. Store paymentMethodId        │
                              │ 3. Activate subscription        │
                              │ 4. Redirect to successUrl       │
                              └────────────────────────────────┘
```

### Why this is better

**1. Provisioning happens in exactly one place** — the `signUp()` use case. Always. The callback only activates an already-created subscription.

**2. The callback is generic** — one route handles all providers:

```typescript
// POST /api/v1/checkout/complete/:provider
app.get("/api/v1/checkout/complete/:provider", async (c) => {
  const { provider } = c.req.param()
  const collector = resolveCollector(provider, ...)

  // Each collector knows how to extract the result from its own callback
  const result = await collector.completeSetup({
    query: c.req.query(),  // session_id for Stripe, transaction_id for Paddle, etc.
    headers: Object.fromEntries(c.req.raw.headers.entries()),
  })

  // Store provider customer mapping
  await db.insert(customerProviderIds).values({
    customerId: result.internalCustomerId,
    provider,
    providerCustomerId: result.providerCustomerId,
    projectId: result.projectId,
  }).onConflictDoUpdate(...)

  // Activate the pending subscription
  await subscriptionService.activateSubscription({
    subscriptionId: result.subscriptionId,
    paymentMethodId: result.paymentMethodId,
  })

  return c.redirect(result.successUrl)
})
```

**3. The `customer_sessions` table becomes provider-agnostic**

Instead of storing Stripe-typed JSON, store the checkout intent:

```typescript
// What the session needs to remember (provider-agnostic)
{
  customerId: string       // unprice customer ID (already created)
  subscriptionId: string   // unprice subscription ID (already created, pending)
  projectId: string
  provider: PaymentProvider
  successUrl: string
  cancelUrl: string
}
```

The provider-specific session ID (Stripe's `cs_live_xxx`, Paddle's `txn_xxx`) is ephemeral — it's only needed during the redirect flow and doesn't need to be in the schema.

**4. Provider is passed by the caller, not the plan**

```typescript
// SDK call — the integrator decides which provider to use
const result = await unprice.customers.signUp({
  planSlug: "pro",
  email: "alice@example.com",
  provider: "stripe",        // ← NEW: explicit provider choice
  successUrl: "...",
  cancelUrl: "...",
})
```

If no provider is specified, fall back to the project's default provider config. The plan doesn't care.

### How this works per provider

| Provider | setupPaymentMethod() | Callback trigger | completeSetup() |
|---|---|---|---|
| **Stripe** | `checkout.sessions.create({ mode: "setup" })` → redirect URL | Stripe redirects to callback URL | Retrieve session, extract `customerId` + payment method |
| **Paddle** | `transactions.create()` with checkout URL | Paddle redirects to callback URL OR webhook `transaction.completed` | Retrieve transaction, extract customer + payment info |
| **Crypto** | Return wallet connect params (chain, contract, amount) | Frontend calls back after wallet approval | Verify on-chain allowance/approval tx, store wallet address |
| **Sandbox** | Return `{ type: "none" }` — no setup needed | Immediate (no callback) | Auto-activate |

### Impact on existing SDK

The SDK's `signUp` method currently returns `{ url, customerId }`. With this change:

```typescript
// Current SDK response
{ success: true, url: "https://checkout.stripe.com/...", customerId: "cus_xxx" }

// New SDK response
{
  success: true,
  customerId: "cus_xxx",
  subscriptionId: "sub_xxx",
  setup: {
    required: true,
    type: "redirect",
    url: "https://checkout.stripe.com/..."   // or Paddle URL, etc.
  }
}
// OR for free plans / sandbox:
{
  success: true,
  customerId: "cus_xxx",
  subscriptionId: "sub_xxx",
  setup: { required: false }
}
```

The frontend behavior stays the same: check `setup.required`, if true redirect to `setup.url`. The difference is the subscription already exists in unprice before the redirect happens. The callback just activates it.

### Edge case: user abandons checkout

If the user redirects to Stripe but never completes, you have a `pending` subscription with no payment method. This is fine:

- A background job can clean up `pending` subscriptions older than X hours
- The customer can retry the sign-up, which finds the existing pending subscription and re-initiates setup
- No payment was collected, so there's nothing to reverse

This is actually **safer** than the current flow where if the Stripe callback fails (network error, timeout), the customer has a Stripe record but no unprice subscription.

---

## What NOT to Do

1. **Don't build a custom on-chain payment system** for crypto. Use an existing service (Circle, Coinbase Commerce, Request Network) and write a thin collector around their API. You can go custom later when volume justifies it.

2. **Don't create provider subscription objects.** You already own the lifecycle. Creating a Stripe Subscription alongside your internal one means two sources of truth that will drift. Stay invoice-only.

3. **Don't add a generic product sync system.** If Paddle needs products, that's Paddle's collector's problem. Stripe doesn't need them. Crypto definitely doesn't. Keep it as an implementation detail.

4. **Don't over-normalize webhooks.** Start with the 4-5 event types you actually need (payment succeeded/failed, payment method expired, dispute created). You can add more as needed.

5. **Don't try to abstract away currency differences** between fiat and crypto. USD cents and USDC wei are different units. Let each collector handle conversion internally. The interface works in the invoice's currency — the collector knows how to translate.

6. **Don't remove the sandbox provider.** It's valuable for testing. Just make it implement `PaymentCollector` and it becomes the reference implementation.
