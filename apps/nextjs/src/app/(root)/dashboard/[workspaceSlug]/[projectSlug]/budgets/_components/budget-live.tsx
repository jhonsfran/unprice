"use client"

import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Card } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { StationDot } from "@unprice/ui/station"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@unprice/ui/tabs"
import { cn } from "@unprice/ui/utils"
import { Loader2 } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { formatDate } from "~/lib/dates"
import { useTRPC, useTRPCClient } from "~/trpc/client"
import {
  formatBudgetAmount,
  formatCountdown,
  formatUnit,
  subtractAmount,
  sumAmounts,
  toBaseUnits,
} from "./budget-format"
import { BudgetNotFound } from "./budget-not-found"
import { type BudgetInspection, describeOperation } from "./budget-operations"
import { ReleaseHoldDialog } from "./release-hold-dialog"

type Limit = BudgetInspection["budget"]["balance"]["limits"][number]
type Reservation = BudgetInspection["expiringNext"]["rows"][number]
type Period = BudgetInspection["history"][number]
type Cursor = NonNullable<BudgetInspection["expiringNext"]["next"]>
type AuditRow = RouterOutputs["budgets"]["audit"][number]

const REFRESH_MS = 30_000

const WINDOW_LABEL: Record<Limit["window"], string> = {
  hour: "hourly",
  day: "daily",
  week: "weekly",
  month: "monthly",
  never: "lifetime",
}

