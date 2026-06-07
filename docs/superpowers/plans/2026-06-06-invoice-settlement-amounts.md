# Invoice Settlement Amounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make invoice lines ledger-sourced while separating gross charge amount from settlement, so credit-line wallet usage is collectable, plan-included credits are not collectable, and purchased wallet usage can be shown as paid.

**Architecture:** Ledger entries remain the source of truth for invoice line amounts. Account names describe accounting movement, while collectability is derived from settlement metadata stamped from wallet funding attribution and billing-period context. Invoice headers replace `totalAmount` with explicit `grossAmount`, `amountDue`, `amountPaid`, and `amountIncluded` totals.

**Tech Stack:** TypeScript, Drizzle/Postgres, Zod/drizzle-zod, pgledger, Dinero, Vitest, Next.js App Router, tRPC, Hono OpenAPI, pnpm.

---

## Source Of Truth Rules

```text
invoice line amount = ledger entry amount
invoice line inclusion = statement_key + consumed account + metadata.kind + invoice_visible !== false
invoice line collectability = settlement metadata derived from wallet funding attribution
provider collection amount = invoice.amountDue
```

```text
grossAmount = amountDue + amountPaid + amountIncluded
```

Settlement classes:

```text
provider       -> due      -> collectable
credit_line    -> due      -> collectable
cash_wallet    -> paid     -> not collectable
plan_included  -> included -> not collectable
trial          -> included -> not collectable
promo          -> included -> not collectable
manual         -> included -> not collectable
```

Correctness rule: never classify a line as paid only because it came through a wallet account. A wallet can represent receivable credit, included credit, promotional credit, trial credit, manual credit, or purchased cash balance. The funding leg decides settlement.

Current product behavior:

- Credit-line wallet usage is shown as `Due - Credit line` and collected through the provider.
- Plan-included, trial, promo, and manual credit usage is shown as `Included`.
- Purchased wallet usage is shown as `Paid - Cash wallet`.
- Credit-line reservation capture remains ledger evidence and is not invoice-visible; `billPeriod` emits the collectable receivable invoice line.
- Paid and included wallet captures are invoice-visible; `billPeriod` subtracts those amounts before emitting receivable invoice lines.

## File Structure

- Create `internal/services/src/billing/invoice-settlement.ts`: settlement vocabulary, wallet funding mapping, line classification, and header summarization.
- Create `internal/services/src/billing/invoice-settlement.test.ts`: provider, credit-line, purchased wallet, included wallet, and mixed-total tests.
- Modify `internal/db/src/schema/invoices.ts`: replace `totalAmount` with `grossAmount`, `amountDue`, `amountPaid`, and `amountIncluded`.
- Modify `internal/db/src/validators/invoices.ts`: expose updated invoice select schema and settlement enum schemas used by API/tRPC.
- Modify `internal/services/src/billing/repository.ts` and `internal/services/src/billing/repository.drizzle.ts`: update invoice create/update contracts.
- Modify `internal/services/src/wallet/service.ts`: return captured funding allocations and split capture transfers by settlement class.
- Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`: pass canonical invoice metadata into wallet capture.
- Modify `internal/services/src/use-cases/billing/bill-period.ts`: subtract paid/included wallet captures, stamp due-line settlement metadata, and persist explicit totals.
- Modify `internal/services/src/ledger/gateway.ts`: project settlement fields from invoice ledger lines.
- Modify `internal/services/src/billing/service.ts`: finalize from `amountDue` and send only collectable lines to the provider.
- Modify `internal/services/src/use-cases/billing/settle-invoice.ts`: settle only `amountDue`.
- Modify invoice API/tRPC/UI surfaces:
  - `apps/api/src/routes/invoices/getInvoiceV1.ts`
  - `internal/trpc/src/router/lambda/customers/getInvoiceById.ts`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/invoice-table.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/table-invoices/columns.tsx`
- Modify tests and generated contracts that currently assert `totalAmount` or `total_amount`.

---

### Task 1: Settlement Helper And Invoice Header Schema

