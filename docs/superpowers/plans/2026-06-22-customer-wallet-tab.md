# Customer Wallet Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a customer Wallet dashboard tab that shows the customer's wallet balances and active wallet credits with amounts.

**Architecture:** `WalletService.getWalletState` already owns the read model for ledger balances and active `wallet_credits`, so the dashboard must reuse it instead of querying wallet tables directly. Add one small service-layer use case that verifies the customer belongs to the active project, then expose it through `customers.getWallet` in tRPC. The Next.js page follows the existing route-per-tab customer pages used by Overview, Subscriptions, Invoices, and Runs.

**Tech Stack:** TypeScript, Zod, Result/Ok/Err, tRPC protected project procedures, Next.js App Router, TanStack DataTable, shadcn/ui components, `@unprice/money`.

---

## Scope Cuts

- Do not add a wallet top-up action to this tab.
- Do not change the public `/v1/wallet/balance` API or generated SDK.
- Do not add a database migration.
- Do not query pgledger or `wallet_credits` from the Next.js page or tRPC route.
- Do not introduce server-side pagination for wallet credits. `WalletService.getWalletState` returns active credits only, and the page can use the existing client-side DataTable pagination/filtering.
- Do not refactor all customer tab navigation into a shared component in this plan. Add the Wallet link to the existing tab blocks to keep the change narrow.
- Do not show expired or voided wallet credits. The existing wallet service intentionally filters to active credits with `remaining_amount > 0`.

## File Structure

**Service use case**
- Create: `internal/services/src/use-cases/wallet/get-customer-wallet.ts`
  - Verifies the customer belongs to the project.
  - Reads wallet state through `services.wallet.getWalletState`.
  - Returns the customer, customer default currency, ledger balances, and active wallet credits.
- Create: `internal/services/src/use-cases/wallet/get-customer-wallet.test.ts`
  - Unit-tests success, not-found, and wallet error behavior.
- Modify: `internal/services/src/use-cases/index.ts`
  - Export the use case and schemas.

**tRPC route**
- Create: `internal/trpc/src/router/lambda/customers/getWallet.ts`
  - Protected project procedure.
  - Calls the service use case.
  - Maps use-case errors to `TRPCError`.
- Modify: `internal/trpc/src/router/lambda/customers/index.ts`
  - Add `getWallet` to the `customers` router.

**Next.js customer wallet tab**
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/format-wallet-money.ts`
  - Formats ledger-scale wallet amounts for display.
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/wallet-balance-summary.tsx`
  - Displays available, purchased, granted, held, and consumed balances.
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/table-wallet-credits/columns.tsx`
  - Defines active wallet credit table columns.
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`
  - New customer Wallet tab page.
- Modify:
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx`
  - Add the Wallet tab link.

## Task 1: Add The Customer Wallet Use Case

**Files:**
- Create: `internal/services/src/use-cases/wallet/get-customer-wallet.test.ts`
- Create: `internal/services/src/use-cases/wallet/get-customer-wallet.ts`
- Modify: `internal/services/src/use-cases/index.ts`

- [ ] **Step 1: Write the failing use-case test**

Create `internal/services/src/use-cases/wallet/get-customer-wallet.test.ts`:

```ts
import type { CustomerService } from "../../customers/service"
import type { WalletService, WalletStateOutput } from "../../wallet"
import { UnPriceWalletError } from "../../wallet"
import { FetchError, Ok, Err } from "@unprice/error"
import type { Customer, WalletCredit } from "@unprice/db/validators"
import { describe, expect, it, vi } from "vitest"
import { getCustomerWallet } from "./get-customer-wallet"

