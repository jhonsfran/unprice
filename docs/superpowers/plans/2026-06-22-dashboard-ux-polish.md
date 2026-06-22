# Dashboard UX Polish Implementation Plan

> **For Jhon:** REQUIRED SUBAGENT WORKFLOW - Use this plan with subagents executing each task and stopping after each one for review.

**Goal:** Apply the design-review suggestions that improve trust, clarity, accessibility, mobile usability, and empty states across the dashboard.

**Out of scope:** Breadcrumbs are fully excluded. Do not change the breadcrumb route, breadcrumb component, or breadcrumb copy in this pass.

**Why this is worth doing:** Most fixes are small and shared. The highest-return work is the onboarding trust fix, shared table empty states, API-key success state, route-aware settings header, and copy/accessibility cleanup. The mobile overlay and event-search URL work are useful but slightly more exploratory.

**Architecture:** Keep UI changes in the Next.js app layer and shared UI/table components. Keep analytics label copy at the analytics/service owner because the duplicated "last last" copy is produced before it reaches the UI. Add no new dependencies.

**Tech Stack:** Next.js App Router, React, TypeScript, shadcn/ui primitives, Tailwind, TanStack Table, nuqs URL state, tRPC, pnpm.

## Current Findings

- Onboarding can show seed failure and then the final step still claims the dashboard was seeded.
- Several empty table states use generic "No Results" copy and pagination can show "Page 1 of 0".
- Project settings subpages keep the header "General Settings" on Danger and Infrastructure/Payment routes.
- API-key creation lacks a one-time-secret warning and still reads like the create form after success.
- Several labels and strings are rough: "last last", "All the apis", "Exiration", "Quick access to", "can not", "plan Type", "Search events...".
- Some icon-only or nested controls are hard to interpret, especially plan-card actions and row/action buttons.
- Event date filters use URL state, but event search is local table state and does not survive refresh/share.
- Mobile fixed widgets can collide with drawer/table content in the local dashboard.
- Plan version configuration reads dense and low-contrast in empty/disabled/sidebar states.

## Task 1: Baseline And Safety

**Files:** none

- [ ] Run:
  ```bash
  rtk git status --short
  ```
- [ ] Keep any unrelated existing work untouched.
- [ ] Open `http://app.localhost:3000/jolly-secretary/acme-project/dashboard` and confirm the dummy session still works. If login is required, use `asdasdas@hotmail.com` / `1234567890`.
- [ ] Capture desktop and mobile reference screenshots for:
  - `/jolly-secretary/acme-project/dashboard`
  - `/jolly-secretary/acme-project/apikeys`
  - `/jolly-secretary/acme-project/events`
  - `/jolly-secretary/acme-project/settings/danger`
  - one customer wallet/invoices/runs page with empty data

**Review checkpoint:** Confirm baseline screenshots exist before editing.

## Task 2: Copy And Label Cleanup

**Files:**