**Files:**
- Create: `internal/services/src/billing/invoice-settlement.ts`
- Create: `internal/services/src/billing/invoice-settlement.test.ts`
- Modify: `internal/db/src/schema/invoices.ts`
- Modify: `internal/db/src/validators/invoices.ts`
- Modify: `internal/services/src/billing/repository.ts`
- Modify: `internal/services/src/billing/repository.drizzle.ts`
- Generated by `bin/migrate.dev`: `internal/db/src/migrations/*.sql`
- Generated by `bin/migrate.dev`: `internal/db/src/migrations/meta/*.json`

- [ ] **Step 1: Add failing settlement helper tests**

Create `internal/services/src/billing/invoice-settlement.test.ts` with tests for these exact cases:

```ts
import { describe, expect, it } from "vitest"
import {
  classifyInvoiceLineSettlement,
  mapWalletFundingToSettlement,
  summarizeInvoiceSettlementAmounts,
} from "./invoice-settlement"

describe("invoice settlement", () => {
  it("classifies provider lines as due", () => {
    expect(classifyInvoiceLineSettlement({ amount: 1_000, metadata: {} })).toMatchObject({
      amountDue: 1_000,
      amountIncluded: 0,
      amountPaid: 0,
      collectable: true,
      settlementSource: "provider",
      settlementStatus: "due",
    })
  })

  it("classifies credit-line wallet funding as due", () => {
    expect(
      mapWalletFundingToSettlement({ source: "granted", grantSource: "credit_line" })
    ).toEqual({
      collectable: true,
      invoiceVisibleCapture: false,
      settlementSource: "credit_line",
      settlementStatus: "due",
    })
  })

  it("classifies purchased wallet funding as paid", () => {
    expect(mapWalletFundingToSettlement({ source: "purchased", grantSource: null })).toEqual({
      collectable: false,
      invoiceVisibleCapture: true,
      settlementSource: "cash_wallet",
      settlementStatus: "paid",
    })
  })

  it("classifies included wallet credits as included", () => {
    for (const grantSource of ["plan_included", "trial", "promo", "manual"] as const) {
      expect(mapWalletFundingToSettlement({ source: "granted", grantSource })).toEqual({
        collectable: false,
        invoiceVisibleCapture: true,
        settlementSource: grantSource,
        settlementStatus: "included",
      })
    }
  })

  it("summarizes header totals from classified lines", () => {
    expect(
      summarizeInvoiceSettlementAmounts([
        { amount: 10_000, metadata: {} },
        { amount: 4_000, metadata: { settlement_source: "credit_line" } },
        { amount: 1_500, metadata: { settlement_source: "cash_wallet" } },
        { amount: 2_500, metadata: { settlement_source: "plan_included" } },
      ])
    ).toEqual({
      amountDue: 14_000,
      amountIncluded: 2_500,
      amountPaid: 1_500,
      grossAmount: 18_000,
    })
  })
})
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/billing/invoice-settlement.test.ts
```

Expected: FAIL because `internal/services/src/billing/invoice-settlement.ts` does not exist.

- [ ] **Step 2: Implement the settlement helper**

Create `internal/services/src/billing/invoice-settlement.ts`:

```ts
export const invoiceSettlementSources = [
  "provider",
  "credit_line",
  "cash_wallet",
  "plan_included",
  "trial",
  "promo",
  "manual",
] as const

export const invoiceSettlementStatuses = ["due", "paid", "included"] as const

export type InvoiceSettlementSource = (typeof invoiceSettlementSources)[number]
export type InvoiceSettlementStatus = (typeof invoiceSettlementStatuses)[number]
export type WalletFundingSource = "granted" | "purchased"
export type WalletCreditSource = "promo" | "plan_included" | "trial" | "manual" | "credit_line"

export interface SettlementInputLine {
  amount: number
  metadata: Record<string, unknown> | null
}

export interface WalletFundingSettlementInput {
  source: WalletFundingSource
  grantSource: WalletCreditSource | null
}

export interface WalletFundingSettlement {
  collectable: boolean
  invoiceVisibleCapture: boolean
  settlementSource: InvoiceSettlementSource
  settlementStatus: InvoiceSettlementStatus
}

export interface ClassifiedInvoiceLineSettlement {
  amountDue: number
  amountIncluded: number
  amountPaid: number
  collectable: boolean
  settlementSource: InvoiceSettlementSource
  settlementStatus: InvoiceSettlementStatus
  walletCreditId: string | null
  walletCreditSource: WalletCreditSource | null
  walletId: string | null
}

const settlementSourceSet = new Set<string>(invoiceSettlementSources)
const walletCreditSourceSet = new Set<string>([
  "promo",
  "plan_included",
  "trial",
  "manual",
  "credit_line",
])

function readString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readSettlementSource(metadata: Record<string, unknown> | null): InvoiceSettlementSource {
  const value = readString(metadata, "settlement_source")
  return value && settlementSourceSet.has(value) ? (value as InvoiceSettlementSource) : "provider"
}

function readWalletCreditSource(metadata: Record<string, unknown> | null): WalletCreditSource | null {
  const value = readString(metadata, "wallet_credit_source")
  return value && walletCreditSourceSet.has(value) ? (value as WalletCreditSource) : null
}

export function mapWalletFundingToSettlement(
  input: WalletFundingSettlementInput
): WalletFundingSettlement {
  if (input.source === "purchased") {
    return {
      collectable: false,
      invoiceVisibleCapture: true,
      settlementSource: "cash_wallet",
      settlementStatus: "paid",
    }
  }

  if (input.grantSource === "credit_line") {
    return {
      collectable: true,
      invoiceVisibleCapture: false,
      settlementSource: "credit_line",
      settlementStatus: "due",
    }
  }

  return {
    collectable: false,
    invoiceVisibleCapture: true,
    settlementSource: input.grantSource ?? "manual",
    settlementStatus: "included",
  }
}

export function classifyInvoiceLineSettlement(
  input: SettlementInputLine
): ClassifiedInvoiceLineSettlement {
  const settlementSource = readSettlementSource(input.metadata)
  const settlementStatus: InvoiceSettlementStatus =
    settlementSource === "provider" || settlementSource === "credit_line"
      ? "due"
      : settlementSource === "cash_wallet"
        ? "paid"
        : "included"

  return {
    amountDue: settlementStatus === "due" ? input.amount : 0,
    amountIncluded: settlementStatus === "included" ? input.amount : 0,
    amountPaid: settlementStatus === "paid" ? input.amount : 0,
    collectable: settlementStatus === "due",
    settlementSource,
    settlementStatus,
    walletCreditId: readString(input.metadata, "wallet_credit_id"),
    walletCreditSource: readWalletCreditSource(input.metadata),
    walletId: readString(input.metadata, "wallet_id"),
  }
}

export function summarizeInvoiceSettlementAmounts(lines: readonly SettlementInputLine[]) {
  return lines.reduce(
    (totals, line) => {
      const classified = classifyInvoiceLineSettlement(line)
      return {
        amountDue: totals.amountDue + classified.amountDue,
        amountIncluded: totals.amountIncluded + classified.amountIncluded,
        amountPaid: totals.amountPaid + classified.amountPaid,
        grossAmount: totals.grossAmount + line.amount,
      }
    },
    { amountDue: 0, amountIncluded: 0, amountPaid: 0, grossAmount: 0 }
  )
}
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/billing/invoice-settlement.test.ts
```

Expected: PASS.

- [ ] **Step 3: Replace the invoice header amount columns**

Modify `internal/db/src/schema/invoices.ts`:

```ts
// Gross invoice amount at pgledger scale 8. Equals every visible invoice line.
grossAmount: bigint("gross_amount", { mode: "number" }).notNull().default(0),
// Amount still collectable through the payment provider.
amountDue: bigint("amount_due", { mode: "number" }).notNull().default(0),
// Amount already paid by purchased wallet balance.
amountPaid: bigint("amount_paid", { mode: "number" }).notNull().default(0),
// Amount covered by plan-included, trial, promo, or manual credits.
amountIncluded: bigint("amount_included", { mode: "number" }).notNull().default(0),
```

Remove:

```ts
totalAmount: bigint("total_amount", { mode: "number" }).notNull().default(0),
```

Run the repository migration generator:

```bash
bin/migrate.dev
```

Expected: a generated migration that drops `total_amount` and adds `gross_amount`, `amount_due`, `amount_paid`, and `amount_included` on `invoices`.

- [ ] **Step 4: Update invoice DB validators and repository contracts**

