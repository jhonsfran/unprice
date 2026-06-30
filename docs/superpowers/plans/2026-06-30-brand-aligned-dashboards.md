# Brand-Aligned Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Project, Customer, and Events dashboards so each one leads with the money path: ingestion health, usage/spend evidence, customer economic state, and recovery actions.

**Architecture:** Keep public API routes stable. Add small Next.js composition components around existing design-system primitives (`Card`, `Badge`, `Tabs`, `Table`, `Tooltip`, `Chart`, `Skeleton`) and keep business data ownership in services/use cases. Add one dashboard-only tRPC read model for customer economic summary counts so UI code does not infer domain counts from paginated table contracts.

**Tech Stack:** Next.js App Router, React Server Components, React Query, tRPC, TypeScript, Zod-backed RouterOutputs, `@unprice/ui` shadcn primitives, Recharts via `@unprice/ui/chart`, Tailwind, pnpm.

---

## Validated Constraints

- Follow `docs/brand/design-system-guidelines.md`: dashboard overview leads with operational health, usage evidence, spend, and failures.
- Do not add new public API endpoints. Use existing analytics procedures:
  - `analytics.getIngestionStatus`
  - `analytics.getUsageDashboard`
  - `analytics.getOverviewStats`
  - `analytics.replayIngestionEvents`
- Add one dashboard-only tRPC procedure:
  - `customers.getEconomicSummary`
- Continue using existing customer procedures for page bodies:
  - `customers.getSubscriptions`
  - `customers.getWallet`
  - `customers.getRuns`
  - `customers.getInvoices`
  - `customers.getEntitlements`
- Do not invent design-system primitives. Compose existing `@unprice/ui` primitives.
- Use `MoneyPath` only for empty states and explainers. Populated product dashboards must show actual state, not explanatory diagrams.
- Preserve the distinction between business decisions and system failures:
  - `rejected` is expected business enforcement.
  - `failed` is a system/pipeline failure.
  - `budget_exceeded` is a runtime spend-control state.
- Events rejection click behavior must not pretend the backend filters by `rejectionReason`. The current API filter supports `state`, `sourceId`, and `eventSlug`; exact rejection-reason filtering would require an explicit contract extension and is out of this plan.

## File Structure

Create:

- `apps/nextjs/src/components/analytics/ingestion-health-model.ts`
  - Pure helpers for success-rate formatting, pipeline-health tone, enforcement tone, attention counts, action filtering, and rejection panel filters.
- `apps/nextjs/src/components/analytics/ingestion-health-query.ts`
  - Pure helpers for stable `analytics.getIngestionStatus` query inputs shared by server prefetch and client components.
- `apps/nextjs/src/components/analytics/ingestion-events-filter-model.ts`
  - Pure helper that owns the selected top-rejection filter model used by the Events page.
- `apps/nextjs/src/components/analytics/ingestion-health-strip.tsx`
  - Shared health header for Project and Events dashboards.
- `apps/nextjs/src/components/analytics/request-path-sparkline.tsx`
  - Shared `live[]` chart for processed/rejected/failed request-path activity.
- `apps/nextjs/src/components/analytics/rejection-reasons-panel.tsx`
  - Shared top rejection reasons panel using existing filterable fields.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/operational-health.tsx`
  - Project dashboard client component that renders `analytics.getIngestionStatus`.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-tabs.tsx`
  - One customer tab navigation component reused by all customer detail pages.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-economic-header.tsx`
  - Customer header showing active state, customer id, active plan count, and wallet availability.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-money-path-summary.tsx`
  - Overview summary row linking to subscriptions, wallet, invoices, and runs.
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/layout.tsx`
  - Shared customer detail shell/header/tabs.
- `internal/services/src/use-cases/customer/get-economic-summary.ts`
  - Customer read model for run and invoice counts. Does count-only DB reads and does not refresh running runs.
- `internal/services/src/use-cases/customer/get-economic-summary.test.ts`
  - Use-case helper test for count mapping into the dashboard read model.
- `internal/trpc/src/router/lambda/customers/getEconomicSummary.ts`
  - tRPC adapter for the customer economic summary read model.

Modify:

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-panel.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-table-schema.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/overview-stats.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/tabs-dashboard.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx`
- `apps/nextjs/src/components/analytics/usage-dashboard-view.tsx`
- `internal/services/src/analytics/service.ts`
- `internal/services/src/use-cases/index.ts`
- `internal/trpc/src/router/lambda/customers/index.ts`

## Task 1: Baseline And Design Contract

**Files:** none

- [ ] **Step 1: Confirm the current worktree**

Run:

```bash
rtk git status --short
```

Expected: either `ok` from rtk for a clean tree or a list of changed files. Keep unrelated changed files untouched.

- [ ] **Step 2: Confirm Node and package manager**

Run:

```bash
rtk node -v
rtk pnpm -v
```

Expected: Node `v24.x` and pnpm `10.28.0`.

- [ ] **Step 3: Re-read the dashboard brand rules**

Run:

```bash
rtk sed -n '1,220p' docs/brand/design-system-guidelines.md
```

Confirm these rules before editing:

- Lead dashboard overview with operational health.
- Prefer calm density.
- Use exact states: `processed`, `rejected`, `failed`, `running`, `budget_exceeded`, `reserved`, `consumed`, `draft`, `finalized`, `paid`.
- Product UI should prefer actual state over explanatory diagrams.
- Wallet UI distinguishes purchased, granted, reserved, and consumed balances.

- [ ] **Step 4: Capture code landmarks**

Run:

```bash
rtk rg -n "getIngestionStatus|getUsageDashboard|getOverviewStats|getWallet|getRuns|getInvoices|getEntitlements" apps/nextjs/src/app/'(root)'/dashboard internal/trpc/src/router/lambda
```

Expected: hits in project dashboard, events panel, customer detail pages, and the tRPC routers.

- [ ] **Step 5: Commit checkpoint**

No files changed in this task. Do not commit.

## Task 2: Shared Ingestion Health Components

**Files:**

- Create: `apps/nextjs/src/components/analytics/ingestion-health-model.ts`
- Create: `apps/nextjs/src/components/analytics/ingestion-health-query.ts`
- Create: `apps/nextjs/src/components/analytics/ingestion-events-filter-model.ts`
- Create: `apps/nextjs/src/components/analytics/ingestion-health-strip.tsx`
- Create: `apps/nextjs/src/components/analytics/request-path-sparkline.tsx`
- Create: `apps/nextjs/src/components/analytics/rejection-reasons-panel.tsx`

- [ ] **Step 1: Create `ingestion-health-model.ts`**

Create `apps/nextjs/src/components/analytics/ingestion-health-model.ts`:

```ts
import type { RouterOutputs } from "@unprice/trpc/routes"

export type IngestionStatus = RouterOutputs["analytics"]["getIngestionStatus"]
export type IngestionRejection = IngestionStatus["rejections"][number]

export type IngestionQueryFilter = {
  state?: "processed" | "rejected" | "failed"
  sourceId?: string
  eventSlug?: string
}

export type IngestionTone = "default" | "success" | "warning" | "destructive"

const NON_ACTION_MESSAGES = new Set(["No immediate action required."])

export function formatSuccessRate(successRate: number): string {
  return `${(successRate * 100).toFixed(1)}%`
}

export function getAttentionCount(status: Pick<IngestionStatus, "totals">): number {
  return status.totals.rejected + status.totals.failed
}

export function getPipelineTone(status: Pick<IngestionStatus, "totals">): IngestionTone {
  if (status.totals.total === 0) {
    return "default"
  }

  if (status.totals.failed > 0) {
    return "destructive"
  }

  return "success"
}

export function getPipelineLabel(status: Pick<IngestionStatus, "totals">): string {
  if (status.totals.total === 0) {
    return "no events"
  }

  if (status.totals.failed > 0) {
    return "pipeline failing"
  }

  return "pipeline healthy"
}

export function getEnforcementTone(status: Pick<IngestionStatus, "totals">): IngestionTone {
  if (status.totals.rejected > 0) {
    return "warning"
  }

  return "default"
}

export function getEnforcementLabel(status: Pick<IngestionStatus, "totals">): string {
  if (status.totals.rejected > 0) {
    return "business denials"
  }

  return "no denials"
}

export function getActionMessages(status: Pick<IngestionStatus, "nextActions">): string[] {
  return status.nextActions.filter((message) => !NON_ACTION_MESSAGES.has(message))
}

export function getSuccessTone(status: Pick<IngestionStatus, "successRate" | "totals">): IngestionTone {
  if (status.totals.total === 0) {
    return "default"
  }

  if (status.totals.failed > 0) {
    return "destructive"
  }

  if (status.totals.rejected > 0 || status.successRate < 0.99) {
    return "warning"
  }

  return "success"
}

```

- [ ] **Step 2: Create `ingestion-health-query.ts`**

Create `apps/nextjs/src/components/analytics/ingestion-health-query.ts`:

```ts
import type { RouterInputs } from "@unprice/trpc/routes"
import type { IngestionQueryFilter } from "./ingestion-health-model"

export const INGESTION_HEALTH_WINDOW_MS = 60 * 60 * 1000

export type IngestionStatusInput = RouterInputs["analytics"]["getIngestionStatus"]

export function buildRollingIngestionWindow(now: number): IngestionStatusInput["window"] {
  return {
    from: now - INGESTION_HEALTH_WINDOW_MS,
    to: now,
  }
}

export function buildIngestionHealthInput({
  now,
  filter = {},
  limit = 5,
}: {
  now: number
  filter?: IngestionQueryFilter
  limit?: number
}): IngestionStatusInput {
  return {
    window: buildRollingIngestionWindow(now),
    filter,
    limit,
  }
}
```

- [ ] **Step 3: Create `ingestion-events-filter-model.ts`**

Create `apps/nextjs/src/components/analytics/ingestion-events-filter-model.ts`:

```ts
import type { IngestionQueryFilter, IngestionRejection } from "./ingestion-health-model"

export type SelectedIngestionFilter = {
  query: IngestionQueryFilter
  search: string | null
  label: string
}

export function buildSelectedRejectionFilter(rejection: IngestionRejection): SelectedIngestionFilter {
  return {
    query: {
      state: "rejected",
      eventSlug: rejection.eventSlug,
      sourceId: rejection.sourceId,
    },
    search: rejection.eventSlug,
    label: `${rejection.eventSlug} / ${rejection.sourceType}`,
  }
}

export function getSelectedIngestionQueryFilter(
  selectedFilter: SelectedIngestionFilter | null
): IngestionQueryFilter {
  return selectedFilter?.query ?? {}
}
```

- [ ] **Step 4: Create `ingestion-health-strip.tsx`**

Create `apps/nextjs/src/components/analytics/ingestion-health-strip.tsx`:

```tsx
"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { cn } from "@unprice/ui/utils"
import { AlertTriangle, CheckCircle2, CircleSlash, ShieldAlert, XCircle } from "lucide-react"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { NumberTicker } from "~/components/analytics/number-ticker"
import {
  type IngestionStatus,
  formatSuccessRate,
  getActionMessages,
  getAttentionCount,
  getEnforcementLabel,
  getEnforcementTone,
  getPipelineLabel,
  getPipelineTone,
  getSuccessTone,
} from "./ingestion-health-model"

type IngestionHealthStripProps = {
  status: IngestionStatus
  isFetching?: boolean
  title: string
  description: string
  className?: string
}

export function IngestionHealthStrip({
  status,
  isFetching = false,
  title,
  description,
  className,
}: IngestionHealthStripProps) {
  const pipelineTone = getPipelineTone(status)
  const enforcementTone = getEnforcementTone(status)
  const successTone = getSuccessTone(status)
  const attentionCount = getAttentionCount(status)
  const actionMessages = getActionMessages(status)

  return (
    <Card className={cn("overflow-hidden border-muted/60", className)}>
      <div
        className={cn(
          "pointer-events-none h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent transition-opacity duration-300 motion-reduce:transition-none",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{title}</CardTitle>
              <Badge variant={pipelineTone}>{getPipelineLabel(status)}</Badge>
              <Badge variant={enforcementTone}>{getEnforcementLabel(status)}</Badge>
            </div>
            <CardDescription>{description}</CardDescription>
          </div>
          <FreshnessIndicator generatedAt={status.freshness.generatedAt} isFetching={isFetching} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-6">
        <div className="grid gap-3 md:grid-cols-5">
          <HealthMetric
            label="Success"
            value={formatSuccessRate(status.successRate)}
            helper="processed / total"
            tone={successTone}
            icon={<CheckCircle2 className="size-4" />}
          />
          <HealthMetric
            label="Processed"
            value={<NumberTicker value={status.totals.processed} decimalPlaces={0} startValue={0} />}
            helper="accepted events"
            tone="success"
            icon={<CheckCircle2 className="size-4" />}
          />
          <HealthMetric
            label="Rejected"
            value={<NumberTicker value={status.totals.rejected} decimalPlaces={0} startValue={0} />}
            helper="business denials"
            tone={status.totals.rejected > 0 ? "warning" : "default"}
            icon={<CircleSlash className="size-4" />}
          />
          <HealthMetric
            label="Failed"
            value={<NumberTicker value={status.totals.failed} decimalPlaces={0} startValue={0} />}
            helper="system failures"
            tone={status.totals.failed > 0 ? "destructive" : "default"}
            icon={<XCircle className="size-4" />}
          />
          <HealthMetric
            label="Attention"
            value={<NumberTicker value={attentionCount} decimalPlaces={0} startValue={0} />}
            helper="rejected + failed"
            tone={attentionCount > 0 ? "warning" : "success"}
            icon={<AlertTriangle className="size-4" />}
          />
        </div>
        {actionMessages.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-warning-text text-sm">
            {actionMessages.map((message) => (
              <div key={message} className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <span>{message}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function HealthMetric({
  label,
  value,
  helper,
  tone,
  icon,
}: {
  label: string
  value: React.ReactNode
  helper: string
  tone: "default" | "success" | "warning" | "destructive"
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{label}</p>
        <span
          className={cn(
            "text-muted-foreground",
            tone === "success" && "text-success",
            tone === "warning" && "text-warning",
            tone === "destructive" && "text-danger"
          )}
        >
          {icon}
        </span>
      </div>
      <div className="mt-1 font-semibold text-2xl text-foreground tabular-nums">{value}</div>
      <p className="mt-1 text-muted-foreground text-xs">{helper}</p>
    </div>
  )
}
```