- `internal/analytics/src/utils.ts`
- `internal/services/src/analytics/service.ts`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/loading.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/_components/create-api-key-form.tsx`
- `apps/nextjs/src/components/navigation/mobile-sidebar.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-panel.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/meter-config-form-field.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/table-versions/columns.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/danger/_components/delete-project.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/danger/_components/transfer-to-personal.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/danger/_components/transfer-to-team.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/settings/(overview)/_components/delete-workspace.tsx`

**Implementation:**

- [ ] In `internal/analytics/src/utils.ts`, add `durationLabel` to each `prepareInterval` return:
  ```ts
  // 24h
  label: "last 24 hours",
  durationLabel: "24 hours",

  // 7d
  label: "last 7 days",
  durationLabel: "7 days",

  // 30d
  label: "last 30 days",
  durationLabel: "30 days",

  // 90d
  label: "last 90 days",
  durationLabel: "90 days",
  ```
- [ ] In `internal/services/src/analytics/service.ts`, replace:
  ```ts
  description: `created in the last ${preparedInterval.label}`,
  ```
  with:
  ```ts
  description: `created in the last ${preparedInterval.durationLabel}`,
  ```
- [ ] In the same service file, replace:
  ```ts
  description: `in the last ${preparedInterval.label}`,
  ```
  with:
  ```ts
  description: `in the last ${preparedInterval.durationLabel}`,
  ```
- [ ] In the API-key page and loading page, replace:
  ```tsx
  description="All the apis of the system"
  ```
  with:
  ```tsx
  description="Manage project API keys and default customer access."
  ```
- [ ] In `create-api-key-form.tsx`, replace `Exiration date` with `Expiration date`.
- [ ] In `create-api-key-form.tsx`, replace:
  ```tsx
  We strongly recommend you setting an expiration date for your API key.
  ```
  with:
  ```tsx
  We strongly recommend setting an expiration date for your API key.
  ```
- [ ] In `mobile-sidebar.tsx`, replace the muted sentence:
  ```tsx
  <span className="text-muted-foreground">Quick access to</span>
  ```
  with:
  ```tsx
  <span className="text-muted-foreground">Quick access to project navigation</span>
  ```
- [ ] In `ingestion-events-panel.tsx`, replace:
  ```tsx
  searchPlaceholder="Search events..."
  ```
  with:
  ```tsx
  searchPlaceholder="Search events"
  ```
- [ ] In `meter-config-form-field.tsx`, replace:
  ```tsx
  placeholder="Search events..."
  ```
  with:
  ```tsx
  placeholder="Search events"
  ```
- [ ] In `table-versions/columns.tsx`, replace the headers:
  ```tsx
  title="subs"
  title="interval"
  title="plan Type"
  ```
  with:
  ```tsx
  title="Subscribers"
  title="Billing interval"
  title="Plan type"
  ```
- [ ] In project and workspace danger components, replace user-facing `can not` with `cannot`.
- [ ] In project and workspace delete components, replace:
  ```tsx
  <p>This action can not be reverted</p>
  ```
  with:
  ```tsx
  <p>This action cannot be undone.</p>
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  rtk pnpm --filter @unprice/services typecheck
  ```
- [ ] Search for the cleaned copy:
  ```bash
  rtk rg -n "last last|All the apis|Exiration|can not|plan Type|Search events\\.\\.\\.|Quick access to$" apps/nextjs/src internal/services/src internal/analytics/src
  ```
  Expected result: no user-facing hits for those exact strings.

**Review checkpoint:** Show the diff for copy-only changes.

## Task 3: Route-Aware Settings Header

**Files:**

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/layout.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/settings/_components/project-settings-header.tsx`

**Implementation:**

- [ ] Create `settings/_components/project-settings-header.tsx`:
  ```tsx
  "use client"

  import type { RouterOutputs } from "@unprice/trpc/routes"
  import { Button } from "@unprice/ui/button"
  import { Pencil } from "lucide-react"
  import { useSelectedLayoutSegment } from "next/navigation"
  import HeaderTab from "~/components/layout/header-tab"
  import { ProjectDialog } from "../../../_components/project-dialog"

  type Project = RouterOutputs["projects"]["getBySlug"]["project"]

  function getSettingsHeaderCopy(segment: string | null) {
    switch (segment) {
      case "danger":
        return {
          title: "Danger Zone",
          description: "Transfer ownership or delete this project.",
        }
      case "payment":
        return {
          title: "Infrastructure",
          description: "Configure payment provider infrastructure for this project.",
        }
      default:
        return {
          title: "General Settings",
          description: "Manage your project settings.",
        }
    }
  }

  export function ProjectSettingsHeader({ project }: { project: Project }) {
    const segment = useSelectedLayoutSegment()
    const copy = getSettingsHeaderCopy(segment)

    return (
      <HeaderTab
        title={copy.title}
        description={copy.description}
        action={
          <ProjectDialog defaultValues={project}>
            <Button variant="outline">
              <Pencil className="mr-2 size-4" aria-hidden="true" />
              Edit Project
            </Button>
          </ProjectDialog>
        }
      />
    )
  }
  ```
