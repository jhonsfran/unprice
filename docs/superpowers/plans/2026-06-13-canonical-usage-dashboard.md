# Canonical Usage Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project and customer dashboard usage cards/chart with one canonical usage dashboard query whose summary rows are derived from the same dense cumulative time series.

**Architecture:** Add one service-layer use case that owns usage dashboard composition for both project-wide and customer-scoped dashboards. The tRPC adapter stays thin and caches the whole dashboard payload under one namespace. The Next.js project and customer dashboards call the same tRPC procedure and render through shared usage dashboard components.

**Tech Stack:** TypeScript, Zod, Result/Ok/Err, Tinybird analytics client, Drizzle, tRPC, React Query, Recharts, Vitest, pnpm.

---

## Current Root Cause

The current UI asks for related data through separate query paths:

- Customer dashboard: `getProjectUsage` for cards/table and `getProjectUsageTimeseries` for chart.
- Project dashboard: `getProjectUsage`, `getProjectUsageTimeseries`, and `getTopConsumers`.

The chart is built from cumulative `value_after` buckets, but the UI fills missing feature buckets with `0`. For cumulative counters, a missing bucket means "no new observation in this bucket", not "usage reset to zero". The canonical use case below fixes that by carrying the last observed value forward and deriving summary cards from the final dense time-series state.

## File Structure

Create:

- `internal/services/src/use-cases/analytics/get-usage-dashboard.ts` - canonical service use case for project and customer usage dashboard data.
- `internal/services/src/use-cases/analytics/get-usage-dashboard.test.ts` - focused use-case tests proving summary derives from dense time series.
- `internal/trpc/src/router/lambda/analytics/getUsageDashboard.ts` - thin cached tRPC adapter.
- `apps/nextjs/src/components/analytics/usage-area-chart.tsx` - shared chart component.
- `apps/nextjs/src/components/analytics/usage-dashboard-view.tsx` - shared dashboard presentation component for project and customer views.

Modify:

- `internal/services/src/use-cases/analytics/index.ts` - export the new use case.
- `internal/services/src/use-cases/index.ts` - export the new use case through `@unprice/services/use-cases`.
- `internal/services/src/cache/namespaces.ts` - add `getUsageDashboard`, remove obsolete dashboard-only cache entries after UI migration.
- `internal/services/src/cache/service.ts` - add `getUsageDashboard`, remove obsolete dashboard-only cache namespaces after UI migration.
- `internal/trpc/src/router/lambda/analytics/index.ts` - add `getUsageDashboard`, remove obsolete dashboard-only routes after UI migration.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx` - prefetch one usage dashboard query.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-stats.tsx` - use the canonical query and shared view.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx` - prefetch one customer-scoped usage dashboard query.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-metrics-panel.tsx` - use the canonical query and shared view.

Delete after callers are migrated:

- `internal/trpc/src/router/lambda/analytics/getProjectUsage.ts`
- `internal/trpc/src/router/lambda/analytics/getProjectUsageTimeseries.ts`
- `internal/trpc/src/router/lambda/analytics/getTopConsumers.ts`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-area-chart.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-usage-area-chart.tsx`

Keep:

- `internal/trpc/src/router/lambda/analytics/getUsage.ts` and `apps/api/src/routes/analytics/getUsageV1.ts`; they back the public/API usage endpoint and workspace billing usage page.
- Tinybird endpoints `v1_get_feature_usage_period`, `v1_get_feature_usage_timeseries`, and `v1_get_top_consumers`; the canonical use case still reads those analytics sources.

### Task 1: Add The Canonical Service Use Case

**Files:**
- Create: `internal/services/src/use-cases/analytics/get-usage-dashboard.ts`
- Create: `internal/services/src/use-cases/analytics/get-usage-dashboard.test.ts`
- Modify: `internal/services/src/use-cases/analytics/index.ts`
- Modify: `internal/services/src/use-cases/index.ts`

- [ ] **Step 1: Write the failing service tests**

Create `internal/services/src/use-cases/analytics/get-usage-dashboard.test.ts` with this complete content:

```ts
import type { FeatureUsageTimeseriesRow, TopConsumerRow } from "@unprice/analytics"
import type { Database } from "@unprice/db"
import { FetchError } from "@unprice/error"
import { describe, expect, it, vi } from "vitest"
import {
  type GetUsageDashboardDeps,
  type GetUsageDashboardInput,
  getUsageDashboard,
} from "./get-usage-dashboard"

const firstHour = Date.parse("2026-06-13T07:00:00.000Z")
const secondHour = Date.parse("2026-06-13T08:00:00.000Z")
const thirdHour = Date.parse("2026-06-13T09:00:00.000Z")
const now = Date.parse("2026-06-13T09:30:00.000Z")