Move `invoiceSettlementSources` and `invoiceSettlementStatuses` from `internal/services/src/billing/invoice-settlement.ts` into `internal/db/src/validators/invoices.ts`, then export:

```ts
export const invoiceSettlementSources = [
  "provider",
  "credit_line",
  "cash_wallet",
  "plan_included",
  "trial",
  "promo",
  "manual",
] as const

export const invoiceSettlementStatuses = ["due", "paid", "included"] as const
export const invoiceSettlementSourceSchema = z.enum(invoiceSettlementSources)
export const invoiceSettlementStatusSchema = z.enum(invoiceSettlementStatuses)
```

Update `internal/services/src/billing/invoice-settlement.ts` to import those tuples from `@unprice/db/validators`. Do not import service code from `internal/db`.

Modify `internal/services/src/billing/repository.ts`:

```ts
grossAmount: number
amountDue: number
amountPaid: number
amountIncluded: number
```

Remove `totalAmount` from `CreateInvoiceInput`, `SubscriptionInvoice`, and `UpdateInvoiceInput["data"]`.

Modify `internal/services/src/billing/repository.drizzle.ts` so create/update/read paths use the four new fields.

Run:

```bash
pnpm --filter @unprice/services typecheck
```

Expected: remaining failures are references to `totalAmount` in billing service, billing use cases, tests, API, tRPC, UI, and payment-provider item construction. Those are handled in Tasks 2-4.

- [ ] **Step 5: Commit Task 1**

```bash
git add internal/services/src/billing/invoice-settlement.ts internal/services/src/billing/invoice-settlement.test.ts internal/db/src/schema/invoices.ts internal/db/src/validators/invoices.ts internal/services/src/billing/repository.ts internal/services/src/billing/repository.drizzle.ts internal/db/src/migrations internal/db/src/migrations/meta
git commit -m "feat: add invoice settlement totals"
```

---

### Task 2: Wallet Funding Attribution And Period Billing

**Files:**
- Modify: `internal/services/src/wallet/service.ts`
- Modify: `internal/services/src/wallet/service.test.ts`
- Modify: `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts`
- Modify: `internal/services/src/use-cases/billing/bill-period.ts`
- Modify: `internal/services/src/use-cases/billing/bill-period.test.ts`
- Modify: `internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts`

- [ ] **Step 1: Add wallet capture attribution tests**

Extend `internal/services/src/wallet/service.test.ts` with a capture test that seeds one reservation with these funding legs:

```ts
[
  { source: "granted", amount: 3 * DOLLAR, grantSource: "plan_included", walletCreditId: "wcr_plan" },
  { source: "granted", amount: 4 * DOLLAR, grantSource: "credit_line", walletCreditId: "wcr_credit" },
  { source: "purchased", amount: 2 * DOLLAR },
]
```

Capture `9 * DOLLAR` and assert three ledger transfers are written:

```ts
expect(transfers.map((transfer) => transfer.metadata)).toMatchObject([
  {
    settlement_source: "plan_included",
    settlement_status: "included",
    collectable: false,
    invoice_visible: true,
    wallet_credit_id: "wcr_plan",
    wallet_credit_source: "plan_included",
  },
  {
    settlement_source: "credit_line",
    settlement_status: "due",
    collectable: true,
    invoice_visible: false,
    wallet_credit_id: "wcr_credit",
    wallet_credit_source: "credit_line",
  },
  {
    settlement_source: "cash_wallet",
    settlement_status: "paid",
    collectable: false,
    invoice_visible: true,
  },
])
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/wallet/service.test.ts
```

Expected: FAIL because capture currently writes one transfer without settlement metadata.

- [ ] **Step 2: Return captured funding allocations from wallet capture**

Modify the private funding capture path in `internal/services/src/wallet/service.ts` so the method that updates `entitlement_reservation_funding_legs.capturedAmount` returns:

```ts
type CapturedReservationFundingAllocation = {
  amount: number
  fundingLegId: string
  grantSource: WalletCreditSource | null
  source: "granted" | "purchased"
  walletCreditId: string | null
}
```

Then change `captureReservationUsage` to group those allocations by:

```ts
`${settlement.settlementSource}:${allocation.walletCreditId ?? "wallet"}`
```