- [ ] **Step 5: Create `request-path-sparkline.tsx`**

Create `apps/nextjs/src/components/analytics/request-path-sparkline.tsx`:

```tsx
"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@unprice/ui/chart"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import type { IngestionStatus } from "./ingestion-health-model"

const chartConfig = {
  processed: { label: "Processed", color: "var(--chart-1)" },
  rejected: { label: "Rejected", color: "var(--chart-3)" },
  failed: { label: "Failed", color: "var(--chart-5)" },
} satisfies ChartConfig

export function RequestPathSparkline({ live }: { live: IngestionStatus["live"] }) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Request path</CardTitle>
        <CardDescription>Processed, rejected, and failed ingestion events by second.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        {live.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
            No live ingestion samples in this window.
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[220px] w-full">
            <LineChart accessibilityLayer data={live} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
              <CartesianGrid vertical={false} className="stroke-muted" />
              <XAxis
                dataKey="second"
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
              />
              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
              <Line type="monotone" dataKey="processed" stroke="var(--color-processed)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="rejected" stroke="var(--color-rejected)" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="failed" stroke="var(--color-failed)" strokeWidth={2} dot={false} />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 6: Create `rejection-reasons-panel.tsx`**

Create `apps/nextjs/src/components/analytics/rejection-reasons-panel.tsx`:

```tsx
"use client"

import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { ArrowRight } from "lucide-react"
import {
  type SelectedIngestionFilter,
  buildSelectedRejectionFilter,
} from "./ingestion-events-filter-model"
import type { IngestionRejection } from "./ingestion-health-model"

type RejectionReasonsPanelProps = {
  rejections: IngestionRejection[]
  onSelectFilter?: (filter: SelectedIngestionFilter) => void
}