describe("getCustomerWallet", () => {
  it("returns the project customer with wallet balances and active credits", async () => {
    const customer = createCustomer()
    const walletState = createWalletState()
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(customer)),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Ok(walletState)),
    }
    const logger = { set: vi.fn() }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: logger as never,
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toMatchObject({
      customer: {
        id: "cus_123",
        projectId: "proj_123",
        defaultCurrency: "USD",
      },
      wallet: {
        currency: "USD",
        balances: {
          purchased: 1_000_000_000,
          granted: 500_000_000,
          reserved: 250_000_000,
          consumed: 2_000_000_000,
        },
      },
    })
    expect(result.val?.wallet.credits.map((credit) => credit.id)).toEqual(["wcr_123"])
    expect(wallet.getWalletState).toHaveBeenCalledWith({
      projectId: "proj_123",
      customerId: "cus_123",
    })
    expect(logger.set).toHaveBeenCalledWith({
      business: {
        operation: "wallet.get_customer_wallet",
        project_id: "proj_123",
        customer_id: "cus_123",
      },
    })
  })

  it("returns null when the customer is not in the project", async () => {
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(null)),
    }
    const wallet = {
      getWalletState: vi.fn(),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: { set: vi.fn() } as never,
      },
      {
        projectId: "proj_123",
        customerId: "cus_missing",
      }
    )

    expect(result.err).toBeUndefined()
    expect(result.val).toBeNull()
    expect(wallet.getWalletState).not.toHaveBeenCalled()
  })

  it("returns the customer service error without reading the wallet", async () => {
    const customerError = new FetchError({
      message: "customer query failed",
      retry: false,
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Err(customerError)),
    }
    const wallet = {
      getWalletState: vi.fn(),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: { set: vi.fn() } as never,
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBe(customerError)
    expect(wallet.getWalletState).not.toHaveBeenCalled()
  })

  it("returns the wallet service error", async () => {
    const walletError = new UnPriceWalletError({
      message: "WALLET_LEDGER_FAILED",
    })
    const customers = {
      getCustomerByIdInProject: vi.fn().mockResolvedValue(Ok(createCustomer())),
    }
    const wallet = {
      getWalletState: vi.fn().mockResolvedValue(Err(walletError)),
    }

    const result = await getCustomerWallet(
      {
        services: {
          customers: customers as unknown as CustomerService,
          wallet: wallet as unknown as WalletService,
        },
        logger: { set: vi.fn() } as never,
      },
      {
        projectId: "proj_123",
        customerId: "cus_123",
      }
    )

    expect(result.err).toBe(walletError)
  })
})

function createCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "cus_123",
    projectId: "proj_123",
    email: "billing@example.com",
    name: "Example Customer",
    description: "Customer with wallet credits",
    externalId: null,
    metadata: {},
    active: true,
    isMain: false,
    defaultCurrency: "USD",
    timezone: "UTC",
    createdAtM: 1_720_000_000_000,
    updatedAtM: 1_720_000_000_000,
    ...overrides,
  } as Customer
}

function createWalletCredit(overrides: Partial<WalletCredit> = {}): WalletCredit {
  return {
    id: "wcr_123",
    projectId: "proj_123",
    customerId: "cus_123",
    source: "manual",
    issuedAmount: 500_000_000,
    remainingAmount: 300_000_000,
    expiresAt: null,
    expiredAt: null,
    voidedAt: null,
    ledgerTransferId: "pgle_123",
    metadata: null,
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    ...overrides,
  } as WalletCredit
}