For each group, call `ledger.createTransfer` with the grouped amount and metadata:

```ts
const settlement = mapWalletFundingToSettlement({
  source: allocation.source,
  grantSource: allocation.grantSource,
})

const invoiceMetadata =
  settlement.invoiceVisibleCapture && input.billingPeriodId
    ? {
        billing_period_id: input.billingPeriodId,
        invoice_visible: true,
        kind: input.kind ?? "usage",
        statement_key: input.statementKey,
      }
    : { invoice_visible: false }

metadata: {
  ...input.metadata,
  ...invoiceMetadata,
  collectable: settlement.collectable,
  reservation_id: input.reservationId,
  settlement_source: settlement.settlementSource,
  settlement_status: settlement.settlementStatus,
  wallet_credit_id: allocation.walletCreditId,
  wallet_credit_source: allocation.grantSource,
}
```

Keep the transfer path `customer.reserved -> customer.consumed`. Use source ids shaped as:

```ts
`capture:${input.reservationId}:${input.flushSeq}:${settlement.settlementSource}:${allocation.walletCreditId ?? "wallet"}`
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/wallet/service.test.ts
```

Expected: PASS for existing reservation tests and the new split-capture test.

- [ ] **Step 3: Pass canonical invoice metadata from the entitlement window**

Modify `apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts` so every final or refill wallet capture passes these fields to `walletService.captureReservationUsage`:

```ts
{
  billingPeriodId: window.billingPeriodId,
  kind: "usage",
  metadata: {
    billing_period_id: window.billingPeriodId,
    feature_plan_version_item_id: window.featurePlanVersionItemId,
    source_id: `${window.billingPeriodId}:${window.featurePlanVersionItemId}`,
  },
  sourceId: `${window.billingPeriodId}:${window.featurePlanVersionItemId}`,
  statementKey: window.statementKey,
}
```

Keep `durable_object_id`, `reservation_id`, and flush metadata in the same metadata object.

Run:

```bash
pnpm --filter api type-check
```

Expected: PASS for the API package, or type errors naming the exact window fields that need to be threaded from the entitlement snapshot into capture.

- [ ] **Step 4: Make `billPeriod` subtract paid and included wallet captures**

Modify `internal/services/src/use-cases/billing/bill-period.ts` so each rated usage charge calculates:

```ts
const walletSettlementForItem = await ledger.getInvoiceLines({
  projectId: phase.projectId,
  statementKey: periodItemGroup.statementKey,
})

const paidOrIncludedForItem = walletSettlementForItem.val.filter((line) => {
  const metadata = line.metadata ?? {}
  return (
    metadata.billing_period_id === period.id &&
    metadata.feature_plan_version_item_id === item.id &&
    (metadata.settlement_status === "paid" || metadata.settlement_status === "included")
  )
})

const coveredAmount = paidOrIncludedForItem.reduce((sum, line) => sum + toLedgerMinor(line.amount), 0)
const collectableAmount = Math.max(0, toLedgerMinor(charge.amount) - coveredAmount)
```

Emit the existing `receivable -> consumed` transfer only when `collectableAmount > 0`. Stamp the receivable transfer with:

```ts
{
  billing_period_id: period.id,
  collectable: true,
  feature_plan_version_item_id: item.id,
  kind: charge.kind,
  settlement_source: periodItemGroup.creditLinePolicy === "capped" ? "credit_line" : "provider",
  settlement_status: "due",
  source_id: `${period.id}:${item.id}`,
  statement_key: periodItemGroup.statementKey,
}
```

After invoice-visible lines are loaded, replace the old total update with:

```ts
const totals = summarizeInvoiceSettlementAmounts(
  linesToInvoice.map((line) => ({
    amount: toLedgerMinor(line.amount),
    metadata: line.metadata,
  }))
)

await txBillingRepo.updateInvoice({
  invoiceId: invoice.id,
  projectId: phase.projectId,
  data: {
    amountDue: totals.amountDue,
    amountIncluded: totals.amountIncluded,
    amountPaid: totals.amountPaid,
    grossAmount: totals.grossAmount,
    updatedAtM: now,
  },
})
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/use-cases/billing/bill-period.test.ts
```