export function RejectionReasonsPanel({ rejections, onSelectFilter }: RejectionReasonsPanelProps) {
  return (
    <Card className="border-muted/60">
      <CardHeader>
        <CardTitle>Top rejection reasons</CardTitle>
        <CardDescription>Business denials grouped by reason, event, and source.</CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        {rejections.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
            No rejected events in this window.
          </div>
        ) : (
          <div className="divide-y rounded-md border">
            {rejections.slice(0, 5).map((rejection) => (
              <button
                key={`${rejection.rejectionReason ?? "unknown"}:${rejection.eventSlug}:${rejection.sourceId}`}
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelectFilter?.(buildSelectedRejectionFilter(rejection))}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-sm">
                    {rejection.rejectionReason ?? "unknown_reason"}
                  </span>
                  <span className="block truncate font-mono text-muted-foreground text-xs">
                    {rejection.eventSlug} / {rejection.sourceType}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant="warning">{rejection.eventCount}</Badge>
                  <ArrowRight className="size-4 text-muted-foreground" />
                </span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 7: Verify type imports**

Run:

```bash
rtk pnpm --filter nextjs typecheck
```

Expected before consumers are wired: this may fail if unused files are typechecked with import issues. Fix only import/type errors in the new files.

- [ ] **Step 8: Commit**

```bash
rtk git add apps/nextjs/src/components/analytics/ingestion-health-model.ts apps/nextjs/src/components/analytics/ingestion-health-query.ts apps/nextjs/src/components/analytics/ingestion-events-filter-model.ts apps/nextjs/src/components/analytics/ingestion-health-strip.tsx apps/nextjs/src/components/analytics/request-path-sparkline.tsx apps/nextjs/src/components/analytics/rejection-reasons-panel.tsx
rtk git commit -m "feat: add shared ingestion health dashboard components"
```

## Task 3: Events Dashboard Health Header And Request Path

**Files:**

- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-panel.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-table-schema.tsx`

- [ ] **Step 1: Replace generic skeleton boxes with stable health/table skeleton**

In `events/page.tsx`, add:

```tsx
import { Skeleton } from "@unprice/ui/skeleton"
```

Then replace the `fallback` JSX with:

```tsx
fallback={
  <div className="flex flex-col gap-6">
    <Skeleton className="h-[250px] rounded-lg" />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Skeleton className="h-[340px] rounded-lg" />
      <Skeleton className="h-[340px] rounded-lg" />
    </div>
    <Skeleton className="h-[520px] rounded-md" />
  </div>
}
```

- [ ] **Step 2: Import shared components**

In `ingestion-events-panel.tsx`, add:

```tsx
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import {
  type SelectedIngestionFilter,
  getSelectedIngestionQueryFilter,
} from "~/components/analytics/ingestion-events-filter-model"
import { RejectionReasonsPanel } from "~/components/analytics/rejection-reasons-panel"
import { RequestPathSparkline } from "~/components/analytics/request-path-sparkline"
```

Remove local metric-card-only imports that become unused after deleting `IngestionStatsCards`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  Activity,
  CheckCircle2,
  TriangleAlert,
  XCircle,
} from "lucide-react"
import { NumberTicker } from "~/components/analytics/number-ticker"
```

Keep imports used by the table:

```tsx
import { AlertTriangle, RotateCcw } from "lucide-react"
```

- [ ] **Step 3: Add selected ingestion filter state**

Inside `useIngestionEventsData`, after `const [pendingReplayIds, setPendingReplayIds] = useState...`, add:

```tsx
const [selectedIngestionFilter, setSelectedIngestionFilter] = useState<SelectedIngestionFilter | null>(null)
```

In the `getIngestionStatus.infiniteQueryOptions` input, add:

```tsx
filter: getSelectedIngestionQueryFilter(selectedIngestionFilter),
```

The query input should become:

```tsx
{
  window: queryWindow,
  filter: getSelectedIngestionQueryFilter(selectedIngestionFilter),
  limit: EVENTS_PAGE_SIZE,
}
```

- [ ] **Step 4: Return full first-page status and filter setter**

In the object returned by `useIngestionEventsData`, add:

```tsx
status: firstPage,
selectedIngestionFilter,
setSelectedIngestionFilter,
```

Keep the existing `processed`, `rejected`, `failed`, and `total` values until the local stats component is removed.

- [ ] **Step 5: Render the new health header and panels**

In `IngestionEventsPanel`, destructure the new values:

```tsx
status,
selectedIngestionFilter,
setSelectedIngestionFilter,
```

Replace:

```tsx
<IngestionStatsCards
  processed={processed}
  rejected={rejected}
  failed={failed}
  total={total}
  windowLabel={windowLabel}
/>
```

with:

```tsx
{status ? (
  <>
    <IngestionHealthStrip
      status={status}
      isFetching={isRefreshing}
      title="Ingestion health"
      description={`Events ${windowLabel}. Rejections are business denials; failures need recovery.`}
    />
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <RequestPathSparkline live={status.live} />
      <RejectionReasonsPanel
        rejections={status.rejections}
        onSelectFilter={(selection) => {
          setSelectedIngestionFilter(selection)
          void setFilters({ search: selection.search })
        }}
      />
    </div>
  </>
) : null}
{selectedIngestionFilter ? (
  <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
    <span>
      Showing rejected events for <span className="font-mono">{selectedIngestionFilter.label}</span>
    </span>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        setSelectedIngestionFilter(null)
        void setFilters({ search: null })
      }}
    >
      Clear filter
    </Button>
  </div>
) : null}
```

- [ ] **Step 6: Delete the local `IngestionStatsCards` function**

Delete the full local `IngestionStatsCards` function from `ingestion-events-panel.tsx`. The shared `IngestionHealthStrip` is now the owner of that presentation.

- [ ] **Step 7: Add rejection reason filter options to the table sidebar**

In `buildIngestionEventsFilters`, before the `return`, add:

```tsx
const rejectionReasonOptions = Array.from(
  new Set(rows.map((row) => row.rejectionReason).filter((value): value is string => Boolean(value)))
)
  .sort()
  .map((rejectionReason) => ({
    label: rejectionReason,
    value: rejectionReason,
  }))
```

Add this checkbox filter before `customerId`:

```tsx
{
  type: "checkbox",
  id: "rejectionReason",
  label: "Rejection reason",
  showCounts: true,
  hideEmptyOptions: true,
  emptyOptionsLabel: "No rejection reasons for the selected filters",
  options: rejectionReasonOptions,
},
```

This filter is client-side for visible rows. The top rejection panel uses server-supported fields (`state`, `eventSlug`, `sourceId`) to narrow the query.

- [ ] **Step 8: Verify**

Run:

```bash
rtk pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 9: Manual QA**

With the dev server running, open:

```text
http://app.localhost:3000/<workspace>/<project>/events
```

Check:

- The health header shows success rate, processed, rejected, failed, attention, and freshness.
- The sparkline renders when `live[]` has rows and shows the empty chart state when it does not.
- Clicking a rejection reason narrows to rejected events for the event/source.
- Clearing the filter restores the rolling events view.
- Replay selected still works for failed replayable rows.

- [ ] **Step 10: Commit**

```bash
rtk git add 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-panel.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-table-schema.tsx'
rtk git commit -m "feat: lead events dashboard with ingestion health"
```

## Task 4: Project Dashboard Operational Overview

**Files:**

- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/operational-health.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/overview-stats.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/tabs-dashboard.tsx`
- Modify: `internal/services/src/analytics/service.ts`

- [ ] **Step 1: Create `operational-health.tsx`**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/operational-health.tsx`:

```tsx
"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Skeleton } from "@unprice/ui/skeleton"
import { useEffect, useMemo, useState } from "react"
import { buildIngestionHealthInput } from "~/components/analytics/ingestion-health-query"
import { IngestionHealthStrip } from "~/components/analytics/ingestion-health-strip"
import { useTRPC } from "~/trpc/client"

const OPERATIONAL_HEALTH_REFRESH_MS = 15 * 1000

export function OperationalHealth({ initialNow }: { initialNow: number }) {
  const trpc = useTRPC()
  const [windowNow, setWindowNow] = useState(initialNow)
  const queryInput = useMemo(() => buildIngestionHealthInput({ now: windowNow }), [windowNow])

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setWindowNow(Date.now())
    }, OPERATIONAL_HEALTH_REFRESH_MS)

    return () => globalThis.clearInterval(intervalId)
  }, [])

  const { data, isFetching } = useSuspenseQuery(
    trpc.analytics.getIngestionStatus.queryOptions(
      queryInput,
      {
        staleTime: 15 * 1000,
        refetchInterval: 15 * 1000,
        refetchOnWindowFocus: true,
      }
    )
  )

  return (
    <IngestionHealthStrip
      status={data}
      isFetching={isFetching}
      title="Operational health"
      description="Ingestion health for the last hour. Rejections are business denials; failures need recovery."
    />
  )
}

export function OperationalHealthSkeleton() {
  return <Skeleton className="h-[250px] rounded-lg" />
}
```

- [ ] **Step 2: Wire `OperationalHealth` above usage evidence**

In `dashboard/page.tsx`, add:

```tsx
import { buildIngestionHealthInput } from "~/components/analytics/ingestion-health-query"
import { OperationalHealth, OperationalHealthSkeleton } from "./_components/operational-health"
```

After `const now = Date.now()`, add:

```tsx
const healthInput = buildIngestionHealthInput({ now })
```

In the existing `batchPrefetch`, replace the inline `analytics.getIngestionStatus` input with `healthInput`:

```tsx
trpc.analytics.getIngestionStatus.queryOptions(healthInput, {
  staleTime: 15 * 1000,
})
```

Replace the `HydrateClient` content with this order:

```tsx
<HydrateClient>
  <div className="min-h-[250px]">
    <Suspense fallback={<OperationalHealthSkeleton />}>
      <OperationalHealth initialNow={now} />
    </Suspense>
  </div>
  <div className="min-h-[520px]">
    <Suspense fallback={<UsageStatsSkeleton />}>
      <UsageStats />
    </Suspense>
  </div>
  <div className="min-h-[150px]">
    <Suspense fallback={<OverviewStatsSkeleton isLoading={true} />}>
      <OverviewStats />
    </Suspense>
  </div>
</HydrateClient>
```

The final hierarchy must be:

1. Operational health.
2. Usage and spend evidence.
3. Growth/supporting stats.

- [ ] **Step 3: Relabel the dashboard tab copy**

In `tabs-dashboard.tsx`, replace the overview tab text:

```tsx
Usage{" "}
```

with:

```tsx
Overview{" "}
```

- [ ] **Step 4: Relabel ledger-backed revenue**

In `internal/services/src/analytics/service.ts`, replace:

```ts
title: "Total Revenue",
```

with:

```ts
title: "Recognized revenue",
```

Keep the existing ledger-backed recognized revenue query. Do not change the amount calculation.

- [ ] **Step 5: Demote growth card copy**

In `overview-stats.tsx`, replace the skeleton labels:

```tsx
{ title: "Total Revenue" },
```

with:

```tsx
{ title: "Recognized revenue" },
```

In the same file, add a wrapper label above `StatsCards`:

```tsx
<div className="mb-3 flex flex-col gap-1">
  <p className="font-medium text-sm">Growth evidence</p>
  <p className="text-muted-foreground text-xs">
    Supporting business context. Operational health and spend evidence above are the primary dashboard state.
  </p>
</div>
```

Place it immediately before:

```tsx
<StatsCards stats={statsCards} />
```

- [ ] **Step 6: Verify**

Run:

```bash
rtk pnpm --filter nextjs typecheck
rtk pnpm --filter @unprice/services typecheck
```

Expected: PASS.

- [ ] **Step 7: Manual QA**

Open:

```text
http://app.localhost:3000/<workspace>/<project>/dashboard
```

Check:

- Health renders above usage.
- Usage and spend evidence remains unchanged.
- Growth cards are below usage.
- The revenue card reads `Recognized revenue`.
- The existing interval filter still controls usage and growth cards.

- [ ] **Step 8: Commit**

```bash
rtk git add internal/services/src/analytics/service.ts 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/operational-health.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/overview-stats.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/_components/tabs-dashboard.tsx'
rtk git commit -m "feat: lead project dashboard with operational health"
```

## Task 5: Customer Detail Layout And Economic Header

**Files:**

- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/layout.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-tabs.tsx`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-economic-header.tsx`
- Modify: all five customer detail pages to remove duplicated `DashboardShell`, `HeaderTab`, and `TabNavigation` wrappers:
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx`
  - `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx`

- [ ] **Step 1: Create `customer-tabs.tsx`**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-tabs.tsx`:

```tsx
"use client"

import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { usePathname } from "next/navigation"
import { SuperLink } from "~/components/super-link"

const tabs = [
  { label: "Overview", href: "" },
  { label: "Subscriptions", href: "/subscriptions" },
  { label: "Wallet & Credits", href: "/wallet" },
  { label: "Invoices", href: "/invoices" },
  { label: "Runs", href: "/runs" },
] as const

export function CustomerTabs({ baseUrl }: { baseUrl: string }) {
  const pathname = usePathname()

  return (
    <TabNavigation>
      <div className="flex items-center overflow-x-auto">
        {tabs.map((tab) => {
          const href = `${baseUrl}${tab.href}`
          const active = tab.href === "" ? pathname === baseUrl : pathname.startsWith(href)

          return (
            <TabNavigationLink key={tab.label} asChild active={active}>
              <SuperLink href={href}>{tab.label}</SuperLink>
            </TabNavigationLink>
          )
        })}
      </div>
    </TabNavigation>
  )
}
```

- [ ] **Step 2: Create `customer-economic-header.tsx`**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-economic-header.tsx`:

```tsx
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import HeaderTab from "~/components/layout/header-tab"
import { CustomerActions } from "../../../_components/customers/customer-actions"
import { formatWalletMoney } from "../../../_components/wallet/format-wallet-money"

type Customer = RouterOutputs["customers"]["getSubscriptions"]["customer"]
type Wallet = RouterOutputs["customers"]["getWallet"]["wallet"]

export function CustomerEconomicHeader({
  customer,
  wallet,
}: {
  customer: Customer
  wallet: Wallet
}) {
  const activeSubscriptions = customer.subscriptions.filter((subscription) => subscription.active)
  const activePlanLabel =
    activeSubscriptions.length === 0
      ? "No active plan"
      : activeSubscriptions.length === 1
        ? activeSubscriptions[0]?.planSlug ?? "Active plan"
        : `${activeSubscriptions.length} active plans`
  const available = wallet.balances.purchased + wallet.balances.granted

  return (
    <HeaderTab
      title={customer.email}
      description={customer.description}
      label={customer.active ? "active" : "inactive"}
      id={customer.id}
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant="outline">{activePlanLabel}</Badge>
          <Badge variant={available > 0 ? "success" : "warning"}>
            Wallet {formatWalletMoney(available, wallet.currency)}
          </Badge>
          <CustomerActions customer={customer} />
        </div>
      }
    />
  )
}
```

- [ ] **Step 3: Create shared customer layout**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/layout.tsx`:

```tsx
import { notFound } from "next/navigation"
import { DashboardShell } from "~/components/layout/dashboard-shell"
import { api } from "~/trpc/server"
import { CustomerEconomicHeader } from "./_components/customer-economic-header"
import { CustomerTabs } from "./_components/customer-tabs"

export default async function CustomerDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: {
    workspaceSlug: string
    projectSlug: string
    customerId: string
  }
}) {
  const { workspaceSlug, projectSlug, customerId } = params
  const baseUrl = `/${workspaceSlug}/${projectSlug}/customers/${customerId}`

  const [{ customer }, walletResult] = await Promise.all([
    api.customers.getSubscriptions({ customerId }),
    api.customers.getWallet({ customerId }),
  ])

  if (!customer || !walletResult.customer) {
    notFound()
  }

  return (
    <DashboardShell header={<CustomerEconomicHeader customer={customer} wallet={walletResult.wallet} />}>
      <CustomerTabs baseUrl={baseUrl} />
      {children}
    </DashboardShell>
  )
}
```

- [ ] **Step 4: Remove duplicated shells from customer pages**

For each customer detail page, remove:

- `DashboardShell` imports and wrapper.
- `HeaderTab` imports and wrapper.
- `TabNavigation` and `TabNavigationLink` imports and JSX.
- `SuperLink` imports when only used by the duplicated tabs.
- `CustomerActions` imports when only used by the duplicated header.

Each page should return only the page body. For example, `wallet/page.tsx` should return:

```tsx
return (
  <div className="mt-4 flex flex-col gap-6">
    <WalletBalanceSummary wallet={wallet} />
    <div>
      ...
    </div>
  </div>
)
```

Keep each page's existing `api.customers.*` body call. Task 6 adds a compact overview read model for summary counts only.

- [ ] **Step 5: Verify**

Run:

```bash
rtk pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 6: Manual QA**