describe("getUsageDashboard", () => {
  it("derives summary rows from the final dense cumulative time series state", async () => {
    const { deps, analytics } = makeDeps({
      now: () => now,
      timeseriesRows: [
        timeseriesRow({
          date: firstHour,
          feature_slug: "events",
          usage: 4,
          amount_after: 0,
          currency: "USD",
        }),
        timeseriesRow({
          date: firstHour,
          feature_slug: "customers",
          usage: 3,
          amount_after: 100_000_000,
          currency: "USD",
        }),
        timeseriesRow({
          date: secondHour,
          feature_slug: "events",
          usage: 9,
          amount_after: 0,
          currency: "USD",
        }),
        timeseriesRow({
          date: thirdHour,
          feature_slug: "pages",
          usage: 2,
          amount_after: 0,
          currency: "USD",
        }),
      ],
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: "cus_1" }))

    expect(result.err).toBeUndefined()
    expect(result.val?.summary).toEqual({
      featureCount: 3,
      totalLatestUsage: 14,
      spending: [
        {
          currency: "USD",
          amount: "1",
          displayAmount: "$1.00",
        },
      ],
    })
    expect(result.val?.features.map((feature) => [feature.featureSlug, feature.usage])).toEqual([
      ["events", 9],
      ["customers", 3],
      ["pages", 2],
    ])
    expect(result.val?.timeseries.map((row) => [row.date, row.featureSlug, row.usage])).toEqual([
      [firstHour, "customers", 3],
      [firstHour, "events", 4],
      [firstHour, "pages", 0],
      [secondHour, "customers", 3],
      [secondHour, "events", 9],
      [secondHour, "pages", 0],
      [thirdHour, "customers", 3],
      [thirdHour, "events", 9],
      [thirdHour, "pages", 2],
    ])
    expect(analytics.getFeaturesUsageTimeseries).toHaveBeenCalledWith({
      project_id: "proj_1",
      customer_id: "cus_1",
      start: expect.any(Number),
      end: expect.any(Number),
    })
    expect(analytics.getTopConsumers).not.toHaveBeenCalled()
  })

  it("loads top consumers only for the project dashboard", async () => {
    const { deps, analytics } = makeDeps({
      now: () => now,
      timeseriesRows: [
        timeseriesRow({
          date: firstHour,
          feature_slug: "events",
          usage: 4,
          amount_after: 0,
          currency: "USD",
        }),
      ],
      topConsumerRows: [
        {
          customer_id: "cus_1",
          total_usage: 7,
          total_amount_after: 250_000_000,
          currency: "USD",
        },
      ],
      customerRows: [{ id: "cus_1", email: "one@example.com", name: "One" }],
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: undefined }))

    expect(result.err).toBeUndefined()
    expect(result.val?.topConsumers).toEqual([
      {
        customerId: "cus_1",
        email: "one@example.com",
        name: "One",
        totalUsage: 7,
        displaySpending: "$2.50",
      },
    ])
    expect(analytics.getTopConsumers).toHaveBeenCalledWith({
      project_id: "proj_1",
      start: expect.any(Number),
      end: expect.any(Number),
      limit: 10,
    })
  })

  it("returns fetch errors when the usage time series query fails", async () => {
    const { deps } = makeDeps({
      timeseriesError: new Error("tinybird unavailable"),
    })

    const result = await getUsageDashboard(deps, baseInput({ customerId: "cus_1" }))

    expect(result.val).toBeUndefined()
    expect(result.err).toBeInstanceOf(FetchError)
    expect(result.err?.message).toBe("tinybird unavailable")
  })
})

function baseInput(overrides: Partial<GetUsageDashboardInput> = {}): GetUsageDashboardInput {
  return {
    projectId: "proj_1",
    customerId: "cus_1",
    range: "24h",
    topConsumersLimit: 10,
    ...overrides,
  }
}

function timeseriesRow(
  overrides: Partial<FeatureUsageTimeseriesRow>
): FeatureUsageTimeseriesRow {
  return {
    date: firstHour,
    feature_slug: "events",
    usage: 1,
    amount_after: 0,
    currency: "USD",
    ...overrides,
  }
}

function makeDeps({
  timeseriesRows = [],
  topConsumerRows = [],
  customerRows = [],
  timeseriesError,
  topConsumersError,
  now: nowFn = () => now,
}: {
  timeseriesRows?: FeatureUsageTimeseriesRow[]
  topConsumerRows?: TopConsumerRow[]
  customerRows?: Array<{ id: string; email: string; name: string }>
  timeseriesError?: Error
  topConsumersError?: Error
  now?: () => number
} = {}) {
  const analytics = {
    getFeaturesUsageTimeseries: vi.fn(async () => {
      if (timeseriesError) {
        throw timeseriesError
      }

      return { data: timeseriesRows }
    }),
    getTopConsumers: vi.fn(async () => {
      if (topConsumersError) {
        throw topConsumersError
      }

      return { data: topConsumerRows }
    }),
  }

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => customerRows),
      })),
    })),
  } as unknown as Database

  const deps: GetUsageDashboardDeps = {
    analytics,
    db,
    now: nowFn,
  }

  return { deps, analytics, db }
}
```

- [ ] **Step 2: Run the service test and verify it fails**

Run:

```bash
pnpm --filter @unprice/services test:file src/use-cases/analytics/get-usage-dashboard.test.ts
```

Expected: FAIL with an import/module error for `./get-usage-dashboard`.

- [ ] **Step 3: Implement the canonical use case**

Create `internal/services/src/use-cases/analytics/get-usage-dashboard.ts` with this complete content:

```ts
import {
  type Analytics,
  type FeatureUsageTimeseriesRow,
  type Interval,
  type TopConsumerRow,
  analyticsIntervalSchema,
  prepareInterval,
} from "@unprice/analytics"
import { inArray } from "@unprice/db"
import type { Database } from "@unprice/db"
import { customers } from "@unprice/db/schema"
import type { Currency } from "@unprice/db/validators"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import { formatMoney, fromLedgerMinor, toDecimal } from "@unprice/money"
import { z } from "zod"

const MONEY_DISPLAY_OPTIONS = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}

const usageDashboardMoneySchema = z.object({
  amount: z.string(),
  currency: z.string().length(3),
  displayAmount: z.string(),
})

export const usageDashboardFeatureSchema = z.object({
  featureSlug: z.string(),
  usage: z.number(),
  spending: usageDashboardMoneySchema,
})

export const usageDashboardTimeseriesRowSchema = z.object({
  date: z.number().int(),
  featureSlug: z.string(),
  usage: z.number(),
  spending: usageDashboardMoneySchema,
})

export const usageDashboardTopConsumerSchema = z.object({
  customerId: z.string(),
  email: z.string(),
  name: z.string(),
  totalUsage: z.number(),
  displaySpending: z.string(),
})

export const getUsageDashboardInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string().optional(),
  range: analyticsIntervalSchema,
  topConsumersLimit: z.number().int().min(1).max(20).optional().default(10),
})

export const getUsageDashboardOutputSchema = z.object({
  summary: z.object({
    featureCount: z.number().int(),
    totalLatestUsage: z.number(),
    spending: z.array(usageDashboardMoneySchema),
  }),
  features: z.array(usageDashboardFeatureSchema),
  timeseries: z.array(usageDashboardTimeseriesRowSchema),
  topConsumers: z.array(usageDashboardTopConsumerSchema),
  freshness: z.object({
    generatedAt: z.number().int(),
    dataFrom: z.number().int(),
    dataTo: z.number().int(),
  }),
  error: z.string().optional(),
})