Expected: PASS after replacing `totalAmount` expectations with settlement totals.

- [ ] **Step 5: Add the capped arrears regression**

Modify `internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts` so the existing credit-line scenario expects:

```ts
expect(invoice).toMatchObject({
  amount_due: invoiceAmount,
  amount_included: 0,
  amount_paid: 0,
  gross_amount: invoiceAmount,
})
```

Add a second scenario with a `plan_included` grant covering usage and assert:

```ts
expect(invoice).toMatchObject({
  amount_due: fixedAmount,
  amount_included: usageAmount,
  amount_paid: 0,
  gross_amount: fixedAmount + usageAmount,
})
```

Assert the usage line has:

```ts
expect(usageLine).toMatchObject({
  collectable: false,
  settlementSource: "plan_included",
  settlementStatus: "included",
})
```

Run:

```bash
NODE_ENV=test SKIP_ENV_VALIDATION=true APP_ENV=test pnpm --filter @unprice/services exec vitest run --config vitest.integration.config.ts src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add internal/services/src/wallet/service.ts internal/services/src/wallet/service.test.ts apps/api/src/ingestion/entitlements/EntitlementWindowDO.ts internal/services/src/use-cases/billing/bill-period.ts internal/services/src/use-cases/billing/bill-period.test.ts internal/services/src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts
git commit -m "feat: attribute wallet usage settlement"
```

---

### Task 3: Invoice Projection, Finalization, API, And UI

**Files:**
- Modify: `internal/services/src/ledger/gateway.ts`
- Modify: `internal/services/src/billing/service.ts`
- Modify: `internal/services/src/billing/service.finalize.test.ts`
- Modify: `internal/services/src/use-cases/billing/settle-invoice.ts`
- Modify: `internal/services/src/use-cases/billing/settle-invoice.test.ts`
- Modify: `apps/api/src/routes/invoices/getInvoiceV1.ts`
- Modify: `internal/trpc/src/router/lambda/customers/getInvoiceById.ts`
- Modify: `packages/api/src/client.test.ts`
- Generated by package scripts: `packages/api/src/openapi.d.ts`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/invoice-table.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/table-invoices/columns.tsx`

- [ ] **Step 1: Project settlement fields from ledger invoice lines**

Modify `internal/services/src/ledger/gateway.ts` `InvoiceLine`:

```ts
amountDue: number
amountIncluded: number
amountPaid: number
collectable: boolean
settlementSource: InvoiceSettlementSource
settlementStatus: InvoiceSettlementStatus
walletCreditId: string | null
walletCreditSource: WalletCreditSource | null
walletId: string | null
```

Modify `toInvoiceLine`:

```ts
const settlement = classifyInvoiceLineSettlement({
  amount: toLedgerMinor(amount),
  metadata,
})

return {
  ...existingLineFields,
  ...settlement,
}
```

Modify the `getInvoiceLines` query predicate so invoice lines require:

```sql
e.metadata->>'kind' IS NOT NULL
AND COALESCE((e.metadata->>'invoice_visible')::boolean, true) = true
```

Run:

```bash
pnpm --filter @unprice/services typecheck
```

Expected: type errors remain only where invoice line callers have not consumed the new fields.

- [ ] **Step 2: Finalize and provider-sync from `amountDue`**

Modify `internal/services/src/billing/service.ts`:

```ts
const skipProvider = lockedInvoiceData.amountDue === 0
```

In `_finalizeInvoice`, replace the old status decision:

```ts
const statusInvoice =
  invoice.grossAmount === 0 ? ("void" as const) : invoice.amountDue === 0 ? ("paid" as const) : ("unpaid" as const)