function createWalletState(): WalletStateOutput {
  return {
    balances: {
      purchased: 1_000_000_000,
      granted: 500_000_000,
      reserved: 250_000_000,
      consumed: 2_000_000_000,
    },
    credits: [createWalletCredit()],
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/use-cases/wallet/get-customer-wallet.test.ts
```

Expected: FAIL with a TypeScript/module error because `./get-customer-wallet` does not exist.

- [ ] **Step 3: Write the use-case implementation**

Create `internal/services/src/use-cases/wallet/get-customer-wallet.ts`:

```ts
import {
  currencySchema,
  customerSelectSchema,
  walletCreditSelectSchema,
} from "@unprice/db/validators"
import { Err, Ok, type Result } from "@unprice/error"
import type { FetchError } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"
import type { ServiceContext } from "../../context"
import type { UnPriceWalletError } from "../../wallet"

export const getCustomerWalletInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const customerWalletBalancesSchema = z.object({
  purchased: z.number().int(),
  granted: z.number().int(),
  reserved: z.number().int(),
  consumed: z.number().int(),
})

export const getCustomerWalletOutputSchema = z.object({
  customer: customerSelectSchema,
  wallet: z.object({
    currency: currencySchema,
    balances: customerWalletBalancesSchema,
    credits: walletCreditSelectSchema.array(),
  }),
})

export type GetCustomerWalletInput = z.infer<typeof getCustomerWalletInputSchema>
export type GetCustomerWalletOutput = z.infer<typeof getCustomerWalletOutputSchema>

export type GetCustomerWalletDeps = {
  services: Pick<ServiceContext, "customers" | "wallet">
  logger: Logger
}

export async function getCustomerWallet(
  deps: GetCustomerWalletDeps,
  rawInput: GetCustomerWalletInput
): Promise<Result<GetCustomerWalletOutput | null, FetchError | UnPriceWalletError>> {
  const input = getCustomerWalletInputSchema.parse(rawInput)

  deps.logger.set({
    business: {
      operation: "wallet.get_customer_wallet",
      project_id: input.projectId,
      customer_id: input.customerId,
    },
  })

  const customerResult = await deps.services.customers.getCustomerByIdInProject({
    id: input.customerId,
    projectId: input.projectId,
  })

  if (customerResult.err) {
    return Err(customerResult.err)
  }

  if (!customerResult.val) {
    return Ok(null)
  }

  const walletResult = await deps.services.wallet.getWalletState({
    projectId: input.projectId,
    customerId: input.customerId,
  })

  if (walletResult.err) {
    return Err(walletResult.err)
  }

  return Ok(
    getCustomerWalletOutputSchema.parse({
      customer: customerResult.val,
      wallet: {
        currency: customerResult.val.defaultCurrency,
        balances: walletResult.val.balances,
        credits: walletResult.val.credits,
      },
    })
  )
}
```

Modify `internal/services/src/use-cases/index.ts` and add this export near the other wallet use-case exports:

```ts
export {
  getCustomerWallet,
  getCustomerWalletInputSchema,
  getCustomerWalletOutputSchema,
  customerWalletBalancesSchema,
} from "./wallet/get-customer-wallet"
export type {
  GetCustomerWalletDeps,
  GetCustomerWalletInput,
  GetCustomerWalletOutput,
} from "./wallet/get-customer-wallet"
```

- [ ] **Step 4: Run the use-case test to verify it passes**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/use-cases/wallet/get-customer-wallet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the service package typecheck**

Run:

```bash
pnpm --filter @unprice/services typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the service use case**

Run:

```bash
git add internal/services/src/use-cases/wallet/get-customer-wallet.ts internal/services/src/use-cases/wallet/get-customer-wallet.test.ts internal/services/src/use-cases/index.ts
git commit -m "feat: add customer wallet use case"
```

Expected: commit succeeds with only the service use-case files staged.

## Task 2: Expose The Wallet Read Through Customers tRPC

**Files:**
- Create: `internal/trpc/src/router/lambda/customers/getWallet.ts`
- Modify: `internal/trpc/src/router/lambda/customers/index.ts`

- [ ] **Step 1: Wire the missing route into the router first**

Modify `internal/trpc/src/router/lambda/customers/index.ts`:

```ts
import { createTRPCRouter } from "#trpc"
import { create } from "./create"
import { exist } from "./exist"
import { getByEmail } from "./getByEmail"
import { getById } from "./getById"
import { getByIdActiveProject } from "./getByIdActiveProject"
import { getEntitlements } from "./getEntitlements"
import { getInvoiceById } from "./getInvoiceById"
import { getInvoices } from "./getInvoices"
import { getRuns } from "./getRuns"
import { getSubscription } from "./getSubscription"
import { getSubscriptions } from "./getSubscriptions"
import { getWallet } from "./getWallet"
import { listByActiveProject } from "./listByActiveProject"
import { remove } from "./remove"
import { update } from "./update"

export const customersRouter = createTRPCRouter({
  create: create,
  remove: remove,
  update: update,
  exist: exist,
  getByEmail: getByEmail,
  getById: getById,
  getByIdActiveProject: getByIdActiveProject,
  getEntitlements: getEntitlements,
  getSubscription: getSubscription,
  getSubscriptions: getSubscriptions,
  listByActiveProject: listByActiveProject,
  getInvoices: getInvoices,
  getRuns: getRuns,
  getWallet: getWallet,
  getInvoiceById: getInvoiceById,
})
```

- [ ] **Step 2: Run the tRPC typecheck to verify it fails**

Run:

```bash
pnpm --filter @unprice/trpc typecheck
```

Expected: FAIL with `Cannot find module './getWallet'`.

- [ ] **Step 3: Create the tRPC procedure**

Create `internal/trpc/src/router/lambda/customers/getWallet.ts`:

```ts
import { TRPCError } from "@trpc/server"
import { getCustomerWallet, getCustomerWalletOutputSchema } from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getWallet = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getCustomerWalletOutputSchema)
  .query(async (opts) => {
    const { customerId } = opts.input
    const { project } = opts.ctx

    const { err, val } = await getCustomerWallet(
      {
        services: {
          customers: opts.ctx.services.customers,
          wallet: opts.ctx.services.wallet,
        },
        logger: opts.ctx.logger,
      },
      {
        projectId: project.id,
        customerId,
      }
    )

    if (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err.message,
      })
    }

    if (!val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return getCustomerWalletOutputSchema.parse(val)
  })
```

- [ ] **Step 4: Run the tRPC typecheck to verify it passes**

Run:

```bash
pnpm --filter @unprice/trpc typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the tRPC route**

Run:

```bash
git add internal/trpc/src/router/lambda/customers/getWallet.ts internal/trpc/src/router/lambda/customers/index.ts
git commit -m "feat: expose customer wallet through trpc"
```

Expected: commit succeeds with only the tRPC route files staged.

## Task 3: Add Wallet UI Components

**Files:**
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/format-wallet-money.ts`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/wallet-balance-summary.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/table-wallet-credits/columns.tsx`

- [ ] **Step 1: Create the wallet money formatter**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/format-wallet-money.ts`:

```ts
import {
  formatMoney,
  fromCurrencyMinor,
  fromLedgerMinor,
  toCurrencyMinor,
  toDecimal,
} from "@unprice/money"

const WALLET_MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

export function formatWalletMoney(amount: number, currency: string): string {
  const currencyMinor = toCurrencyMinor(fromLedgerMinor(amount, currency))

  return formatMoney(
    toDecimal(fromCurrencyMinor(currencyMinor, currency)),
    currency,
    WALLET_MONEY_DISPLAY_OPTIONS
  )
}
```

- [ ] **Step 2: Create the wallet balance summary component**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/wallet-balance-summary.tsx`:

```tsx
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Typography } from "@unprice/ui/typography"
import { formatWalletMoney } from "./format-wallet-money"

type CustomerWallet = RouterOutputs["customers"]["getWallet"]["wallet"]

type BalanceItem = {
  label: string
  description: string
  amount: number
  variant?: "default" | "outline" | "secondary"
}

export function WalletBalanceSummary({ wallet }: { wallet: CustomerWallet }) {
  const available = wallet.balances.purchased + wallet.balances.granted
  const balances: BalanceItem[] = [
    {
      label: "Available",
      description: "Purchased plus granted funds",
      amount: available,
      variant: "default",
    },
    {
      label: "Purchased",
      description: "Paid wallet balance",
      amount: wallet.balances.purchased,
      variant: "outline",
    },
    {
      label: "Granted",
      description: "Plan, trial, promo, or manual credits",
      amount: wallet.balances.granted,
      variant: "outline",
    },
    {
      label: "Held",
      description: "Reserved for active usage",
      amount: wallet.balances.reserved,
      variant: "secondary",
    },
    {
      label: "Consumed",
      description: "Already spent from the wallet",
      amount: wallet.balances.consumed,
      variant: "secondary",
    },
  ]

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {balances.map((balance) => (
        <div key={balance.label} className="rounded-md border bg-background p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Typography variant="p" affects="removePaddingMargin" className="font-medium">
                {balance.label}
              </Typography>
              <Badge variant={balance.variant}>{wallet.currency}</Badge>
            </div>
            <Typography variant="h4" affects="removePaddingMargin">
              {formatWalletMoney(balance.amount, wallet.currency)}
            </Typography>
            <Typography
              variant="p"
              affects="removePaddingMargin"
              className="text-muted-foreground text-xs"
            >
              {balance.description}
            </Typography>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Create the wallet credits table columns**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/table-wallet-credits/columns.tsx`:

```tsx
"use client"

import type { ColumnDef } from "@tanstack/react-table"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { format } from "date-fns"
import { InfoIcon } from "lucide-react"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { formatWalletMoney } from "../format-wallet-money"

type WalletCredit = RouterOutputs["customers"]["getWallet"]["wallet"]["credits"][number] & {
  currency: RouterOutputs["customers"]["getWallet"]["wallet"]["currency"]
}

function formatWalletDate(date: WalletCredit["expiresAt"] | WalletCredit["createdAt"]) {
  if (!date) {
    return "Never"
  }

  return format(new Date(date), "PPpp")
}

export const columns: ColumnDef<WalletCredit>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Wallet credit" />,
    cell: ({ row }) => (
      <Typography
        variant="p"
        affects="removePaddingMargin"
        className="whitespace-nowrap font-mono text-sm"
      >
        {row.original.id}
      </Typography>
    ),
    size: 48,
    filterFn: (row, _, filterValue) => {
      const searchValue = String(filterValue).toLowerCase()
      return row.original.id.toLowerCase().includes(searchValue)
    },
  },
  {
    accessorKey: "source",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
    cell: ({ row }) => <Badge variant="outline">{row.original.source}</Badge>,
    size: 28,
    filterFn: (row, _id, value) => {
      return Array.isArray(value) && value.includes(row.original.source)
    },
  },
  {
    accessorKey: "issuedAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Issued" />,
    cell: ({ row }) => <Badge>{formatWalletMoney(row.original.issuedAmount, row.original.currency)}</Badge>,
    size: 28,
  },
  {
    accessorKey: "remainingAmount",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Available" />,
    cell: ({ row }) => (
      <Badge variant="secondary">
        {formatWalletMoney(row.original.remainingAmount, row.original.currency)}
      </Badge>
    ),
    size: 28,
  },
  {
    accessorKey: "expiresAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Expires" />,
    cell: ({ row }) => (
      <Typography variant="p" affects="removePaddingMargin" className="whitespace-nowrap text-sm">
        {formatWalletDate(row.original.expiresAt)}
      </Typography>
    ),
    size: 40,
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
    cell: ({ row }) => {
      const metadata = row.original.metadata

      return (
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Typography variant="p" affects="removePaddingMargin" className="text-sm">
            {formatWalletDate(row.original.createdAt)}
          </Typography>
          {metadata && Object.keys(metadata).length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-4 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="w-52" align="end">
                <pre className="whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-muted-foreground text-xs">
                  {JSON.stringify(metadata, null, 2)}
                </pre>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )
    },
    size: 40,
  },
]
```

- [ ] **Step 4: Run the Next.js typecheck for the components**

Run:

```bash
pnpm --filter nextjs typecheck
```

Expected: PASS once the backend tasks are complete and `customers.getWallet` is available in `RouterOutputs`.

- [ ] **Step 5: Commit the wallet UI components**

Run:

```bash
git add 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/format-wallet-money.ts' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/wallet-balance-summary.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/wallet/table-wallet-credits/columns.tsx'
git commit -m "feat: add customer wallet ui components"
```

Expected: commit succeeds with only wallet component files staged.

## Task 4: Add The Customer Wallet Page And Tab Link

**Files:**
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx`

- [ ] **Step 1: Create the wallet page**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`:

```tsx
import { walletCreditSourceSchema } from "@unprice/db/validators"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { Typography } from "@unprice/ui/typography"
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import HeaderTab from "~/components/layout/header-tab"
import { SuperLink } from "~/components/super-link"
import { api } from "~/trpc/server"
import { CustomerActions } from "../../_components/customers/customer-actions"
import { columns as walletCreditColumns } from "../../_components/wallet/table-wallet-credits/columns"
import { WalletBalanceSummary } from "../../_components/wallet/wallet-balance-summary"

export const dynamic = "force-dynamic"

export default async function CustomerWalletPage({
  params,
}: {
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`
  const { customer, wallet } = await api.customers.getWallet({
    customerId,
  })
  const walletCredits = wallet.credits.map((credit) => ({
    ...credit,
    currency: wallet.currency,
  }))

  if (!customer) {
    notFound()
  }

  return (
    <DashboardShell
      header={
        <HeaderTab
          title={customer.email}
          description={customer.description}
          label={customer.active ? "active" : "inactive"}
          id={customer.id}
          action={<CustomerActions customer={customer} />}
        />
      }
    >
      <TabNavigation>
        <div className="flex items-center">
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}`}>Overview</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/subscriptions`}>Subscriptions</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild active>
            <SuperLink href={`${baseUrl}/wallet`}>Wallet</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/invoices`}>Invoices</SuperLink>
          </TabNavigationLink>
          <TabNavigationLink asChild>
            <SuperLink href={`${baseUrl}/runs`}>Runs</SuperLink>
          </TabNavigationLink>
        </div>
      </TabNavigation>

      <div className="mt-4 flex flex-col gap-6">
        <WalletBalanceSummary wallet={wallet} />

        <div>
          <div className="flex flex-col px-1 py-4">
            <Typography variant="p" affects="removePaddingMargin">
              Active wallet credits for this customer
            </Typography>
          </div>
          <Suspense
            fallback={
              <DataTableSkeleton
                columnCount={6}
                searchableColumnCount={1}
                filterableColumnCount={1}
                cellWidths={["18rem", "10rem", "10rem", "10rem", "14rem", "14rem"]}
              />
            }
          >
            <DataTable
              columns={walletCreditColumns}
              data={walletCredits}
              filterOptions={{
                filterBy: "id",
                filterColumns: true,
                filterSelectors: {
                  source: walletCreditSourceSchema.options.map((value) => ({
                    value,
                    label: value,
                  })),
                },
              }}
            />
          </Suspense>
        </div>
      </div>
    </DashboardShell>
  )
}
```

- [ ] **Step 2: Add the Wallet tab to the existing customer pages**

In each existing customer tab page, insert this block after the Subscriptions link and before the Invoices link:

```tsx
<TabNavigationLink asChild>
  <SuperLink href={`${baseUrl}/wallet`}>Wallet</SuperLink>
</TabNavigationLink>
```

Files to edit:

```text
apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx
apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx
apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx
apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx
```

The final tab order in every customer detail page should be:

```text
Overview
Subscriptions
Wallet
Invoices
Runs
```

- [ ] **Step 3: Run the Next.js typecheck**

Run:

```bash
pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 4: Run a focused visual smoke check**

Start the app:

```bash
pnpm --filter nextjs dev
```

Open an existing local customer URL in the browser:

```text
http://localhost:3000/<workspaceSlug>/<projectSlug>/customers/<customerId>/wallet
```

Expected:
- The page header matches the existing customer pages.
- The tab row shows `Overview`, `Subscriptions`, `Wallet`, `Invoices`, `Runs`.
- `Wallet` is active on `/wallet`.
- Balance amounts render with two currency minor digits.
- Empty credits render the existing DataTable empty state.
- Active credits render id, source, issued amount, available amount, expiration, and creation date.

Stop the dev server after the smoke check.

- [ ] **Step 5: Commit the wallet page and tab links**

Run:

```bash
git add 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx'
git commit -m "feat: add customer wallet tab"
```

Expected: commit succeeds with only the customer wallet page and tab-link files staged.

## Task 5: Final Verification

**Files:**
- Verify all files changed by Tasks 1-4.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @unprice/services exec vitest run src/use-cases/wallet/get-customer-wallet.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typechecks**

Run:

```bash
pnpm --filter @unprice/services typecheck
pnpm --filter @unprice/trpc typecheck
pnpm --filter nextjs typecheck
```

Expected: all commands PASS.

- [ ] **Step 3: Run repo validation**

Run:

```bash
pnpm validate
```

Expected: PASS. If `pnpm validate` rewrites formatting, inspect `git diff` and keep only formatting changes related to files touched by this plan.

- [ ] **Step 4: Confirm the final diff**

Run:

```bash
git status --short
git diff --stat
```

Expected:
- Only files from this plan are modified or added.
- Existing unrelated dirty files remain unstaged.
- No migrations are created.
- No public API SDK files are changed.

## Self-Review

**Spec coverage:** The plan covers the backend use case, tRPC procedure, customer Wallet tab route, active wallet credit table, wallet balance amounts, tab link updates, and verification commands.

**Placeholder scan:** The plan contains no placeholder task bodies. Each code-writing step includes concrete code, and each verification step includes an exact command plus expected result.

**Type consistency:** The backend route is named `customers.getWallet`, the service function is `getCustomerWallet`, the returned shape is `{ customer, wallet: { currency, balances, credits } }`, and the frontend types read from `RouterOutputs["customers"]["getWallet"]`.