export type UsageDashboardMoney = z.infer<typeof usageDashboardMoneySchema>
export type UsageDashboardFeature = z.infer<typeof usageDashboardFeatureSchema>
export type UsageDashboardTimeseriesRow = z.infer<typeof usageDashboardTimeseriesRowSchema>
export type UsageDashboardTopConsumer = z.infer<typeof usageDashboardTopConsumerSchema>
export type GetUsageDashboardInput = z.input<typeof getUsageDashboardInputSchema>
export type GetUsageDashboardOutput = z.infer<typeof getUsageDashboardOutputSchema>

export type GetUsageDashboardAnalytics = Pick<
  Analytics,
  "getFeaturesUsageTimeseries" | "getTopConsumers"
>

export type GetUsageDashboardDeps = {
  analytics: GetUsageDashboardAnalytics
  db: Database
  now?: () => number
}

type GetUsageDashboardFailure = FetchError

type FeatureState = {
  usage: number
  amountAfter: number
  currency: string
}

export async function getUsageDashboard(
  deps: GetUsageDashboardDeps,
  rawInput: GetUsageDashboardInput
): Promise<Result<GetUsageDashboardOutput, GetUsageDashboardFailure>> {
  const input = getUsageDashboardInputSchema.parse(rawInput)
  const interval = prepareInterval(input.range)
  const generatedAt = deps.now?.() ?? Date.now()

  const timeseriesResult = await wrapResult(
    deps.analytics.getFeaturesUsageTimeseries({
      project_id: input.projectId,
      ...(input.customerId ? { customer_id: input.customerId } : {}),
      start: interval.start,
      end: interval.end,
    }),
    (error) =>
      new FetchError({
        message: error.message,
        retry: true,
        context: {
          url: "tinybird:v1_get_feature_usage_timeseries",
          method: "GET",
          projectId: input.projectId,
          customerId: input.customerId,
        },
      })
  )

  if (timeseriesResult.err) {
    return Err(timeseriesResult.err)
  }

  const denseTimeseries = buildDenseTimeseries(timeseriesResult.val.data ?? [])
  const features = buildFeatureRows(denseTimeseries)
  const summary = buildSummary(features)

  let topConsumers: UsageDashboardTopConsumer[] = []

  if (!input.customerId) {
    const topConsumersResult = await wrapResult(
      loadTopConsumers({
        deps,
        projectId: input.projectId,
        start: interval.start,
        end: interval.end,
        limit: input.topConsumersLimit,
      }),
      (error) =>
        new FetchError({
          message: error.message,
          retry: true,
          context: {
            url: "tinybird:v1_get_top_consumers",
            method: "GET",
            projectId: input.projectId,
          },
        })
    )

    if (topConsumersResult.err) {
      return Err(topConsumersResult.err)
    }

    topConsumers = topConsumersResult.val
  }

  const output: GetUsageDashboardOutput = {
    summary,
    features,
    timeseries: denseTimeseries,
    topConsumers,
    freshness: {
      generatedAt,
      dataFrom: interval.start,
      dataTo: interval.end,
    },
  }

  return Ok(getUsageDashboardOutputSchema.parse(output))
}

export function emptyUsageDashboardOutput(
  range: Interval,
  error?: string
): GetUsageDashboardOutput {
  const interval = prepareInterval(range)

  return {
    summary: {
      featureCount: 0,
      totalLatestUsage: 0,
      spending: [],
    },
    features: [],
    timeseries: [],
    topConsumers: [],
    freshness: {
      generatedAt: Date.now(),
      dataFrom: interval.start,
      dataTo: interval.end,
    },
    ...(error ? { error } : {}),
  }
}

function buildDenseTimeseries(rows: FeatureUsageTimeseriesRow[]): UsageDashboardTimeseriesRow[] {
  const rowsByDate = new Map<number, FeatureUsageTimeseriesRow[]>()
  const featureSlugs = new Set<string>()

  for (const row of rows) {
    featureSlugs.add(row.feature_slug)

    const existing = rowsByDate.get(row.date) ?? []
    existing.push(row)
    rowsByDate.set(row.date, existing)
  }

  const features = [...featureSlugs].sort()
  const dates = [...rowsByDate.keys()].sort((a, b) => a - b)
  const state = new Map<string, FeatureState>()
  const denseRows: UsageDashboardTimeseriesRow[] = []

  for (const date of dates) {
    for (const row of rowsByDate.get(date) ?? []) {
      state.set(row.feature_slug, {
        usage: row.usage ?? 0,
        amountAfter: row.amount_after ?? 0,
        currency: row.currency ?? "USD",
      })
    }

    for (const featureSlug of features) {
      const current = state.get(featureSlug) ?? {
        usage: 0,
        amountAfter: 0,
        currency: "USD",
      }

      denseRows.push({
        date,
        featureSlug,
        usage: current.usage,
        spending: formatLedgerMoney(current.amountAfter, current.currency),
      })
    }
  }

  return denseRows
}

function buildFeatureRows(rows: UsageDashboardTimeseriesRow[]): UsageDashboardFeature[] {
  const latestByFeature = new Map<string, UsageDashboardTimeseriesRow>()

  for (const row of rows) {
    latestByFeature.set(row.featureSlug, row)
  }

  return [...latestByFeature.values()]
    .map((row) => ({
      featureSlug: row.featureSlug,
      usage: row.usage,
      spending: row.spending,
    }))
    .sort((a, b) => {
      if (b.usage !== a.usage) {
        return b.usage - a.usage
      }

      return a.featureSlug.localeCompare(b.featureSlug)
    })
}

function buildSummary(features: UsageDashboardFeature[]): GetUsageDashboardOutput["summary"] {
  const totalsByCurrency = new Map<string, number>()

  for (const feature of features) {
    const amount = Number(feature.spending.amount)

    if (!Number.isFinite(amount)) {
      continue
    }

    totalsByCurrency.set(
      feature.spending.currency,
      (totalsByCurrency.get(feature.spending.currency) ?? 0) + amount
    )
  }

  return {
    featureCount: features.length,
    totalLatestUsage: features.reduce((sum, feature) => sum + feature.usage, 0),
    spending: [...totalsByCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => formatMajorMoney(amount, currency)),
  }
}

