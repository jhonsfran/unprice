 Industry vocabulary (BSS/billing pipelines)

  Stripe Billing, Lago, Orb, Metronome, AWS, OpenAI all use variants of the same six-phase loop:

  PROVISION → METER → RATE → RESERVE/DRAW → BILL → SETTLE → (RENEW)

  Different products skip different phases:
  - Stripe Billing (postpaid SaaS): skips RESERVE/DRAW (no wallet), bills monthly
  - AWS / GCP: heavy on METER, monthly BILL, "credits" are pre-applied at BILL
  - OpenAI / Anthropic API (prepaid wallet): skips BILL/SETTLE entirely — RESERVE/DRAW is the whole thing
  - Telco prepaid (the original wallet model): same as OpenAI plus auto-RENEW from card on threshold
  - Cloudflare / Vercel: hybrid — flat BILL + usage RESERVE/DRAW with monthly RECONCILE

  The accounts you already have map cleanly onto this. The trick is to make every billing mode (current arrears, current advance, future wallet-only) a
  subset of the same pipeline — so the system is one machine with optional phases, not three machines.

  The meta-flow (one machine, six phases)

     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          PROVISION                                      │
     │  Set up entitlements + issue grants for the period.                     │
     │                                                                         │
     │   funding.{credit_line|plan_credit|promo|trial}                         │
     │           │                                                             │
     │           └────► customer.available.granted   (wallet_grants row,       │
     │                                                expires periodEndAt)     │
     │                                                                         │
     │  Today: activateSubscription. Wallet-only future: same call, may also   │
     │  require an existing customer.available.purchased balance > 0.          │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          METER                                          │
     │  Customer does work. Events arrive at the EntitlementWindowDO.          │
     │  No ledger writes — just durable event buffering.                       │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          RATE                                           │
     │  Price each event using the plan's feature config.                      │
     │  Pure function: events × feature → priced quantity.                     │
     │  No ledger writes — produces a number the next phase reserves.          │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          RESERVE / DRAW                                 │
     │  Hold funds against the customer's wallet for in-flight usage.          │
     │                                                                         │
     │   reserve:                                                              │
     │     customer.available.granted   ──┐                                    │
     │                                    ├──► customer.reserved   (FIFO)      │
     │     customer.available.purchased ──┘                                    │
     │                                                                         │
     │   flush:                                                                │
     │     customer.reserved ──────────────► customer.consumed                 │
     │                                                                         │
     │   refund leftover (period close or reservation shrink):                 │
     │     customer.reserved ──────────────► customer.available.purchased      │
     │                                                                         │
     │  Identical for ALL modes. Wallet-only mode lives almost entirely here.  │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          BILL                                           │
     │  Aggregate the period into an invoice + post the IOU.                   │
     │                                                                         │
     │   customer.receivable ────────────────► customer.consumed               │
     │                  (totalAmount = flat + arrears-usage portions)          │
     │                                                                         │
     │  Triggered:                                                             │
     │    pay_in_advance  → at period START (flat for upcoming period)         │
     │    pay_in_arrear   → at period END   (flat + actual usage)              │
     │    wallet-only     → SKIPPED (no invoice — DRAW is the charge)          │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          SETTLE                                         │
     │  Customer payment clears the IOU.                                       │
     │                                                                         │
     │   funding.topup ──────────────────────► customer.receivable             │
     │                  (paidAmount)                                           │
     │                                                                         │
     │  Triggered: webhook (Stripe) or sync (Sandbox) post-charge.             │
     │  Wallet-only: SKIPPED. Wallet TOP-UP is a different flow:               │
     │      funding.topup ────► customer.available.purchased                   │
     └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
     ┌─────────────────────────────────────────────────────────────────────────┐
     │                          RENEW                                          │
     │  Period rolls over → back to PROVISION.                                 │
     │   - Issue next period's grants                                          │
     │   - Expire stale grants (granted balance burned, wallet_grants closed)  │
     │   - Auto-topup wallet if configured (wallet-only mode)                  │
     └─────────────────────────────────────────────────────────────────────────┘

How the three modes project onto the meta-flow

                  PROVISION   METER   RATE   RESERVE/DRAW   BILL              SETTLE      RENEW
                  ─────────   ─────   ────   ────────────   ──────────────    ─────────   ─────
   pay_in_arrear   ✓ (grants)  ✓       ✓      ✓              ✓ end-of-period   ✓           ✓
   pay_in_advance  ✓ (grants)  ✓       ✓      ✓              ✓ start-of-period ✓           ✓
   wallet-only     ✓ (grants   ✓       ✓      ✓ ←the whole   ✗ skipped         ✗ skipped   ✓ auto
                     optional)                  show                                          topup