Open each tab:

```text
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/subscriptions
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/wallet
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/invoices
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/runs
```

Check:

- Header is consistent.
- Active tab state is correct.
- Wallet availability in the header matches wallet tab available amount.
- Existing page tables and filters still render.

- [ ] **Step 7: Commit**

```bash
rtk git add 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]'
rtk git commit -m "feat: add customer economic detail layout"
```

## Task 6: Customer Economic Summary Read Model And Overview Row

**Files:**

- Create: `internal/services/src/use-cases/customer/get-economic-summary.ts`
- Create: `internal/services/src/use-cases/customer/get-economic-summary.test.ts`
- Create: `internal/trpc/src/router/lambda/customers/getEconomicSummary.ts`
- Create: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-money-path-summary.tsx`
- Modify: `internal/services/src/use-cases/index.ts`
- Modify: `internal/trpc/src/router/lambda/customers/index.ts`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx`

- [ ] **Step 1: Create the customer economic summary use case**

Create `internal/services/src/use-cases/customer/get-economic-summary.ts`:

```ts
import type { Database } from "@unprice/db"
import { and, count, eq } from "@unprice/db"
import { budgetRuns, invoices } from "@unprice/db/schema"
import { Err, FetchError, Ok, type Result, wrapResult } from "@unprice/error"
import type { Logger } from "@unprice/logs"
import { z } from "zod"

export const getCustomerEconomicSummaryInputSchema = z.object({
  projectId: z.string(),
  customerId: z.string(),
})

export const getCustomerEconomicSummaryOutputSchema = z.object({
  customerId: z.string(),
  runCounts: z.object({
    total: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    budgetExceeded: z.number().int().nonnegative(),
  }),
  invoiceCounts: z.object({
    total: z.number().int().nonnegative(),
    paid: z.number().int().nonnegative(),
  }),
})

export type GetCustomerEconomicSummaryInput = z.infer<typeof getCustomerEconomicSummaryInputSchema>
export type GetCustomerEconomicSummaryOutput = z.infer<typeof getCustomerEconomicSummaryOutputSchema>

export type GetCustomerEconomicSummaryDeps = {
  db: Database
  logger: Pick<Logger, "error">
}

type CountRow = { count: number } | undefined

export function buildCustomerEconomicSummary(input: {
  customerId: string
  totalRuns: number
  runningRuns: number
  budgetExceededRuns: number
  totalInvoices: number
  paidInvoices: number
}): GetCustomerEconomicSummaryOutput {
  return getCustomerEconomicSummaryOutputSchema.parse({
    customerId: input.customerId,
    runCounts: {
      total: input.totalRuns,
      running: input.runningRuns,
      budgetExceeded: input.budgetExceededRuns,
    },
    invoiceCounts: {
      total: input.totalInvoices,
      paid: input.paidInvoices,
    },
  })
}

export async function getCustomerEconomicSummary(
  deps: GetCustomerEconomicSummaryDeps,
  rawInput: GetCustomerEconomicSummaryInput
): Promise<Result<GetCustomerEconomicSummaryOutput | null, FetchError>> {
  const input = getCustomerEconomicSummaryInputSchema.parse(rawInput)

  const result = await wrapResult(
    deps.db.transaction(async (tx) => {
      const customer = await tx.query.customers.findFirst({
        columns: {
          id: true,
        },
        where: (table, { and, eq }) =>
          and(eq(table.id, input.customerId), eq(table.projectId, input.projectId)),
      })

      if (!customer) {
        return null
      }

      const [
        totalRuns,
        runningRuns,
        budgetExceededRuns,
        totalInvoices,
        paidInvoices,
      ] = await Promise.all([
        tx
          .select({ count: count() })
          .from(budgetRuns)
          .where(and(eq(budgetRuns.customerId, input.customerId), eq(budgetRuns.projectId, input.projectId))),
        tx
          .select({ count: count() })
          .from(budgetRuns)
          .where(
            and(
              eq(budgetRuns.customerId, input.customerId),
              eq(budgetRuns.projectId, input.projectId),
              eq(budgetRuns.status, "running")
            )
          ),
        tx
          .select({ count: count() })
          .from(budgetRuns)
          .where(
            and(
              eq(budgetRuns.customerId, input.customerId),
              eq(budgetRuns.projectId, input.projectId),
              eq(budgetRuns.status, "budget_exceeded")
            )
          ),
        tx
          .select({ count: count() })
          .from(invoices)
          .where(and(eq(invoices.customerId, input.customerId), eq(invoices.projectId, input.projectId))),
        tx
          .select({ count: count() })
          .from(invoices)
          .where(
            and(
              eq(invoices.customerId, input.customerId),
              eq(invoices.projectId, input.projectId),
              eq(invoices.status, "paid")
            )
          ),
      ])

      return buildCustomerEconomicSummary({
        customerId: input.customerId,
        totalRuns: getCount(totalRuns[0]),
        runningRuns: getCount(runningRuns[0]),
        budgetExceededRuns: getCount(budgetExceededRuns[0]),
        totalInvoices: getCount(totalInvoices[0]),
        paidInvoices: getCount(paidInvoices[0]),
      })
    }),
    (error) =>
      new FetchError({
        message: `error getting customer economic summary: ${error.message}`,
        retry: false,
      })
  )

  if (result.err) {
    deps.logger.error(result.err, {
      context: "error getting customer economic summary",
      projectId: input.projectId,
      customerId: input.customerId,
    })
    return Err(result.err)
  }

  return Ok(result.val ?? null)
}

function getCount(row: CountRow): number {
  return row?.count ?? 0
}
```