async function loadTopConsumers({
  deps,
  projectId,
  start,
  end,
  limit,
}: {
  deps: GetUsageDashboardDeps
  projectId: string
  start: number
  end: number
  limit: number
}): Promise<UsageDashboardTopConsumer[]> {
  const response = await deps.analytics.getTopConsumers({
    project_id: projectId,
    start,
    end,
    limit,
  })
  const rows = response.data ?? []

  if (rows.length === 0) {
    return []
  }

  const customerIds = rows.map((row) => row.customer_id)
  const customerRecords = await deps.db
    .select({ id: customers.id, email: customers.email, name: customers.name })
    .from(customers)
    .where(inArray(customers.id, customerIds))
  const customerMap = new Map(customerRecords.map((customer) => [customer.id, customer]))

  return rows
    .map((row) => mapTopConsumer(row, customerMap))
    .filter((row): row is UsageDashboardTopConsumer => row !== null)
}

function mapTopConsumer(
  row: TopConsumerRow,
  customerMap: Map<string, { id: string; email: string; name: string }>
): UsageDashboardTopConsumer | null {
  const customer = customerMap.get(row.customer_id)

  if (!customer) {
    return null
  }

  const currency = row.currency ?? "USD"

  return {
    customerId: row.customer_id,
    email: customer.email,
    name: customer.name,
    totalUsage: row.total_usage ?? 0,
    displaySpending: formatLedgerMoney(row.total_amount_after ?? 0, currency).displayAmount,
  }
}

function formatLedgerMoney(amountAfter: number, rawCurrency: string): UsageDashboardMoney {
  const currency = normalizeCurrency(rawCurrency)
  const amount = trimInsignificantZeros(toDecimal(fromLedgerMinor(amountAfter, currency)))

  return {
    amount,
    currency,
    displayAmount: formatMoney(amount, currency, MONEY_DISPLAY_OPTIONS),
  }
}

function formatMajorMoney(amount: number, rawCurrency: string): UsageDashboardMoney {
  const currency = normalizeCurrency(rawCurrency)
  const value = trimInsignificantZeros(amount.toFixed(8))

  return {
    amount: value,
    currency,
    displayAmount: formatMoney(value, currency, MONEY_DISPLAY_OPTIONS),
  }
}

function normalizeCurrency(currency: string): Currency {
  return (currency || "USD") as Currency
}

function trimInsignificantZeros(amount: string): string {
  if (!amount.includes(".")) {
    return amount
  }

  return amount.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
}
```

- [ ] **Step 4: Export the use case**

In `internal/services/src/use-cases/analytics/index.ts`, add these exports:

```ts
export {
  emptyUsageDashboardOutput,
  getUsageDashboard,
  getUsageDashboardInputSchema,
  getUsageDashboardOutputSchema,
  usageDashboardFeatureSchema,
  usageDashboardTimeseriesRowSchema,
  usageDashboardTopConsumerSchema,
} from "./get-usage-dashboard"
export type {
  GetUsageDashboardDeps,
  GetUsageDashboardInput,
  GetUsageDashboardOutput,
  UsageDashboardFeature,
  UsageDashboardTimeseriesRow,
  UsageDashboardTopConsumer,
} from "./get-usage-dashboard"
```

In `internal/services/src/use-cases/index.ts`, add the same export block near the other analytics use-case exports.

- [ ] **Step 5: Run the focused service test**

Run:

```bash
pnpm --filter @unprice/services test:file src/use-cases/analytics/get-usage-dashboard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add internal/services/src/use-cases/analytics/get-usage-dashboard.ts internal/services/src/use-cases/analytics/get-usage-dashboard.test.ts internal/services/src/use-cases/analytics/index.ts internal/services/src/use-cases/index.ts
git commit -m "feat: add canonical usage dashboard use case"
```

### Task 2: Add The Cached tRPC Query

**Files:**
- Create: `internal/trpc/src/router/lambda/analytics/getUsageDashboard.ts`
- Modify: `internal/trpc/src/router/lambda/analytics/index.ts`
- Modify: `internal/services/src/cache/namespaces.ts`
- Modify: `internal/services/src/cache/service.ts`

- [ ] **Step 1: Add the cache namespace type**

In `internal/services/src/cache/namespaces.ts`, add this import:

```ts
import type { GetUsageDashboardOutput } from "../use-cases/analytics/get-usage-dashboard"
```

Add this namespace entry to `CacheNamespaces`:

```ts
getUsageDashboard: GetUsageDashboardOutput | null
```

Keep `getUsage`, `getUsageTimeseries`, and `getTopConsumers` in this step. They are removed only after all UI callers are migrated.

- [ ] **Step 2: Add the cache namespace instance**

In `internal/services/src/cache/service.ts`, add this namespace after `getUsage`:

```ts
getUsageDashboard: new Namespace<CacheNamespaces["getUsageDashboard"]>(this.context, {
  ...defaultOpts,
  fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS,
  stale: CACHE_ANALYTICS_STALENESS_TIME_MS,
}),
```

- [ ] **Step 3: Create the tRPC adapter**

Create `internal/trpc/src/router/lambda/analytics/getUsageDashboard.ts` with this complete content:

```ts
import { analyticsIntervalSchema } from "@unprice/analytics"
import {
  emptyUsageDashboardOutput,
  getUsageDashboardOutputSchema,
  getUsageDashboard as getUsageDashboardUseCase,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getUsageDashboard = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string().optional(),
      range: analyticsIntervalSchema,
      topConsumersLimit: z.number().int().min(1).max(20).optional().default(10),
    })
  )
  .output(getUsageDashboardOutputSchema)
  .query(async (opts) => {
    const projectId = opts.ctx.project.id
    const customerId = opts.input.customerId
    const range = opts.input.range
    const topConsumersLimit = opts.input.topConsumersLimit
    const cacheKey = [
      projectId,
      customerId ?? "all",
      range,
      topConsumersLimit,
    ].join(":")

    const { err, val: cached } = await opts.ctx.cache.getUsageDashboard.swr(cacheKey, async () => {
      const result = await getUsageDashboardUseCase(
        {
          analytics: opts.ctx.analytics,
          db: opts.ctx.db,
        },
        {
          projectId,
          ...(customerId ? { customerId } : {}),
          range,
          topConsumersLimit,
        }
      )

      if (result.err) {
        throw result.err
      }

      return result.val
    })

    if (err) {
      opts.ctx.logger.error(err, {
        context: "getUsageDashboard failed",
        project_id: projectId,
        ...(customerId ? { customer_id: customerId } : {}),
        range,
      })

      return emptyUsageDashboardOutput(
        range,
        err instanceof Error ? err.message : "Failed to fetch usage dashboard"
      )
    }

    return cached ?? emptyUsageDashboardOutput(range)
  })