```

In `_upsertPaymentProviderInvoice`, filter:

```ts
const collectableLines = lines.filter((line) => line.collectable && line.amountDue > 0)
```

Return the existing "No ledger lines" integrity error when `invoice.amountDue > 0` and `collectableLines.length === 0`.

Build provider invoice items from `collectableLines`. Collectable lines are split before projection, so `line.amountDue` equals the ledger line amount for those lines. Keep the existing `formatAmountForProvider(line.amount)` conversion and preserve settlement context in metadata:

```ts
metadata: {
  ...existingMetadata,
  gross_amount: toLedgerMinor(line.amount),
  settlement_source: line.settlementSource,
  settlement_status: line.settlementStatus,
}
```

Modify `internal/services/src/billing/service.finalize.test.ts`:

```ts
it("paid or included invoice finalizes locally as paid without provider work", async () => {
  const invoice = makeInvoice({ amountDue: 0, amountIncluded: 1_000, amountPaid: 0, grossAmount: 1_000 })
  // assert no provider create/finalize call and updated status paid
})
```

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/billing/service.finalize.test.ts
```

Expected: PASS.

- [ ] **Step 3: Settle only provider-collectable amount**

Modify `internal/services/src/use-cases/billing/settle-invoice.ts`:

```ts
if (invoice.amountDue <= 0) {
  return Ok(undefined)
}

paidAmount: invoice.amountDue
```

Modify `internal/services/src/use-cases/billing/settle-invoice.test.ts`:

```ts
const invoice = makeInvoice({
  amountDue: 50_000_000,
  amountIncluded: 10_000_000,
  amountPaid: 5_000_000,
  grossAmount: 65_000_000,
})
```

Assert the settlement transfer amount is `50_000_000`.

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/use-cases/billing/settle-invoice.test.ts
```

Expected: PASS.

- [ ] **Step 4: Expose settlement totals and line fields through API and tRPC**

Modify `apps/api/src/routes/invoices/getInvoiceV1.ts` response schema:

```ts
gross_amount: z.number().int().nonnegative(),
amount_due: z.number().int().nonnegative(),
amount_paid: z.number().int().nonnegative(),
amount_included: z.number().int().nonnegative(),
```

Add line fields:

```ts
amount_due: z.number().int().nonnegative(),
amount_paid: z.number().int().nonnegative(),
amount_included: z.number().int().nonnegative(),
collectable: z.boolean(),
settlement_source: invoiceSettlementSourceSchema,
settlement_status: invoiceSettlementStatusSchema,
wallet_credit_id: z.string().nullable(),
wallet_credit_source: z.enum(["promo", "plan_included", "trial", "manual", "credit_line"]).nullable(),
wallet_id: z.string().nullable(),
```

Modify `internal/trpc/src/router/lambda/customers/getInvoiceById.ts` with camelCase equivalents:

```ts
grossAmount: invoice.grossAmount,
amountDue: invoice.amountDue,
amountPaid: invoice.amountPaid,
amountIncluded: invoice.amountIncluded,
```

For lines:

```ts
amountDue: line.amountDue,
amountPaid: line.amountPaid,
amountIncluded: line.amountIncluded,
collectable: line.collectable,
settlementSource: line.settlementSource,
settlementStatus: line.settlementStatus,
walletCreditId: line.walletCreditId,
walletCreditSource: line.walletCreditSource,
walletId: line.walletId,
```

Run:

```bash
pnpm --filter api type-check
pnpm --filter @unprice/trpc typecheck
```

Expected: PASS.

- [ ] **Step 5: Update SDK contract and invoice UI**

From `packages/api`, run:

```bash
pnpm generate
pnpm build
```

Modify `packages/api/src/client.test.ts` to expect `gross_amount`, `amount_due`, `amount_paid`, and `amount_included`.

Modify `invoice-table.tsx` so the summary shows:

```tsx
<span>{formatLedger(invoice.grossAmount)}</span>
<span>{formatLedger(invoice.amountPaid)}</span>
<span>{formatLedger(invoice.amountIncluded)}</span>
<span className="font-bold text-xl">{formatLedger(invoice.amountDue)}</span>
```

Modify `table-invoices/columns.tsx` so the amount column sorts and displays `row.original.amountDue`.

Add a line status/source column in `invoice-table.tsx`:

```tsx
<Badge variant={line.settlementStatus === "due" ? "default" : "secondary"}>
  {line.settlementStatus === "due"
    ? line.settlementSource === "credit_line"
      ? "Due - Credit line"
      : "Due - Provider"
    : line.settlementStatus === "paid"
      ? "Paid - Cash wallet"
      : `Included - ${line.settlementSource.replace("_", " ")}`}