- [ ] Update `settings/layout.tsx` imports to remove `Button`, `Pencil`, `HeaderTab`, and `ProjectDialog`.
- [ ] Add:
  ```ts
  import { ProjectSettingsHeader } from "./_components/project-settings-header"
  ```
- [ ] Replace the `DashboardShell` header with:
  ```tsx
  header={<ProjectSettingsHeader project={project} />}
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] Manually check:
  - `/jolly-secretary/acme-project/settings`
  - `/jolly-secretary/acme-project/settings/payment`
  - `/jolly-secretary/acme-project/settings/danger`

**Review checkpoint:** Confirm copy changes route-to-route without a full page layout regression.

## Task 4: API-Key Creation Success State

**Files:**

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/_components/new-api-key-dialog.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/_components/create-api-key-form.tsx`

**Implementation:**

- [ ] In `new-api-key-dialog.tsx`, add dialog-local success state:
  ```tsx
  const [dialogOpen, setDialogOpen] = useState(false)
  const [createdKey, setCreatedKey] = useState(false)
  ```
- [ ] Reset success state when the dialog closes:
  ```tsx
  <Dialog
    open={dialogOpen}
    onOpenChange={(open) => {
      setDialogOpen(open)
      if (!open) {
        setCreatedKey(false)
      }
    }}
  >
  ```
- [ ] Change the trigger label to a clearer command:
  ```tsx
  <Add className="mr-2 size-4" aria-hidden="true" />
  Create API key
  ```
- [ ] Change the dialog title and description:
  ```tsx
  <DialogTitle>{createdKey ? "API key created" : "Create API key"}</DialogTitle>
  <DialogDescription>
    {createdKey
      ? "Copy the secret now. You will not be able to view it again after closing this dialog."
      : "Create a key for project API access."}
  </DialogDescription>
  ```
- [ ] Pass a success callback to the form:
  ```tsx
  <CreateApiKeyForm
    setDialogOpen={setDialogOpen}
    onSuccess={(value) => setCreatedKey(Boolean(value))}
    defaultValues={{
      name: "",
      expiresAt: null,
      defaultCustomerId: null,
    }}
  />
  ```
- [ ] In `create-api-key-form.tsx`, keep the created key visible after copy. Remove the `onClick={resetForm}` behavior from the copy button next to the key.
- [ ] In `create-api-key-form.tsx`, when `key` exists, render a warning above the masked key:
  ```tsx
  {key && (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
      Copy this secret now. For security, it will only be shown once.
    </div>
  )}
  ```