```

- [ ] **Step 4: Register the tRPC route**

In `internal/trpc/src/router/lambda/analytics/index.ts`, add:

```ts
import { getUsageDashboard } from "./getUsageDashboard"
```

Add the router entry:

```ts
getUsageDashboard: getUsageDashboard,
```

Keep the old `getProjectUsage`, `getProjectUsageTimeseries`, and `getTopConsumers` entries until Task 4 removes the old callers.

- [ ] **Step 5: Typecheck services and tRPC**

Run:

```bash
pnpm --filter @unprice/services typecheck
pnpm --filter @unprice/trpc typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add internal/trpc/src/router/lambda/analytics/getUsageDashboard.ts internal/trpc/src/router/lambda/analytics/index.ts internal/services/src/cache/namespaces.ts internal/services/src/cache/service.ts
git commit -m "feat: expose cached usage dashboard query"
```

### Task 3: Replace Both Dashboards With Shared UI

**Files:**
- Create: `apps/nextjs/src/components/analytics/usage-area-chart.tsx`
- Create: `apps/nextjs/src/components/analytics/usage-dashboard-view.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-stats.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-metrics-panel.tsx`

- [ ] **Step 1: Create the shared chart**

Create `apps/nextjs/src/components/analytics/usage-area-chart.tsx` with this complete content:

```tsx
"use client"

import { nFormatter } from "@unprice/db/utils"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { cn } from "@unprice/ui/utils"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

export type UsageChartPoint = {
  date: number
  dateLabel: string
  [feature: string]: string | number
}

const TIMESERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

export function buildUsageChartConfig(features: string[]): ChartConfig {
  return Object.fromEntries(
    features.map((feature, index) => [
      feature,
      { label: feature, color: TIMESERIES_COLORS[index % TIMESERIES_COLORS.length] },
    ])
  ) satisfies ChartConfig
}