export function BudgetLive({
  id,
  listHref,
  canRelease,
}: {
  id: string
  listHref: string
  /** OWNER and ADMIN may release a stuck hold; the server checks again. */
  canRelease: boolean
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const now = useNow(1000)
  const { data: audit } = useQuery(trpc.budgets.audit.queryOptions({ id }))
  // every page refreshes together, so "Scan further" rows never lag the first page's balance
  const { data, error, isRefetchError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useInfiniteQuery({
      queryKey: [trpc.budgets.inspect.pathKey()[0], { input: { id }, type: "infinite" }],
      queryFn: ({ pageParam }) =>
        client.budgets.inspect.query({ id, after: pageParam ?? undefined }),
      initialPageParam: null as Cursor | null,
      getNextPageParam: (page) => page.expiringNext.next,
      refetchInterval: REFRESH_MS,
    })

  if (error instanceof TRPCClientError && error.data?.code === "NOT_FOUND") {
    return <BudgetNotFound listHref={listHref} />
  }
  if (!data) {
    return error ? (
      <p className="text-danger-text text-sm">Could not read the budget: {error.message}</p>
    ) : (
      <BudgetLiveSkeleton />
    )
  }

  const pages = data.pages
  const { budget, history, closedRecently } = pages[0]!
  const lastPage = pages[pages.length - 1]!
  const { unit, balance } = budget
  const amount = (value: string) => formatBudgetAmount(value, unit)
  const reservations = pages.flatMap((page) => page.expiringNext.rows)

  return (
    <div className="flex flex-col gap-8">
      <Card className="flex flex-col gap-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div className="flex min-w-0 flex-wrap gap-x-10 gap-y-4">
            <Fact label="Remaining" emphasis>
              {balance.remaining === null ? "uncapped" : amount(balance.remaining)}
              <span className="ml-2 text-muted-foreground text-sm">{formatUnit(unit)}</span>
            </Fact>
            <Fact label="Held (locked)">
              <span
                className={toBaseUnits(balance.held) > BigInt(0) ? "" : "text-muted-foreground"}
              >
                {amount(balance.held)}
              </span>
            </Fact>
          </div>
          <LiveStamp asOf={balance.asOf} failed={isRefetchError} />
        </div>

        {balance.limits.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No limits. Every request passes and usage is only counted.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {balance.limits.map((limit) => (
              <LimitRow key={limit.id} limit={limit} unit={unit} />
            ))}
          </div>
        )}
      </Card>

      <Tabs defaultValue="open">
        <TabsList variant="line" className="hide-scrollbar overflow-x-auto">
          <TabsTrigger value="open">
            Open reservations
            <Count value={reservations.length} more={hasNextPage} />
          </TabsTrigger>
          <TabsTrigger value="closed">
            Closed in the last hour
            <Count value={closedRecently.length} />
          </TabsTrigger>
          <TabsTrigger value="usage">Usage by period</TabsTrigger>
          <TabsTrigger value="operator">
            Operator actions
            <Count value={audit?.length ?? 0} />
          </TabsTrigger>
        </TabsList>

        <Panel value="open">
          <Explainer>
            Holds and leases, soonest expiry first. At expiry an open hold is charged in full.{" "}
            {amount(sumAmounts(pages.map((page) => page.listed)))} of {amount(balance.held)} held
            listed.
          </Explainer>
          {reservations.length === 0 ? (
            <Muted>No open holds or leases in the rows scanned.</Muted>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Id</TableHead>
                  <TableHead>Idempotency key</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {reservations.map((row) => (
                  <ReservationRow
                    key={`${row.kind}:${row.id}`}
                    row={row}
                    unit={unit}
                    now={now}
                    release={
                      canRelease && row.kind === "hold" ? (
                        <ReleaseHoldDialog budgetId={id} hold={row} unit={unit} />
                      ) : null
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {(hasNextPage || pages.length > 1) && (
            <div className="flex flex-wrap items-center justify-end gap-3">
              {pages.length > 1 && lastPage.expiringNext.rows.length === 0 && (
                <span className="text-muted-foreground text-xs">
                  {hasNextPage
                    ? `No open reservations in the last ${lastPage.expiringNext.examined.toLocaleString()} rows scanned.`
                    : "No more open reservations."}
                </span>
              )}
              {hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  Scan further
                </Button>
              )}
            </div>
          )}
        </Panel>

        <Panel value="closed">
          <Explainer>Newest first. The list can miss rows when many closed.</Explainer>
          {closedRecently.length === 0 ? (
            <Muted>Nothing closed in the last hour.</Muted>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Id</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closedRecently.map((operation) => {
                  const line = describeOperation(operation, unit)
                  return (
                    <TableRow key={`${operation.kind}:${operation.id}`}>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                        {formatDate(line.at, undefined, "HH:mm:ss")}
                      </TableCell>
                      <TableCell className="text-xs">{line.kind}</TableCell>
                      <TableCell className="max-w-64 truncate font-mono text-xs" title={line.id}>
                        {line.id}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                        {line.detail}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Panel>

        <Panel value="usage">
          <Explainer>Consumption per ended period, oldest to newest.</Explainer>
          <UsageByPeriod history={history} unit={unit} />
        </Panel>

        <Panel value="operator">
          <Explainer>Holds released by a workspace owner or admin, newest first.</Explainer>
          <OperatorActions rows={audit} unit={unit} />
        </Panel>
      </Tabs>
    </div>
  )
}

function OperatorActions({ rows, unit }: { rows: AuditRow[] | undefined; unit: string }) {
  const trpc = useTRPC()
  const { data: members } = useQuery(trpc.workspaces.listMembersByActiveWorkspace.queryOptions())
  const actorOf = (userId: string) => {
    const user = members?.members.find((member) => member.userId === userId)?.user
    return user?.name ?? user?.email ?? userId
  }

  if (!rows) return <Skeleton className="h-12" />
  if (rows.length === 0) return <Muted>No operator actions.</Muted>

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Hold</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
              {formatDate(row.createdAt, undefined, "MMM d, HH:mm")}
            </TableCell>
            <TableCell className="max-w-40 truncate text-xs">{actorOf(row.actorUserId)}</TableCell>
            <TableCell className="whitespace-nowrap text-xs">release hold</TableCell>
            <TableCell className="font-mono text-xs">{row.subject}</TableCell>
            <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
              {row.status === "applied" ? formatBudgetAmount(row.released, unit) : "-"}
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
              {auditStatus(row)}
            </TableCell>
            <TableCell className="max-w-72 truncate text-xs" title={row.reason}>
              {row.reason}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function auditStatus(row: AuditRow): string {
  switch (row.status) {
    case "applied":
      return "applied"
    case "requested":
      return "requested, no answer yet"
    case "rejected":
      return `rejected (${row.rejectionCode})`
  }
}

function ReservationRow({
  row,
  unit,
  now,
  release,
}: {
  row: Reservation
  unit: string
  now: number
  release: ReactNode
}) {
  const amount = (value: string) => formatBudgetAmount(value, unit)
  const isHold = row.kind === "hold"

  return (
    <TableRow>
      <TableCell className="text-xs">{row.kind}</TableCell>
      <TableCell
        className="max-w-48 truncate font-mono text-xs"
        title={isHold ? row.id : row.leaseKey}
      >
        {isHold ? row.id : row.leaseKey}
      </TableCell>
      <TableCell
        className="max-w-48 truncate font-mono text-xs"
        title={isHold ? row.idempotencyKey : undefined}
      >
        {isHold ? row.idempotencyKey : "-"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
        {isHold
          ? amount(row.amount)
          : `${amount(subtractAmount(row.granted, row.captured))} left of ${amount(row.granted)}`}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
        {formatDate(row.createdAt, undefined, "HH:mm:ss")}
      </TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
        {formatDate(row.expiresAt, undefined, "HH:mm:ss")}
        <span className="ml-2 text-muted-foreground">
          {row.expiresAt > now ? `in ${formatCountdown(row.expiresAt - now)}` : "expiring"}
        </span>
      </TableCell>
      <TableCell className="text-right text-muted-foreground text-xs">
        {isHold ? release : "only its holder can return it"}
      </TableCell>
    </TableRow>
  )
}

function LimitRow({ limit, unit }: { limit: Limit; unit: string }) {
  const amount = (value: string) => formatBudgetAmount(value, unit)
  const base = Number(toBaseUnits(limit.amount))
  const share = (value: string) =>
    base > 0 ? Math.min(100, (Number(toBaseUnits(value)) / base) * 100) : 0
  const consumed = share(limit.consumed)
  const held = Math.min(100 - consumed, share(limit.held))
  const remaining = toBaseUnits(limit.remaining)
  const left =
    remaining < BigInt(0)
      ? `over by ${amount(limit.remaining.slice(1))}`
      : `${amount(limit.remaining)} left`
  // the meter escalates on what is committed: consumed plus held
  const committed = consumed + held
  const fill =
    committed >= 100 ? "bg-danger-solid" : committed >= 80 ? "bg-warning-solid" : "bg-primary-solid"
  const window = WINDOW_LABEL[limit.window]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium font-mono text-sm">{limit.id}</span>
          <span className="whitespace-nowrap font-mono text-muted-foreground text-xs">
            {limit.enforce}
            {window === limit.id ? "" : ` · ${window}`}
          </span>
        </span>
        <span className="whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums">
          {limit.resetsAt === null
            ? "never resets"
            : `resets ${formatDate(limit.resetsAt, undefined, "MMM d, HH:mm")}`}
        </span>
      </div>
      {/* decorative: the figures under the bar carry the same numbers */}
      <div
        aria-hidden
        className="flex h-2 w-full overflow-hidden rounded-full bg-background-bgHover"
      >
        <div className={`h-full ${fill}`} style={{ width: `${consumed}%` }} />
        <div className="h-full bg-info-solid" style={{ width: `${held}%` }} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-full ${fill}`} />
            {amount(limit.consumed)} used
          </span>
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-full bg-info-solid" />
            {amount(limit.held)} held
          </span>
        </span>
        <span>
          {left} <span className="text-muted-foreground">of {amount(limit.amount)}</span>
        </span>
      </div>
    </div>
  )
}

function UsageByPeriod({ history, unit }: { history: Period[]; unit: string }) {
  if (history.length === 0) {
    return <Muted>No ended period has usage yet.</Muted>
  }

  // history is newest first per window; the bars read oldest to newest
  const windows = new Map<string, Period[]>()
  for (const period of history) {
    windows.set(period.windowId, [period, ...(windows.get(period.windowId) ?? [])])
  }

  return (
    <div className="flex flex-col gap-6">
      {[...windows].map(([windowId, periods]) => {
        const shown = periods.slice(-12)
        const max = shown.reduce((top, p) => Math.max(top, Number(toBaseUnits(p.consumed))), 0)
        return (
          <div key={windowId} className="flex flex-col gap-2">
            <span className="font-mono text-muted-foreground text-xs">
              {windowId.split("@")[0]} · last {shown.length}
            </span>
            <div className="flex h-16 items-end gap-1">
              {shown.map((period) => (
                <div
                  key={period.start}
                  className="w-4 rounded-sm bg-primary-solid"
                  style={{
                    height: `${max > 0 ? Math.max(4, (Number(toBaseUnits(period.consumed)) / max) * 100) : 4}%`,
                  }}
                  title={`${formatDate(period.start, undefined, "MMM d, HH:mm")}: ${formatBudgetAmount(period.consumed, unit)}`}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function Fact({
  label,
  emphasis,
  children,
}: {
  label: string
  emphasis?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={cn(
          "font-mono tabular-nums [overflow-wrap:anywhere]",
          emphasis ? "font-medium text-2xl text-background-textContrast" : "pt-1.5 text-lg"
        )}
      >
        {children}
      </span>
    </div>
  )
}

function LiveStamp({ asOf, failed }: { asOf: number; failed: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 whitespace-nowrap font-mono text-xs",
        failed ? "text-danger-text" : "text-muted-foreground"
      )}
      title={`Read live from the budget. Refreshes every ${REFRESH_MS / 1000} s.`}
    >
      <StationDot variant={failed ? "danger" : "live"} />
      {failed ? "refresh failed" : "live"} · {formatDate(asOf, undefined, "HH:mm:ss")}
    </span>
  )
}

function Count({ value, more }: { value: number; more?: boolean }) {
  if (value === 0 && !more) return null
  return (
    <span className="ml-2 rounded bg-background-bgHover px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums">
      {value}
      {more ? "+" : ""}
    </span>
  )
}

function Panel({ value, children }: { value: string; children: ReactNode }) {
  // mounted while hidden so each tab's count and rows stay current under the poll
  return (
    <TabsContent
      value={value}
      forceMount
      className="flex flex-col gap-3 pt-4 data-[state=inactive]:hidden"
    >
      {children}
    </TabsContent>
  )
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border border-dashed px-4 py-3 text-muted-foreground text-xs">
      {children}
    </div>
  )
}

export function BudgetLiveSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-48" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-24" />
      </div>
    </div>
  )
}