- [ ] In `create-api-key-form.tsx`, replace the submit button block with a success branch:
  ```tsx
  {key ? (
    <Button type="button" onClick={resetForm}>
      Done
    </Button>
  ) : (
    <SubmitButton isSubmitting={createApiKey.isPending} disabled={createApiKey.isPending}>
      Create
    </SubmitButton>
  )}
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] In the browser, create a dummy key and confirm:
  - Modal title changes to "API key created".
  - One-time warning is visible.
  - Copying the key does not close the modal.
  - "Done" closes and resets the next open.

**Review checkpoint:** Confirm the flow communicates "secret shown once" clearly.

## Task 5: Shared DataTable Empty State And Pagination

**Files:**

- `apps/nextjs/src/components/data-table/data-table.tsx`
- `apps/nextjs/src/components/data-table/data-table-pagination.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/(overview)/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/wallet/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/invoices/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/runs/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/[customerId]/subscriptions/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/subscriptions/(overview)/page.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/(overview)/page.tsx`

**Implementation:**

- [ ] In `data-table.tsx`, add a typed empty-state prop:
  ```ts
  interface DataTableEmptyState {
    title: string
    description: string
    icon?: React.ComponentType<{ className?: string }>
  }
  ```
- [ ] Add it to `DataTableProps`:
  ```ts
  emptyState?: DataTableEmptyState
  hidePaginationWhenEmpty?: boolean
  ```
- [ ] Use a stable server page count:
  ```ts
  const safePageCount =
    typeof pageCount === "number" && Number.isFinite(pageCount) ? Math.max(pageCount, 1) : undefined
  const isServerSidePagination = typeof safePageCount === "number"
  const hasRows = table.getRowModel().rows.length > 0
  const EmptyIcon = emptyState?.icon ?? AlertTriangle
  ```
- [ ] Pass `safePageCount` to TanStack Table:
  ```ts
  ...(isServerSidePagination && { pageCount: safePageCount }),
  ```
- [ ] Replace the hardcoded empty title/description with:
  ```tsx
  <EmptyPlaceholder.Icon>
    <EmptyIcon className="size-8" />
  </EmptyPlaceholder.Icon>
  <EmptyPlaceholder.Title>
    {error ? "Something went wrong" : (emptyState?.title ?? "No results")}
  </EmptyPlaceholder.Title>
  <EmptyPlaceholder.Description>
    {error ? error : (emptyState?.description ?? "No rows match the current filters.")}
  </EmptyPlaceholder.Description>
  ```
- [ ] Render pagination only when useful:
  ```tsx
  {(!hidePaginationWhenEmpty || hasRows) && <DataTablePagination table={table} />}
  ```
- [ ] In `data-table-pagination.tsx`, replace the page count read with:
  ```ts
  const pageCount = Math.max(table.getPageCount(), 1)
  ```
  and render:
  ```tsx
  Page {Math.min(table.getState().pagination.pageIndex + 1, pageCount)} of {pageCount}
  ```
- [ ] Remove the local `tablePageCount = Math.max(pageCount, 1)` workaround from the customer runs page and pass `pageCount={pageCount}`.
- [ ] Add contextual empty states to the table callers:
  ```tsx
  // API keys
  emptyState={{
    title: "No API keys",
    description: "Create an API key when you are ready to call this project from an application.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Customers overview
  emptyState={{
    title: "No customers",
    description: "Create a customer or send one through the API to start tracking usage.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Wallet credits
  emptyState={{
    title: "No wallet credits",
    description: "This customer has no issued, active, or expired wallet credits yet.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Invoices
  emptyState={{
    title: "No invoices",
    description: "Invoices will appear here after this customer has billable subscriptions.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Runs
  emptyState={{
    title: "No runs",
    description: "Budgeted runs will appear after usage is evaluated for this customer.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Customer subscriptions
  emptyState={{
    title: "No subscriptions",
    description: "This customer does not have an active or historical subscription yet.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Project subscriptions
  emptyState={{
    title: "No subscriptions",
    description: "Subscriptions will appear here after customers are assigned to plans.",
  }}
  hidePaginationWhenEmpty
  ```
  ```tsx
  // Plan versions
  emptyState={{
    title: "No versions",
    description: "Create a draft version to configure pricing and features for this plan.",
  }}
  hidePaginationWhenEmpty
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] Manually visit the affected pages and confirm no page shows `Page 1 of 0`.
- [ ] Confirm filtered empty states still show the contextual copy.

**Review checkpoint:** Check the shared table diff carefully because it affects many screens.

## Task 6: Onboarding Seed Failure Truthfulness

**Files:**

- `apps/nextjs/src/components/onboarding/steps/seed-metrics-step.tsx`
- `apps/nextjs/src/components/onboarding/steps/final-step.tsx`

**Implementation:**

- [ ] In `seed-metrics-step.tsx`, add a helper inside the component:
  ```ts
  const markSeedFailed = (message: string) => {
    setErrorMessage(message)
    updateContext({
      flowData: {
        seededMetrics: false,
        seedMetricsError: message,
      },
    })
  }
  ```
- [ ] Replace direct seed-failure `setErrorMessage(...)` calls inside `runSeed` with `markSeedFailed(...)` for:
  - missing project or plan data
  - plan version not found
  - no plan features
  - API key creation failure
  - customer creation failure
  - usage ingestion failure
  - verification failure
  - catch block failure
- [ ] Track failure within `runSeed` so usage or verification failures do not mark success:
  ```ts
  let seedFailed = false
  ```
  When usage fails:
  ```ts
  seedFailed = true
  markSeedFailed(
    `Ingestion events failed to seed for ${target.featureSlug}. ${message ? `Response: ${message}` : ""}`.trim()
  )
  ```
  When verification fails:
  ```ts
  seedFailed = true
  markSeedFailed(
    `Verification events failed to seed. ${message ? `Response: ${message}` : ""}`.trim()
  )
  ```
- [ ] Before writing `seededMetrics: true`, guard against partial failures:
  ```ts
  if (seedFailed) {
    setIsComplete(false)
    return
  }
  ```
- [ ] Only write success when all required seed work succeeded or was intentionally skipped:
  ```ts
  updateContext({
    flowData: {
      seededMetrics: true,
      seedMetricsError: undefined,
    },
  })
  setIsComplete(true)
  ```
- [ ] In `final-step.tsx`, derive final copy from onboarding context:
  ```ts
  const flowData = state?.context?.flowData as
    | {
        seededMetrics?: boolean
        seedMetricsError?: string
        project?: { slug: string }
      }
    | undefined
  const seededMetrics = flowData?.seededMetrics === true
  ```
- [ ] Replace the static paragraph with:
  ```tsx
  <Typography variant="p" className="mb-8 w-[640px] max-w-[90vw] animate-title delay-300!">
    {seededMetrics
      ? "Your dashboard is now seeded with usage and verification metrics from a test customer. Connect a payment provider when you are ready to charge real customers."
      : "Your project is ready. Sample metrics were not fully seeded, so the dashboard may stay empty until real usage is reported."}
  </Typography>
  ```
- [ ] When clearing flow data in `final-step.tsx`, also clear:
  ```ts
  seedMetricsError: undefined,
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] Manually exercise one failed seed path by making the ingest endpoint unavailable or using an invalid key in local dummy data, then confirm the final step no longer claims seed success.
- [ ] Manually exercise a successful seed path and confirm the existing success copy still appears.

**Review checkpoint:** This is the trust fix. Do not proceed if failure and success copy cannot be visually distinguished.

## Task 7: Event Search URL State

**Files:**

- `internal/ui/src/filter-data-table.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/events/_components/ingestion-events-panel.tsx`

**Implementation:**

- [ ] Extend `FilterDataTableProps`:
  ```ts
  searchValue?: string
  onSearchValueChange?: (value: string) => void
  ```
- [ ] In `FilterDataTable`, compute search input value from the controlled prop when provided:
  ```ts
  const localSearchValue =
    searchColumn && table.getColumn(searchColumn)
      ? String(table.getColumn(searchColumn)?.getFilterValue() ?? "")
      : ""
  const searchValue = controlledSearchValue ?? localSearchValue
  ```
  Use a destructured prop name to avoid shadowing:
  ```ts
  searchValue: controlledSearchValue,
  onSearchValueChange,
  ```
- [ ] Replace the input change handler:
  ```tsx
  onChange={(event) => {
    const nextValue = event.target.value
    table.getColumn(searchColumn)?.setFilterValue(nextValue)
    onSearchValueChange?.(nextValue)
  }}
  ```
- [ ] In `ingestion-events-panel.tsx`, pass URL-backed search:
  ```tsx
  searchValue={filters.search ?? ""}
  onSearchValueChange={(value) => {
    void setFilters({ search: value || null })
  }}
  ```
- [ ] Initialize the table filter from URL state so refresh/share keeps the visible filter:
  ```tsx
  initialColumnFilters={
    filters.search
      ? [
          {
            id: "eventSlug",
            value: filters.search,
          },
        ]
      : []
  }
  ```
- [ ] Add `initialColumnFilters?: ColumnFiltersState` to `FilterDataTableProps` and use it as the initial `columnFilters` state:
  ```ts
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    initialColumnFilters ?? []
  )
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] In `/events`, type a search term and confirm the URL gains `search=<term>`.
- [ ] Refresh the page and confirm the search field and filtered table keep the term.
- [ ] Clear the field and confirm `search` is removed from the URL.

**Review checkpoint:** Confirm this controlled search behavior does not affect other `FilterDataTable` consumers.

## Task 8: Mobile Widget And Drawer Collision

**Files:**

- `apps/nextjs/src/env.ts`
- `apps/nextjs/src/trpc/client.tsx`
- `apps/nextjs/src/components/navigation/mobile-sidebar.tsx`
- `apps/nextjs/src/components/userjot.tsx`
- `apps/nextjs/src/hooks/use-userjot.ts`

**Implementation:**

- [ ] In `env.ts`, add a client env var:
  ```ts
  client: {
    NEXT_PUBLIC_ENABLE_QUERY_DEVTOOLS: z.enum(["true", "false"]).default("false"),
  },
  ```
- [ ] In `trpc/client.tsx`, import `env`:
  ```ts
  import { env } from "~/env"
  ```
- [ ] Gate React Query Devtools:
  ```tsx
  {env.NEXT_PUBLIC_ENABLE_QUERY_DEVTOOLS === "true" && (
    <ReactQueryDevtools initialIsOpen={false} />
  )}
  ```
- [ ] In `mobile-sidebar.tsx`, increase bottom breathing room inside the drawer:
  ```tsx
  <div className="flex flex-col gap-2 px-4 pb-24 pt-4">
  ```
  Keep the existing navigation content unchanged.
- [ ] In `use-userjot.ts`, add `hide` to the returned API is already present. Keep it.
- [ ] In `userjot.tsx`, hide the floating UserJot widget on small screens after the widget is ready:
  ```tsx
  const { setTheme, identify, isReady, hide } = useUserJot()

  useEffect(() => {
    if (!isReady) return

    const media = window.matchMedia("(max-width: 767px)")
    const syncMobileWidget = () => {
      if (media.matches) {
        hide()
      }
    }

    syncMobileWidget()
    media.addEventListener("change", syncMobileWidget)
    return () => media.removeEventListener("change", syncMobileWidget)
  }, [hide, isReady])
  ```

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] Check a 390px-wide viewport:
  - drawer content can scroll to the last item
  - feedback widget does not cover table actions
  - React Query Devtools is hidden unless `NEXT_PUBLIC_ENABLE_QUERY_DEVTOOLS=true`

**Review checkpoint:** Confirm local debugging remains available through the env flag.

## Task 9: Accessibility And Nested Interaction Cleanup

**Files:**

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/(overview)/_components/plan-card.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/apikeys/_components/table/data-table-row-actions.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/customers/table/data-table-row-actions.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/invoices/table-invoices/data-table-row-actions.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/customers/_components/subscriptions/table-subscriptions/data-table-row-actions.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/table-versions/data-table-row-actions.tsx`

**Implementation:**

- [ ] In `plan-card.tsx`, remove the outer `SuperLink` around the whole card.
- [ ] Keep the card as the outer element:
  ```tsx
  <Card className="overflow-hidden hover:border-background-borderHover">
  ```
- [ ] Wrap only the readable card content in a link:
  ```tsx
  <SuperLink
    href={`/${props.workspaceSlug}/${props.projectSlug}/plans/${plan.slug}`}
    className="min-w-0 flex-1"
  >
    <CardTitle className="line-clamp-1">
      ...
    </CardTitle>
    <CardDescription className="line-clamp-2 h-10">{plan.description}</CardDescription>
  </SuperLink>
  ```
- [ ] Keep the dropdown as a sibling of the link and give the trigger an accessible label:
  ```tsx
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="icon" className="size-8">
      <MoreVertical className="size-4" aria-hidden="true" />
      <span className="sr-only">Open plan actions</span>
    </Button>
  </DropdownMenuTrigger>
  ```
- [ ] In each `data-table-row-actions.tsx` file, find icon-only dropdown triggers and ensure this pattern:
  ```tsx
  <Button variant="ghost" size="icon" className="size-8">
    <MoreHorizontal className="size-4" aria-hidden="true" />
    <span className="sr-only">Open row actions</span>
  </Button>
  ```
  Use the local icon name when the file already uses a different action icon.
- [ ] Mark decorative icons inside text buttons with `aria-hidden="true"`.

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] In the browser, tab through:
  - plan card
  - plan action menu
  - API-key table row action menu
  - customer/invoice/subscription/version row action menus
- [ ] Confirm the plan card no longer nests a button inside a link.

**Review checkpoint:** Confirm keyboard order still matches the visual order.

## Task 10: Plan Version Density And Contrast

**Files:**

- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/feature-list.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/plan-feature-list.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/table-versions/columns.tsx`
- `apps/nextjs/src/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/[planVersionId]/_components/plan-workspace-rail.tsx`

**Implementation:**

- [ ] In `feature-list.tsx`, change the search placeholder:
  ```tsx
  placeholder="Search features"
  ```
- [ ] In `plan-feature-list.tsx`, change the search placeholder:
  ```tsx
  placeholder="Search attached features"
  ```
- [ ] In `feature-list.tsx`, replace the empty-state description:
  ```tsx
  <EmptyPlaceholder.Description>
    No library features match your search.
  </EmptyPlaceholder.Description>
  ```
- [ ] In `table-versions/columns.tsx`, replace description truncation:
  ```tsx
  {description.slice(0, 40)}...
  ```
  with:
  ```tsx
  {description.length > 40 ? `${description.slice(0, 40)}…` : description}
  ```
- [ ] In `plan-workspace-rail.tsx`, increase right rail resilience on narrow desktop by using a fixed width only at large breakpoints:
  ```tsx
  className="w-full border-t bg-background lg:w-[320px] lg:border-l lg:border-t-0"
  ```
  Keep the rail content order unchanged.
- [ ] Review disabled published-version states and replace low-contrast `text-muted-foreground` on critical labels with `text-foreground/70`. Do not change decorative helper text.

**Verification:**

- [ ] Run:
  ```bash
  rtk pnpm --filter nextjs typecheck
  ```
- [ ] Check a published plan version and a draft plan version at desktop and 768px widths.
- [ ] Confirm search inputs, empty states, and right rail do not collide with feature rows.

**Review checkpoint:** This is a visual pass; compare screenshots before and after.

## Task 11: Final Validation

**Files:** all touched files

- [ ] Run the focused checks:
  ```bash
  rtk pnpm --filter nextjs typecheck
  rtk pnpm --filter @unprice/services typecheck
  ```
- [ ] Run the repo validation command required by the project guide:
  ```bash
  rtk pnpm validate
  ```
- [ ] Manual browser QA on desktop and mobile:
  - onboarding success and failure copy
  - API-key create flow
  - empty wallet/invoice/run tables
  - project settings overview/payment/danger headers
  - events search URL persistence
  - plan card keyboard navigation
  - plan version feature configuration
- [ ] Run a final copy scan:
  ```bash
  rtk rg -n "last last|All the apis|Exiration|can not|plan Type|Search events\\.\\.\\.|Page 1 of 0" apps/nextjs/src internal/services/src internal/analytics/src
  ```
  Expected result: no user-facing hits.
- [ ] Run:
  ```bash
  rtk git diff --stat
  ```
  Confirm the diff is scoped to the planned UX polish.

## Suggested Execution Order

1. Task 2: Copy cleanup. Small, low risk, immediate polish.
2. Task 3: Settings header. Small and visible.
3. Task 4: API-key success state. Medium risk, high trust value.
4. Task 5: Shared table empty states. Medium risk because shared component.
5. Task 6: Onboarding seed truthfulness. Highest trust value.
6. Task 9: Accessibility and nested interactions. Medium risk, important for keyboard users.
7. Task 8: Mobile widget collision. Medium risk because env behavior changes.
8. Task 7: Event search URL state. Medium risk because shared UI component becomes optionally controlled.
9. Task 10: Plan version density and contrast. Visual polish after structural fixes.
10. Task 11: Full validation.

