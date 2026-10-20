"use client"

import { useInfiniteQuery } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import { Skeleton } from "@unprice/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { formatDistanceStrict } from "date-fns"
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

type Limit = BudgetInspection["budget"]["balance"]["limits"][number]
type Reservation = BudgetInspection["expiringNext"]["rows"][number]
type Period = BudgetInspection["history"][number]
type Cursor = NonNullable<BudgetInspection["expiringNext"]["next"]>

const REFRESH_MS = 30_000

const CURRENT_PERIOD: Record<Limit["window"], string> = {
  hour: "this hour",
  day: "today",
  week: "this week",
  month: "this month",
  never: "in total",
}

export function BudgetLive({ id, listHref }: { id: string; listHref: string }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const now = useNow(1000)
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
  const tightest = tightestLimit(balance.limits)
  const nextReset = nextResettingLimit(balance.limits)

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-xs">
        Live from the budget · as of {formatDate(balance.asOf, undefined, "HH:mm:ss")} · refreshes
        every 30 s{isRefetchError ? " · the last refresh failed" : ""}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Remaining"
          value={
            balance.remaining === null
              ? "uncapped"
              : `${amount(balance.remaining)} ${formatUnit(unit)}`
          }
        />
        <Stat label="Held (locked)" value={`${amount(balance.held)} ${formatUnit(unit)}`} />
        <Stat
          label={tightest ? `Consumed ${CURRENT_PERIOD[tightest.window]}` : "Consumed"}
          value={tightest ? `${amount(tightest.consumed)} of ${amount(tightest.amount)}` : "-"}
          hint={tightest ? tightest.id : "No limits"}
        />
        <Stat
          label="Resets"
          value={
            nextReset?.resetsAt ? `in ${formatDistanceStrict(nextReset.resetsAt, now)}` : "never"
          }
          hint={
            nextReset?.resetsAt
              ? `${formatDate(nextReset.resetsAt, undefined, "MMM d, HH:mm")} (${nextReset.window})`
              : undefined
          }
        />
      </div>

      <Section title="Limits">
        {balance.limits.length === 0 ? (
          <Muted>No limits. Every request passes and usage is only counted.</Muted>
        ) : (
          <div className="flex flex-col gap-4">
            {balance.limits.map((limit) => (
              <LimitRow key={limit.id} limit={limit} unit={unit} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Usage by period">
        <UsageByPeriod history={history} unit={unit} />
      </Section>

      <Section
        title="Expiring next"
        description={`${amount(sumAmounts(pages.map((page) => page.listed)))} of ${amount(balance.held)} held listed`}
      >
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
                <ReservationRow key={`${row.kind}:${row.id}`} row={row} unit={unit} now={now} />
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            At expiry an open hold is charged in full. Capacity returns when its window resets.
          </p>
          <div className="flex items-center gap-3">
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
        </div>
      </Section>

      <Section
        title="Closed in the last hour"
        description="Recent rows, newest first. The list can miss rows when many closed."
      >
        {closedRecently.length === 0 ? (
          <Muted>Nothing closed in the last hour.</Muted>
        ) : (
          <Table>
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
                    <TableCell className="font-mono text-xs tabular-nums">{line.detail}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  )
}

function ReservationRow({ row, unit, now }: { row: Reservation; unit: string; now: number }) {
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
      <TableCell className="text-muted-foreground text-xs">
        {isHold ? null : "only its holder can return it"}
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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="font-medium font-mono text-sm">{limit.id}</span>
          <Badge variant={limit.enforce === "hard" ? "default" : "secondary"}>
            {limit.enforce}
          </Badge>
          <span className="text-muted-foreground text-xs">{limit.window}</span>
        </span>
        <span className="font-mono text-xs tabular-nums">
          {amount(limit.consumed)} used · {amount(limit.held)} held · {left} of{" "}
          {amount(limit.amount)}
          <span className="text-muted-foreground">
            {" · "}
            {limit.resetsAt === null
              ? "never resets"
              : `resets ${formatDate(limit.resetsAt, undefined, "MMM d, HH:mm")}`}
          </span>
        </span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-background-bgHover"
        role="img"
        aria-label={`${amount(limit.consumed)} used and ${amount(limit.held)} held of ${amount(limit.amount)}`}
      >
        <div className="h-full bg-primary-solid" style={{ width: `${consumed}%` }} />
        <div className="h-full bg-warning-solid" style={{ width: `${held}%` }} />
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
    <div className="flex flex-col gap-4">
      {[...windows].map(([windowId, periods]) => {
        const shown = periods.slice(-12)
        const max = shown.reduce((top, p) => Math.max(top, Number(toBaseUnits(p.consumed))), 0)
        return (
          <div key={windowId} className="flex items-end gap-4">
            <span className="w-40 shrink-0 text-muted-foreground text-xs">
              {windowId.split("@")[0]}, last {shown.length}
            </span>
            <div className="flex h-10 items-end gap-1">
              {shown.map((period) => (
                <div
                  key={period.start}
                  className="w-3 rounded-sm bg-primary-solid"
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

/** The hard limit with the least room, or the tightest soft one when none is hard. */
function tightestLimit(limits: Limit[]): Limit | undefined {
  const hard = limits.filter((limit) => limit.enforce === "hard")
  return (hard.length > 0 ? hard : limits).reduce<Limit | undefined>(
    (tightest, limit) =>
      !tightest || toBaseUnits(limit.remaining) < toBaseUnits(tightest.remaining)
        ? limit
        : tightest,
    undefined
  )
}

function nextResettingLimit(limits: Limit[]): Limit | undefined {
  return limits.reduce<Limit | undefined>(
    (next, limit) =>
      limit.resetsAt !== null && (!next?.resetsAt || limit.resetsAt < next.resetsAt) ? limit : next,
    undefined
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-1">
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle className="font-mono text-lg tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="min-h-8 px-4 pb-4 text-muted-foreground text-xs">{hint}</CardContent>
    </Card>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-medium text-sm">{title}</h3>
        {description && <span className="text-muted-foreground text-xs">{description}</span>}
      </div>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface-panel px-4 py-3 text-muted-foreground text-xs">
      {children}
    </div>
  )
}

export function BudgetLiveSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-80" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["remaining", "held", "consumed", "resets"].map((key) => (
          <Skeleton key={key} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-28" />
      <Skeleton className="h-16" />
      <Skeleton className="h-48" />
    </div>
  )
}