export function UsageAreaChart({
  data,
  features,
  config,
  className,
  heightClassName = "h-[220px]",
}: {
  data: UsageChartPoint[]
  features: string[]
  config: ChartConfig
  className?: string
  heightClassName?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border border-border/60 p-3 sm:p-4", className)}>
      <p className="mb-3 text-muted-foreground text-xs uppercase">Usage over time</p>
      <ChartContainer config={config} className={cn(heightClassName, "w-full")}>
        <AreaChart accessibilityLayer data={data} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <CartesianGrid vertical={false} className="stroke-muted" />
          <XAxis
            dataKey="dateLabel"
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={(value) => nFormatter(Number(value), { digits: 1 })}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value, name) => (
                  <>
                    <span>{String(name)}</span>
                    <span className="ml-auto font-medium font-mono text-foreground tabular-nums">
                      {nFormatter(Number(value), { digits: 1 })}
                    </span>
                  </>
                )}
              />
            }
          />
          {features.map((feature, index) => (
            <Area
              key={feature}
              type="monotone"
              dataKey={feature}
              stackId="usage"
              fill={TIMESERIES_COLORS[index % TIMESERIES_COLORS.length]}
              fillOpacity={0.15}
              stroke={TIMESERIES_COLORS[index % TIMESERIES_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </div>
  )
}
```

- [ ] **Step 2: Create the shared dashboard view**

Create `apps/nextjs/src/components/analytics/usage-dashboard-view.tsx` with this complete content:

```tsx
"use client"

import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { cn } from "@unprice/ui/utils"
import { BarChart3, CalendarRange, Coins, Layers3, ReceiptText, TriangleAlert, Users } from "lucide-react"
import type { ReactNode } from "react"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { SuperLink } from "~/components/super-link"
import {
  type UsageChartPoint,
  UsageAreaChart,
  buildUsageChartConfig,
} from "./usage-area-chart"

type UsageDashboardData = RouterOutputs["analytics"]["getUsageDashboard"]
type UsageDashboardFeature = UsageDashboardData["features"][number]

export function UsageDashboardSkeleton() {
  return (
    <Card className="overflow-hidden border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Loading usage metrics...</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          {["features", "usage", "spend", "context"].map((item) => (
            <div key={`usage-dashboard-skeleton-${item}`} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-3 h-8 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="h-[220px] w-full rounded-lg" />
        <Skeleton className="h-[160px] w-full rounded-lg" />
      </CardContent>
    </Card>
  )
}

export function UsageDashboardView({
  data,
  intervalLabel,
  dateFormat,
  mode,
  isFetching,
  invoiceCount,
  customerHref,
}: {
  data: UsageDashboardData
  intervalLabel: string
  dateFormat: string
  mode: "project" | "customer"
  isFetching: boolean
  invoiceCount?: number
  customerHref?: (customerId: string) => string
}) {
  if (data.error) {
    return <UsageDashboardErrorState error={data.error} />
  }

  if (data.features.length === 0 && data.timeseries.length === 0) {
    return <UsageDashboardEmptyState intervalLabel={intervalLabel} mode={mode} />
  }

  const chart = buildChartData(data.timeseries, dateFormat)
  const chartConfig = buildUsageChartConfig(chart.features)
  const maxFeatureUsage = data.features[0]?.usage ?? 1

  return (
    <Card className="overflow-hidden border-muted/60">
      <div
        className={cn(
          "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <CardHeader>
        <CardTitle>{mode === "customer" ? "Customer usage" : "Usage Dashboard"}</CardTitle>
        <CardDescription>
          Usage in the {intervalLabel}
          {mode === "project" ? " for the currently selected project." : "."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pb-6">
        <div className="grid gap-3 md:grid-cols-4">
          <MetricCard
            label="Features with usage"
            icon={<Layers3 className="h-4 w-4 text-muted-foreground" />}
            value={String(data.summary.featureCount)}
          />
          <MetricCard
            label="Total latest usage"
            icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />}
            value={nFormatter(data.summary.totalLatestUsage, { digits: 1 })}
          />
          <MetricCard
            label="Consumed amount"
            icon={<Coins className="h-4 w-4 text-muted-foreground" />}
            value={formatSpendingSummary(data.summary.spending)}
            truncate
          />
          {mode === "customer" ? (
            <MetricCard
              label="Number of invoices"
              icon={<ReceiptText className="h-4 w-4 text-muted-foreground" />}
              value={String(invoiceCount ?? 0)}
            />
          ) : (
            <MetricCard
              label="Selected interval"
              icon={<CalendarRange className="h-4 w-4 text-muted-foreground" />}
              value={intervalLabel}
              capitalize
            />
          )}
        </div>

        {chart.data.length > 0 && (
          <UsageAreaChart
            data={chart.data}
            features={chart.features}
            config={chartConfig}
            heightClassName={mode === "customer" ? "h-[240px]" : "h-[220px]"}
          />
        )}

        <UsageFeatureTable features={data.features} maxFeatureUsage={maxFeatureUsage} />

        {mode === "project" && data.topConsumers.length > 0 && customerHref && (
          <TopConsumersTable consumers={data.topConsumers} customerHref={customerHref} />
        )}
      </CardContent>
    </Card>
  )
}

function MetricCard({
  label,
  icon,
  value,
  truncate = false,
  capitalize = false,
}: {
  label: string
  icon: ReactNode
  value: string
  truncate?: boolean
  capitalize?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{label}</p>
        {icon}
      </div>
      <p
        className={cn(
          "mt-1 font-semibold text-2xl text-foreground",
          truncate && "truncate text-xl",
          capitalize && "text-base capitalize"
        )}
      >
        {value}
      </p>
    </div>
  )
}

function UsageFeatureTable({
  features,
  maxFeatureUsage,
}: {
  features: UsageDashboardFeature[]
  maxFeatureUsage: number
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 bg-muted/40 px-4 py-2.5">
        <p className="text-muted-foreground text-xs uppercase">Feature</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
      </div>
      <div className="divide-y divide-border">
        {features.map((feature) => {
          const usagePercent = maxFeatureUsage > 0 ? (feature.usage / maxFeatureUsage) * 100 : 0

          return (
            <div
              key={feature.featureSlug}
              className="grid grid-cols-[minmax(0,1fr)_6rem_7rem] items-center gap-4 px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium text-sm">{feature.featureSlug}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                  <div
                    className="h-full rounded-full bg-primary/60 transition-all"
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
              </div>
              <Badge variant="outline" className="justify-self-end font-mono text-xs tabular-nums">
                {nFormatter(feature.usage, { digits: 1 })}
              </Badge>
              <span className="truncate text-right font-mono text-sm tabular-nums">
                {feature.spending.displayAmount}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TopConsumersTable({
  consumers,
  customerHref,
}: {
  consumers: UsageDashboardData["topConsumers"]
  customerHref: (customerId: string) => string
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/60">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 bg-muted/40 px-4 py-2.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-muted-foreground text-xs uppercase">Top consumers</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Usage</p>
        <p className="text-right text-muted-foreground text-xs uppercase">Consumed</p>
      </div>
      <div className="divide-y divide-border">
        {consumers.map((consumer, index) => (
          <SuperLink
            key={consumer.customerId}
            href={customerHref(consumer.customerId)}
            className="grid grid-cols-[auto_minmax(0,1fr)_6rem_7rem] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
          >
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">{consumer.name}</p>
              <p className="truncate text-muted-foreground text-xs">{consumer.email}</p>
            </div>
            <span className="text-right font-mono text-muted-foreground text-sm tabular-nums">
              {nFormatter(consumer.totalUsage, { digits: 1 })}
            </span>
            <span className="text-right font-mono text-sm tabular-nums">
              {consumer.displaySpending}
            </span>
          </SuperLink>
        ))}
      </div>
    </div>
  )
}

function UsageDashboardErrorState({ error }: { error: string }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Usage Dashboard</CardTitle>
        <CardDescription>Usage analytics could not be loaded right now.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4 pb-6">
        <EmptyPlaceholder className="min-h-[220px]">
          <EmptyPlaceholder.Icon>
            <TriangleAlert className="h-8 w-8 opacity-60" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>Unable to load usage</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>{error}</EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function UsageDashboardEmptyState({
  intervalLabel,
  mode,
}: {
  intervalLabel: string
  mode: "project" | "customer"
}) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>{mode === "customer" ? "Customer usage" : "Usage Dashboard"}</CardTitle>
        <CardDescription>Usage for the {intervalLabel}.</CardDescription>
      </CardHeader>
      <CardContent className="py-4">
        <EmptyPlaceholder className="min-h-[220px] transition-opacity duration-300">
          <EmptyPlaceholder.Icon>
            <BarChart3 className="h-8 w-8 opacity-40 motion-safe:animate-pulse" />
          </EmptyPlaceholder.Icon>
          <EmptyPlaceholder.Title>No usage data yet</EmptyPlaceholder.Title>
          <EmptyPlaceholder.Description>
            Usage appears here once feature consumption is reported.
          </EmptyPlaceholder.Description>
        </EmptyPlaceholder>
      </CardContent>
    </Card>
  )
}

function buildChartData(
  rows: UsageDashboardData["timeseries"],
  dateFormat: string
): { data: UsageChartPoint[]; features: string[] } {
  const featureSet = new Set<string>()
  const pointsByDate = new Map<number, UsageChartPoint>()

  for (const row of rows) {
    featureSet.add(row.featureSlug)

    const point =
      pointsByDate.get(row.date) ??
      ({
        date: row.date,
        dateLabel: formatDateLabel(row.date, dateFormat),
      } satisfies UsageChartPoint)

    point[row.featureSlug] = row.usage
    pointsByDate.set(row.date, point)
  }

  return {
    data: [...pointsByDate.values()].sort((a, b) => a.date - b.date),
    features: [...featureSet].sort(),
  }
}

function formatDateLabel(timestamp: number, format: string): string {
  const date = new Date(timestamp)

  if (format.includes("hh:mm")) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatSpendingSummary(summary: UsageDashboardData["summary"]["spending"]): string {
  if (summary.length === 0) {
    return "No spend"
  }

  return summary.map((item) => item.displayAmount).join(" + ")
}
```

- [ ] **Step 3: Update project dashboard prefetch**

In `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx`, replace the three usage-related prefetches:

```ts
trpc.analytics.getProjectUsage.queryOptions(...)
trpc.analytics.getProjectUsageTimeseries.queryOptions(...)
trpc.analytics.getTopConsumers.queryOptions(...)
```

with this single prefetch:

```ts
trpc.analytics.getUsageDashboard.queryOptions(
  {
    range: filter.intervalFilter,
    topConsumersLimit: 10,
  },
  {
    ...ANALYTICS_CONFIG_REALTIME,
  }
),
```

- [ ] **Step 4: Replace the project dashboard wrapper**

Replace `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-stats.tsx` with this complete content:

```tsx
"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { useParams } from "next/navigation"
import { UsageDashboardSkeleton, UsageDashboardView } from "~/components/analytics/usage-dashboard-view"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

export { UsageDashboardSkeleton as UsageStatsSkeleton }

export function UsageStats() {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const params = useParams<{ workspaceSlug: string; projectSlug: string }>()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const {
    data,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(
      {
        range: intervalFilter.name,
        topConsumersLimit: 10,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 30 * 1000 : 0,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsageDashboard"],
      {
        input: {
          range: param,
          topConsumersLimit: 10,
        },
        type: "query",
      },
    ],
  })

  return (
    <UsageDashboardView
      data={data}
      intervalLabel={intervalFilter.label}
      dateFormat={intervalFilter.dateFormat}
      mode="project"
      isFetching={isFetching}
      customerHref={(customerId) =>
        `/${params.workspaceSlug}/${params.projectSlug}/customers/${customerId}`
      }
    />
  )
}
```

- [ ] **Step 5: Update customer dashboard prefetch**

In `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`, replace the two usage-related prefetches:

```ts
trpc.analytics.getProjectUsage.queryOptions(...)
trpc.analytics.getProjectUsageTimeseries.queryOptions(...)
```

with this single prefetch:

```ts
trpc.analytics.getUsageDashboard.queryOptions(
  {
    customerId,
    range: filter.intervalFilter,
  },
  {
    ...ANALYTICS_CONFIG_REALTIME,
  }
),
```

- [ ] **Step 6: Replace the customer dashboard wrapper**

Replace `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-metrics-panel.tsx` with this complete content:

```tsx
"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { UsageDashboardSkeleton, UsageDashboardView } from "~/components/analytics/usage-dashboard-view"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { ANALYTICS_CONFIG_REALTIME } from "~/trpc/shared"

type CustomerMetricsPanelProps = {
  customerId: string
  invoiceCount: number
}

export { UsageDashboardSkeleton as CustomerMetricsPanelSkeleton }

export function CustomerMetricsPanel({ customerId, invoiceCount }: CustomerMetricsPanelProps) {
  const [intervalFilter] = useIntervalFilter()
  const trpc = useTRPC()
  const isNearRealtime = intervalFilter.intervalDays === 1

  const {
    data,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getUsageDashboard.queryOptions(
      {
        customerId,
        range: intervalFilter.name,
      },
      {
        ...ANALYTICS_CONFIG_REALTIME,
        staleTime: isNearRealtime ? 30 * 1000 : 0,
        refetchInterval: isNearRealtime ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  useQueryInvalidation({
    paramKey: intervalFilter.name,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (param) => [
      ["analytics", "getUsageDashboard"],
      {
        input: {
          customerId,
          range: param,
        },
        type: "query",
      },
    ],
  })

  return (
    <UsageDashboardView
      data={data}
      intervalLabel={intervalFilter.label}
      dateFormat={intervalFilter.dateFormat}
      mode="customer"
      isFetching={isFetching}
      invoiceCount={invoiceCount}
    />
  )
}
```

- [ ] **Step 7: Typecheck Next.js**

Run:

```bash
pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/nextjs/src/components/analytics/usage-area-chart.tsx apps/nextjs/src/components/analytics/usage-dashboard-view.tsx 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-stats.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-metrics-panel.tsx'
git commit -m "refactor: use canonical usage dashboard query"
```

### Task 4: Remove Obsolete Dashboard Query Paths

**Files:**
- Delete: `internal/trpc/src/router/lambda/analytics/getProjectUsage.ts`
- Delete: `internal/trpc/src/router/lambda/analytics/getProjectUsageTimeseries.ts`
- Delete: `internal/trpc/src/router/lambda/analytics/getTopConsumers.ts`
- Delete: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-area-chart.tsx`
- Delete: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-usage-area-chart.tsx`
- Modify: `internal/trpc/src/router/lambda/analytics/index.ts`
- Modify: `internal/services/src/cache/namespaces.ts`
- Modify: `internal/services/src/cache/service.ts`

- [ ] **Step 1: Confirm the old tRPC procedures have no callers**

Run:

```bash
rg -n "getProjectUsage|getProjectUsageTimeseries|getTopConsumers" internal/trpc apps/nextjs
```

Expected output contains only the old procedure files and router registration lines.

- [ ] **Step 2: Remove old route registrations**

In `internal/trpc/src/router/lambda/analytics/index.ts`, remove these imports:

```ts
import { getProjectUsage } from "./getProjectUsage"
import { getProjectUsageTimeseries } from "./getProjectUsageTimeseries"
import { getTopConsumers } from "./getTopConsumers"
```

Remove these router entries:

```ts
getProjectUsage: getProjectUsage,
getProjectUsageTimeseries: getProjectUsageTimeseries,
getTopConsumers: getTopConsumers,
```

- [ ] **Step 3: Remove obsolete cache namespace types**

In `internal/services/src/cache/namespaces.ts`, remove these imports and types when unused:

```ts
import type { FeatureUsageTimeseriesRow } from "@unprice/analytics"
```

```ts
export type TopConsumerCacheEntry = {
  customerId: string
  email: string
  name: string
  totalUsage: number
  displaySpending: string
}
```

Remove these `CacheNamespaces` entries:

```ts
getUsageTimeseries: FeatureUsageTimeseriesRow[] | null
getTopConsumers: TopConsumerCacheEntry[] | null
```

Keep this entry because the public/API usage route still uses it:

```ts
getUsage: Usage | null
```

- [ ] **Step 4: Remove obsolete cache namespace instances**

In `internal/services/src/cache/service.ts`, remove these namespace instances:

```ts
getUsageTimeseries: new Namespace<CacheNamespaces["getUsageTimeseries"]>(this.context, {
  ...defaultOpts,
  fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS,
  stale: CACHE_ANALYTICS_STALENESS_TIME_MS,
}),
getTopConsumers: new Namespace<CacheNamespaces["getTopConsumers"]>(this.context, {
  ...defaultOpts,
  fresh: CACHE_ANALYTICS_FRESHNESS_TIME_MS,
  stale: CACHE_ANALYTICS_STALENESS_TIME_MS,
}),
```

Keep `getUsageDashboard` and `getUsage`.

- [ ] **Step 5: Delete obsolete files**

Delete these files:

```bash
rm internal/trpc/src/router/lambda/analytics/getProjectUsage.ts
rm internal/trpc/src/router/lambda/analytics/getProjectUsageTimeseries.ts
rm internal/trpc/src/router/lambda/analytics/getTopConsumers.ts
rm 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-area-chart.tsx'
rm 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-usage-area-chart.tsx'
```

- [ ] **Step 6: Confirm only the canonical dashboard query remains**

Run:

```bash
rg -n "getProjectUsage|getProjectUsageTimeseries|getTopConsumers" internal/trpc apps/nextjs internal/services/src/cache
```

Expected: no matches in `internal/trpc`, `apps/nextjs`, or cache files.

- [ ] **Step 7: Run focused verification**

Run:

```bash
pnpm --filter @unprice/services test:file src/use-cases/analytics/get-usage-dashboard.test.ts
pnpm --filter @unprice/services typecheck
pnpm --filter @unprice/trpc typecheck
pnpm --filter nextjs typecheck
```

Expected: all commands pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add internal/trpc/src/router/lambda/analytics/index.ts internal/services/src/cache/namespaces.ts internal/services/src/cache/service.ts internal/trpc/src/router/lambda/analytics/getProjectUsage.ts internal/trpc/src/router/lambda/analytics/getProjectUsageTimeseries.ts internal/trpc/src/router/lambda/analytics/getTopConsumers.ts 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/usage-area-chart.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/usage/customer-usage-area-chart.tsx'
git commit -m "chore: remove obsolete usage dashboard queries"
```

### Task 5: Full Validation And Visual Check

**Files:**
- No code files changed in this task.

- [ ] **Step 1: Run repository validation**

Run:

```bash
pnpm validate
```

Expected: PASS.

- [ ] **Step 2: Start the Next.js dev server**

Run:

```bash
pnpm --filter nextjs dev
```

Expected: Next.js starts and prints a local URL.

- [ ] **Step 3: Open the project dashboard and customer dashboard**

Open:

```text
http://app.localhost:3000/unprice-admin/unprice-admin/dashboard
http://app.localhost:3000/unprice-admin/unprice-admin/customers/cus_11XiKsW1cfkZxJWXRQD8fn
```

Expected:

- Project dashboard sends one `analytics.getUsageDashboard` request for usage dashboard data.
- Customer dashboard sends one `analytics.getUsageDashboard` request with `customerId`.
- Cards, table, and chart use the same final dense time-series state.
- The chart no longer drops a cumulative feature line to zero when that feature has no event in a later bucket.
- Project top consumers still render with links to customer pages.
- Customer dashboard still shows invoice count.

- [ ] **Step 4: Commit any verification-only test snapshot updates**

If no files changed during verification, skip this commit. If generated test snapshots changed, commit them with:

```bash
git add path/to/changed-snapshot
git commit -m "test: update usage dashboard snapshots"
```

## Self Review

Spec coverage:

- One canonical query for customer and project dashboards: Task 2 creates `getUsageDashboard`; Task 3 migrates both dashboards.
- Summary derived from time series: Task 1 builds dense cumulative time series and derives `features` and `summary` from it.
- Stale cache split removed between usage cards and chart: Task 2 caches the full dashboard payload under `getUsageDashboard`.
- Main project dashboard uses the same approach: Task 3 migrates project dashboard usage stats to the same tRPC procedure and shared view.
- Delete code no longer used: Task 4 removes old dashboard-specific tRPC routes, cache namespaces, and duplicate chart components.
- Keep public/API usage route intact: File structure and Task 4 explicitly keep `getUsage` and `apps/api` usage route.

Placeholder scan:

- No placeholder markers.
- Every code creation step includes concrete code.
- Every verification step includes exact commands and expected outcomes.

Type consistency:

- Service output uses camelCase fields: `featureSlug`, `displayAmount`, `topConsumers`.
- tRPC output schema is `getUsageDashboardOutputSchema`.
- Next.js types use `RouterOutputs["analytics"]["getUsageDashboard"]`.
- Cache namespace type is `GetUsageDashboardOutput | null`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-13-canonical-usage-dashboard.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