- [ ] **Step 2: Add the focused use-case test**

Create `internal/services/src/use-cases/customer/get-economic-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildCustomerEconomicSummary } from "./get-economic-summary"

describe("buildCustomerEconomicSummary", () => {
  it("maps run and invoice counts into the dashboard read model", () => {
    expect(
      buildCustomerEconomicSummary({
        customerId: "cus_123",
        totalRuns: 9,
        runningRuns: 2,
        budgetExceededRuns: 1,
        totalInvoices: 4,
        paidInvoices: 3,
      })
    ).toEqual({
      customerId: "cus_123",
      runCounts: {
        total: 9,
        running: 2,
        budgetExceeded: 1,
      },
      invoiceCounts: {
        total: 4,
        paid: 3,
      },
    })
  })
})
```

- [ ] **Step 3: Export the use case**

In `internal/services/src/use-cases/index.ts`, add:

```ts
export {
  getCustomerEconomicSummary,
  getCustomerEconomicSummaryInputSchema,
  getCustomerEconomicSummaryOutputSchema,
} from "./customer/get-economic-summary"
export type {
  GetCustomerEconomicSummaryDeps,
  GetCustomerEconomicSummaryInput,
  GetCustomerEconomicSummaryOutput,
} from "./customer/get-economic-summary"
```

- [ ] **Step 4: Add the tRPC adapter**

Create `internal/trpc/src/router/lambda/customers/getEconomicSummary.ts`:

```ts
import { TRPCError } from "@trpc/server"
import {
  getCustomerEconomicSummary,
  getCustomerEconomicSummaryOutputSchema,
} from "@unprice/services/use-cases"
import { z } from "zod"
import { protectedProjectProcedure } from "#trpc"

export const getEconomicSummary = protectedProjectProcedure
  .input(
    z.object({
      customerId: z.string(),
    })
  )
  .output(getCustomerEconomicSummaryOutputSchema)
  .query(async (opts) => {
    const result = await getCustomerEconomicSummary(
      {
        db: opts.ctx.db,
        logger: opts.ctx.logger,
      },
      {
        projectId: opts.ctx.project.id,
        customerId: opts.input.customerId,
      }
    )

    if (result.err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: result.err.message,
      })
    }

    if (!result.val) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Customer not found",
      })
    }

    return result.val
  })
```