</Badge>
```

Run:

```bash
pnpm --filter @unprice/api build
pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add internal/services/src/ledger/gateway.ts internal/services/src/billing/service.ts internal/services/src/billing/service.finalize.test.ts internal/services/src/use-cases/billing/settle-invoice.ts internal/services/src/use-cases/billing/settle-invoice.test.ts apps/api/src/routes/invoices/getInvoiceV1.ts internal/trpc/src/router/lambda/customers/getInvoiceById.ts packages/api/src/client.test.ts packages/api/src/openapi.d.ts apps/nextjs/src/app/\\(root\\)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/invoice-table.tsx apps/nextjs/src/app/\\(root\\)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/table-invoices/columns.tsx
git commit -m "feat: expose invoice settlement amounts"
```

---

### Task 4: Full Regression Sweep And Durable Repo Memory

**Files:**
- Modify: every remaining `totalAmount` or `total_amount` invoice reference found by the search command in this task.
- Modify: `internal/services/src/test-fixtures/factories.ts`
- Modify: billing and payment scenario tests under `internal/services/src/tests/**`
- Modify: payment provider tests under `internal/services/src/payment-provider/**`
- Modify: `lessons.md`

- [ ] **Step 1: Replace remaining invoice total references**

Run:

```bash
rg -n "totalAmount|total_amount" internal/services apps packages internal/db -g '*.ts' -g '*.tsx'
```

For invoice header rows, replace:

```ts
totalAmount
```

with:

```ts
grossAmount
amountDue
amountPaid
amountIncluded
```

For public API JSON, replace:

```ts
total_amount
```

with:

```ts
gross_amount
amount_due
amount_paid
amount_included
```

Keep Tinybird analytics `total_amount` fields in `explain-charge` because those are usage aggregation amounts, not invoice header totals.

Run the search again.

Expected: the only remaining matches are non-invoice analytics or payment-provider line item fields where `totalAmount` still means a provider item amount.

- [ ] **Step 2: Update scenario fixtures and assertions**

Modify `internal/services/src/test-fixtures/factories.ts` default invoices:

```ts
grossAmount: 0,
amountDue: 0,
amountPaid: 0,
amountIncluded: 0,
```

Update invoice SQL projections in billing scenario tests from:

```sql
SELECT id, status, total_amount, statement_key
```

to:

```sql
SELECT id, status, gross_amount, amount_due, amount_paid, amount_included, statement_key
```

For ordinary provider-only invoices, assert:

```ts
expect(invoice).toMatchObject({
  amount_due: expectedTotalAmount,
  amount_included: 0,
  amount_paid: 0,
  gross_amount: expectedTotalAmount,
})
```

For paid/included wallet scenarios, assert the bucket that matches the wallet funding source.

- [ ] **Step 3: Run targeted service verification**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/billing/invoice-settlement.test.ts src/use-cases/billing/bill-period.test.ts src/billing/service.finalize.test.ts src/use-cases/billing/settle-invoice.test.ts src/wallet/service.test.ts
```

Expected: PASS.

Run:

```bash
NODE_ENV=test SKIP_ENV_VALIDATION=true APP_ENV=test pnpm --filter @unprice/services exec vitest run --config vitest.integration.config.ts src/tests/billing-scenarios/pay-in-arrear-capped-wallet.integration.test.ts src/tests/billing-scenarios/golden-cases-db.integration.test.ts src/tests/payment-scenarios/paid-invoice-lifecycle.integration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run package typechecks and full validation**

Run:

```bash
pnpm --filter @unprice/services typecheck
pnpm --filter @unprice/trpc typecheck
pnpm --filter api type-check
pnpm --filter nextjs typecheck
pnpm validate
```

Expected: PASS for every command.

- [ ] **Step 5: Add durable repo memory**

Add this entry to `lessons.md` under `## Billing, Wallets, And Invoices`:

```markdown
- 2026-06-06: Invoice headers store `grossAmount`, `amountDue`, `amountPaid`, and
  `amountIncluded`; ledger lines remain the invoice source of truth, and
  collectability comes from settlement metadata derived from wallet funding legs.
```

- [ ] **Step 6: Commit Task 4**

```bash
git add internal/services apps packages internal/db lessons.md
git commit -m "test: update invoice settlement regressions"
```