- [ ] **Step 5: Register the tRPC procedure**

In `internal/trpc/src/router/lambda/customers/index.ts`, add the import:

```ts
import { getEconomicSummary } from "./getEconomicSummary"
```

Add it to `customersRouter`:

```ts
getEconomicSummary: getEconomicSummary,
```

- [ ] **Step 6: Create `customer-money-path-summary.tsx`**

Create `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-money-path-summary.tsx`:

```tsx
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Badge } from "@unprice/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@unprice/ui/card"
import { CreditCard, FileText, Gauge, ShieldCheck, Wallet } from "lucide-react"
import { SuperLink } from "~/components/super-link"
import { formatWalletMoney } from "../../../_components/wallet/format-wallet-money"

type SubscriptionsCustomer = RouterOutputs["customers"]["getSubscriptions"]["customer"]
type WalletData = RouterOutputs["customers"]["getWallet"]["wallet"]
type EntitlementsData = RouterOutputs["customers"]["getEntitlements"]["entitlements"]
type EconomicSummary = RouterOutputs["customers"]["getEconomicSummary"]

type CustomerMoneyPathSummaryProps = {
  baseUrl: string
  customer: SubscriptionsCustomer
  wallet: WalletData
  entitlements: EntitlementsData
  summary: EconomicSummary
}

export function CustomerMoneyPathSummary({
  baseUrl,
  customer,
  wallet,
  entitlements,
  summary,
}: CustomerMoneyPathSummaryProps) {
  const activeSubscriptions = customer.subscriptions.filter((subscription) => subscription.active)
  const available = wallet.balances.purchased + wallet.balances.granted

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <SummaryTile
        href={`${baseUrl}/subscriptions`}
        icon={<CreditCard className="size-4" />}
        title="Subscription"
        primary={activeSubscriptions.length === 0 ? "none" : `${activeSubscriptions.length} active`}
        secondary={`${customer.subscriptions.length} total`}
        tone={activeSubscriptions.length > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/subscriptions`}
        icon={<ShieldCheck className="size-4" />}
        title="Entitlements"
        primary={`${entitlements.length} features`}
        secondary="access grants"
        tone={entitlements.length > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/wallet`}
        icon={<Wallet className="size-4" />}
        title="Wallet"
        primary={formatWalletMoney(available, wallet.currency)}
        secondary={`${formatWalletMoney(wallet.balances.reserved, wallet.currency)} held`}
        tone={available > 0 ? "success" : "warning"}
      />
      <SummaryTile
        href={`${baseUrl}/runs`}
        icon={<Gauge className="size-4" />}
        title="Runs"
        primary={`${summary.runCounts.total} total`}
        secondary={`${summary.runCounts.running} running / ${summary.runCounts.budgetExceeded} budget exceeded`}
        tone={summary.runCounts.budgetExceeded > 0 ? "destructive" : summary.runCounts.running > 0 ? "warning" : "default"}
      />
      <SummaryTile
        href={`${baseUrl}/invoices`}
        icon={<FileText className="size-4" />}
        title="Invoices"
        primary={`${summary.invoiceCounts.total} total`}
        secondary={`${summary.invoiceCounts.paid} paid`}
        tone={summary.invoiceCounts.total === 0 ? "default" : summary.invoiceCounts.paid > 0 ? "success" : "warning"}
      />
    </div>
  )
}

function SummaryTile({
  href,
  icon,
  title,
  primary,
  secondary,
  tone,
}: {
  href: string
  icon: React.ReactNode
  title: string
  primary: string
  secondary: string
  tone: "default" | "success" | "warning" | "destructive"
}) {
  return (
    <SuperLink href={href} className="block">
      <Card className="h-full border-muted/60 transition-colors hover:border-primary/50 motion-reduce:transition-none">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="font-medium text-sm">{title}</CardTitle>
          <span className="text-muted-foreground">{icon}</span>
        </CardHeader>
        <CardContent>
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-semibold text-lg">{primary}</p>
            <Badge variant={tone} className="shrink-0">
              {tone === "destructive" ? "attention" : tone}
            </Badge>
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">{secondary}</p>
        </CardContent>
      </Card>
    </SuperLink>
  )
}
```

- [ ] **Step 7: Add summary data loading to overview page**

In customer overview `page.tsx`, replace the current `getSubscriptions` call with:

```tsx
const [{ customer }, walletResult, entitlementsResult, economicSummary] = await Promise.all([
  api.customers.getSubscriptions({ customerId }),
  api.customers.getWallet({ customerId }),
  api.customers.getEntitlements({ customerId }),
  api.customers.getEconomicSummary({ customerId }),
])
```

Keep the existing `notFound()` guard after this block.

- [ ] **Step 8: Render summary above usage evidence**

In the customer overview return body, before `HydrateClient`, add:

```tsx
<CustomerMoneyPathSummary
  baseUrl={baseUrl}
  customer={customer}
  wallet={walletResult.wallet}
  entitlements={entitlementsResult.entitlements}
  summary={economicSummary}
/>
```

Then keep the existing usage evidence panel below it and pass the explicit invoice count:

```tsx
<HydrateClient>
  <Suspense fallback={<CustomerMetricsPanelSkeleton />}>
    <CustomerMetricsPanel
      customerId={customerId}
      invoiceCount={economicSummary.invoiceCounts.total}
    />
  </Suspense>
</HydrateClient>
```

- [ ] **Step 9: Verify**

Run:

```bash
rtk pnpm --filter @unprice/services exec vitest run src/use-cases/customer/get-economic-summary.test.ts
rtk pnpm --filter @unprice/services typecheck
rtk pnpm --filter @unprice/trpc typecheck
rtk pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 10: Manual QA**

Open:

```text
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>
```

Check:

- Summary row appears above usage evidence.
- Each tile links to the matching tab.
- Wallet tile available amount matches wallet tab.
- Runs tile distinguishes running from budget exceeded.
- Invoice tile distinguishes total from paid.
- Entitlements tile shows a count but does not display money.

- [ ] **Step 11: Commit**

```bash
rtk git add internal/services/src/use-cases/customer/get-economic-summary.ts internal/services/src/use-cases/customer/get-economic-summary.test.ts internal/services/src/use-cases/index.ts internal/trpc/src/router/lambda/customers/getEconomicSummary.ts internal/trpc/src/router/lambda/customers/index.ts 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/(overview)/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/_components/customer-money-path-summary.tsx'
rtk git commit -m "feat: add customer economic overview summary"
```

## Task 7: Empty States, Loading States, And Copy Polish

**Files:**

- Modify: `apps/nextjs/src/components/analytics/usage-dashboard-view.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx`
- Modify: `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/page.tsx`

- [ ] **Step 1: Use MoneyPath only in empty usage evidence**

In `usage-dashboard-view.tsx`, import:

```tsx
import { MoneyPath } from "~/components/landing/money-path"
```

In `UsageDashboardEmptyState`, replace the icon-only empty body:

```tsx
<EmptyPlaceholder className="min-h-[520px] transition-opacity duration-300">
  ...
</EmptyPlaceholder>
```

with:

```tsx
<EmptyPlaceholder className="min-h-[520px] transition-opacity duration-300">
  <div className="w-full max-w-4xl">
    <MoneyPath />
  </div>
  <EmptyPlaceholder.Title>No usage data yet</EmptyPlaceholder.Title>
  <EmptyPlaceholder.Description>
    Record usage events with feature slugs. Rejected or failed events appear in Events.
  </EmptyPlaceholder.Description>
</EmptyPlaceholder>
```

This is allowed because brand docs recommend `MoneyPath` for empty states and explainers, not for populated dashboard state.

- [ ] **Step 2: Confirm loading states use `Skeleton`**

Search the dashboard and analytics files touched by this plan:

```bash
rtk rg -n "animate-pulse|bg-muted/10|bg-muted/20" apps/nextjs/src/components/analytics apps/nextjs/src/app/'(root)'/dashboard/'[workspaceSlug]'/'[projectSlug]'/events apps/nextjs/src/app/'(root)'/dashboard/'[workspaceSlug]'/'[projectSlug]'/dashboard
```

Expected: no new raw loading placeholder blocks. New loading placeholders should use:

```tsx
<Skeleton className="h-[250px] rounded-lg" />
```

- [ ] **Step 3: Verify reduced-motion and status labels**

Search:

```bash
rtk rg -n "animate-|transition-" apps/nextjs/src/components/analytics apps/nextjs/src/app/'(root)'/dashboard/'[workspaceSlug]'/'[projectSlug]'/events apps/nextjs/src/app/'(root)'/dashboard/'[workspaceSlug]'/'[projectSlug]'/dashboard
```

Expected: every new transition has `motion-reduce:transition-none` or is an existing project pattern; status color is paired with text labels.

- [ ] **Step 4: Verify**

Run:

```bash
rtk pnpm --filter nextjs typecheck
```

Expected: PASS.

- [ ] **Step 5: Manual QA**

Check mobile and desktop widths:

- Project dashboard health/usage/growth order.
- Events health/sparkline/rejections/table order.
- Customer overview summary row wraps without text clipping.
- Customer tabs remain horizontally usable on mobile.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/nextjs/src/components/analytics/usage-dashboard-view.tsx 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard/page.tsx' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/page.tsx'
rtk git commit -m "feat: polish dashboard empty and loading states"
```

## Task 8: Final Verification

**Files:** no planned edits

- [ ] **Step 1: Run focused typechecks**

```bash
rtk pnpm --filter @unprice/services exec vitest run src/use-cases/customer/get-economic-summary.test.ts
rtk pnpm --filter nextjs typecheck
rtk pnpm --filter @unprice/services typecheck
rtk pnpm --filter @unprice/trpc typecheck
```

Expected: PASS.

- [ ] **Step 2: Run full validation**

```bash
rtk pnpm validate
```

Expected: PASS. If `pnpm validate` rewrites formatting, inspect the diff and keep only formatting related to touched files.

- [ ] **Step 3: Review changed files**

```bash
rtk git diff --stat
rtk git diff -- apps/nextjs/src/components/analytics
rtk git diff -- 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard'
rtk git diff -- 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events'
rtk git diff -- 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]'
rtk git diff -- internal/services/src/analytics/service.ts
rtk git diff -- internal/services/src/use-cases/customer/get-economic-summary.ts internal/services/src/use-cases/customer/get-economic-summary.test.ts internal/services/src/use-cases/index.ts
rtk git diff -- internal/trpc/src/router/lambda/customers/getEconomicSummary.ts internal/trpc/src/router/lambda/customers/index.ts
```

Expected:

- No unrelated files.
- No new public API endpoint.
- `customers.getEconomicSummary` is count-only and does not refresh running runs.
- No card-inside-card composition.
- No decorative dashboard diagrams except `MoneyPath` inside empty state.
- No raw color-only status indication.

- [ ] **Step 4: Browser verification**

Start the app if it is not already running:

```bash
rtk pnpm --filter nextjs dev
```

Open these routes:

```text
http://app.localhost:3000/<workspace>/<project>/dashboard
http://app.localhost:3000/<workspace>/<project>/events
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/wallet
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/invoices
http://app.localhost:3000/<workspace>/<project>/customers/<customerId>/runs
```

Check:

- Project dashboard renders health -> usage/spend evidence -> growth evidence.
- Events dashboard renders success rate, freshness, live sparkline, top rejections, table, and replay actions.
- Customer overview renders economic header, summary row, then usage evidence.
- Wallet and invoice money still use existing formatters.
- No text overlaps at 375px, 768px, and desktop widths.

- [ ] **Step 5: Final commit**

If any final verification fixes were made:

```bash
rtk git add apps/nextjs/src/components/analytics 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/dashboard' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events' 'apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]' internal/services/src/analytics/service.ts internal/services/src/use-cases/customer/get-economic-summary.ts internal/services/src/use-cases/customer/get-economic-summary.test.ts internal/services/src/use-cases/index.ts internal/trpc/src/router/lambda/customers/getEconomicSummary.ts internal/trpc/src/router/lambda/customers/index.ts
rtk git commit -m "fix: polish brand-aligned dashboard rollout"
```

If no final verification fixes were made, do not create an empty commit.

## Self-Review Checklist

- Spec coverage:
  - Project dashboard renders prefetched ingestion status as visible operational health.
  - Events dashboard uses `successRate`, `live[]`, `rejections[]`, and `nextActions[]`.
  - Customer overview connects subscriptions, entitlements, wallet, runs, invoices, and usage evidence.
  - Vanity/growth KPIs are demoted and revenue is relabeled to recognized revenue.
  - No new public API endpoints are added.
  - The only new tRPC contract is `customers.getEconomicSummary` for customer overview counts.
  - Existing design-system primitives are reused.
- Type consistency:
  - New ingestion UI consumes `RouterOutputs["analytics"]["getIngestionStatus"]`.
  - Customer summary consumes existing `RouterOutputs["customers"]` shapes.
  - Runs and invoices summary counts come from `customers.getEconomicSummary`, not from table pagination metadata.
- Brand consistency:
  - Health and evidence lead the dashboard.
  - Status labels use semantic copy and badges.
  - Business denials are not called failures.
  - `MoneyPath` appears only in an empty state.
