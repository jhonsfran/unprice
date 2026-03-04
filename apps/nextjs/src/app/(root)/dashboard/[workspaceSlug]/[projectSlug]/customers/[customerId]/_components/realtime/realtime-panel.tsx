"use client"

import { useMutation } from "@tanstack/react-query"
import { API_DOMAIN } from "@unprice/config"
import {
  type EntitlementRealtimeEvent,
  UnpriceProvider,
  useUnpriceEntitlementsRealtime,
  useUnpriceUsage,
} from "@unprice/react"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@unprice/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@unprice/ui/chart"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import { AnimatePresence, motion } from "framer-motion"
import { Activity, BarChart2, CircleHelp, Clock, Shield, ShieldCheck, Zap } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { NumberTicker } from "~/components/analytics/number-ticker"
import { RealtimeIntervalFilter } from "~/components/analytics/realtime-interval-filter"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { useRealtimeIntervalFilter } from "~/hooks/use-filter"
import { formatNumber } from "~/lib/numbers"
import { useTRPC } from "~/trpc/client"

type Metrics = {
  usageCount: number
  verificationCount: number
  totalUsage: number
  allowedCount: number
  deniedCount: number
  limitExceededCount: number
  bucketSizeSeconds: number
  featureStats: Array<{
    featureSlug: string
    usageCount: number
    verificationCount: number
    totalUsage: number
  }>
  usageSeries: Array<{
    bucketStart: number
    usageCount: number
    totalUsage: number
  }>
  verificationSeries: Array<{
    bucketStart: number
    verificationCount: number
    allowedCount: number
    deniedCount: number
    limitExceededCount: number
  }>
  oldestTimestamp: number | null
  newestTimestamp: number | null
}

type RealtimeEvent = {
  at: number
  featureSlug: string
  type: "verify" | "reportUsage"
  success: boolean
  usage?: number
  limit?: number
  latencyMs?: number
  deniedReason?: string
}

const usageChartConfig = {
  totalUsage: { label: "Usage", color: "var(--chart-4)" },
} satisfies ChartConfig

const verificationChartConfig = {
  verificationAllowedCount: { label: "Verify allowed", color: "var(--chart-4)" },
  verificationDeniedPolicyCount: {
    label: "denied",
    color: "var(--chart-1)",
  },
  usageReportedCount: { label: "Usage reports", color: "var(--chart-2)" },
  usageLimitExceededCount: {
    label: "limit exceeded",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig

const SNAPSHOT_STALE_THRESHOLD_MS = 20_000
const REFRESH_NOTICE_GRACE_MS = 1_000
const INITIAL_CONNECTION_FAILURE_GRACE_MS = 5_000

type RealtimeWindowSeconds = 300 | 3600 | 86400 | 604800

function normalizeEpochSeconds(value: number | null): number | null {
  if (typeof value !== "number") {
    return null
  }

  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

function InfoTooltip({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground transition-colors hover:text-foreground"
          aria-label="More info"
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs">{content}</TooltipContent>
    </Tooltip>
  )
}

function resolveBucketSizeSeconds(windowSeconds: number): number {
  if (windowSeconds <= 300) return 60
  if (windowSeconds <= 3600) return 300
  if (windowSeconds <= 86400) return 3600
  return 86400
}

function formatBucketLabel(bucketSizeSeconds: number): string {
  if (bucketSizeSeconds % 86400 === 0) {
    return `${bucketSizeSeconds / 86400}d`
  }
  if (bucketSizeSeconds % 3600 === 0) {
    return `${bucketSizeSeconds / 3600}h`
  }
  return `${bucketSizeSeconds / 60}m`
}

function formatBucketTimestamp(timestamp: number, bucketSizeSeconds: number): string {
  const date = new Date(timestamp)

  if (bucketSizeSeconds >= 86400) {
    return date.toLocaleDateString([], {
      month: "short",
      day: "2-digit",
    })
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

type RealtimePanelProps = {
  customerId: string
  projectId: string
  realtimeTicket: string | null
  realtimeTicketExpiresAt: number | null
  runtimeEnv: string
}

function normalizeRealtimeWindowSeconds(windowSeconds: number): RealtimeWindowSeconds {
  if (windowSeconds === 300 || windowSeconds === 3600 || windowSeconds === 86400) {
    return windowSeconds
  }

  return 604800
}

function isRealtimeAuthErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("token") ||
    normalized.includes("ticket") ||
    normalized.includes("expired") ||
    normalized.includes("unauthorized")
  )
}

export function RealtimePanel(props: RealtimePanelProps) {
  const { customerId, projectId, realtimeTicket, realtimeTicketExpiresAt, runtimeEnv } = props
  const trpc = useTRPC()
  const [windowSeconds] = useRealtimeIntervalFilter()
  const realtimeWindowSeconds = useMemo(
    () => normalizeRealtimeWindowSeconds(windowSeconds),
    [windowSeconds]
  )
  const refreshRealtimeTicketMutation = useMutation(
    trpc.analytics.getRealtimeTicket.mutationOptions()
  )

  const initialTicket = useMemo(() => {
    if (!realtimeTicket) {
      return null
    }

    const normalizedExpiresAt = normalizeEpochSeconds(realtimeTicketExpiresAt)
    return {
      ticket: realtimeTicket,
      expiresAt: normalizedExpiresAt ?? Math.floor(Date.now() / 1000) + 60,
    }
  }, [realtimeTicket, realtimeTicketExpiresAt])

  const getRealtimeTicket = useCallback(
    async (params: {
      customerId: string
      projectId: string
      reason: "init" | "pre_expiry" | "expired" | "reconnect" | "manual"
      currentExpiresAt: number | null
    }) => {
      const ticketResponse = await refreshRealtimeTicketMutation.mutateAsync({
        customerId: params.customerId,
      })
      const normalizedExpiresAt = normalizeEpochSeconds(ticketResponse.expiresAt)

      return {
        ticket: ticketResponse.ticket,
        expiresAt: normalizedExpiresAt ?? Math.floor(Date.now() / 1000) + 60,
      }
    },
    [refreshRealtimeTicketMutation]
  )

  return (
    <UnpriceProvider
      realtime={{
        customerId,
        projectId,
        runtimeEnv,
        apiBaseUrl: API_DOMAIN,
        snapshotWindowSeconds: realtimeWindowSeconds,
        initialTicket,
        getRealtimeTicket,
      }}
    >
      <RealtimePanelContent {...props} windowSeconds={realtimeWindowSeconds} />
    </UnpriceProvider>
  )
}

function RealtimePanelContent(
  props: RealtimePanelProps & {
    windowSeconds: RealtimeWindowSeconds
  }
) {
  const { windowSeconds, realtimeTicket } = props
  const {
    metrics: realtimeMetrics,
    events: realtimeEvents,
    subscription,
    lastSnapshotAt,
    socketStatus,
    eventStreamState,
    eventStreamPausedAt,
    error: realtimeError,
    isRefreshingToken: isRefreshingTicket,
    refreshRealtimeToken,
    refreshSnapshot,
    resumeEventStream,
  } = useUnpriceEntitlementsRealtime()
  const metrics = realtimeMetrics as Metrics | null
  const events = useMemo<RealtimeEvent[]>(() => {
    return realtimeEvents.map((event: EntitlementRealtimeEvent) => ({
      at: event.at,
      featureSlug: event.featureSlug,
      type: event.type,
      success: event.success,
      usage: event.usage,
      limit: event.limit,
      latencyMs: event.latencyMs,
      deniedReason: event.deniedReason,
    }))
  }, [realtimeEvents])

  const [browserTimezone, setBrowserTimezone] = useState<string | null>(null)
  const [snapshotClockMs, setSnapshotClockMs] = useState(() => Date.now())
  const [hasOpenedRealtimeSocket, setHasOpenedRealtimeSocket] = useState(false)
  const [hasInitialConnectionFailureGraceElapsed, setHasInitialConnectionFailureGraceElapsed] =
    useState(false)
  const [showRefreshNotice, setShowRefreshNotice] = useState(false)

  useEffect(() => {
    const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    setBrowserTimezone(resolvedTimeZone || null)
  }, [])

  useEffect(() => {
    const intervalId = setInterval(() => {
      setSnapshotClockMs(Date.now())
    }, 5_000)

    return () => {
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (socketStatus === "open") {
      setHasOpenedRealtimeSocket(true)
    }
  }, [socketStatus])

  useEffect(() => {
    if (hasOpenedRealtimeSocket || hasInitialConnectionFailureGraceElapsed) {
      return
    }

    const timeoutId = setTimeout(() => {
      setHasInitialConnectionFailureGraceElapsed(true)
    }, INITIAL_CONNECTION_FAILURE_GRACE_MS)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [hasOpenedRealtimeSocket, hasInitialConnectionFailureGraceElapsed])

  const desiredBucketSizeSeconds = useMemo(
    () => resolveBucketSizeSeconds(windowSeconds),
    [windowSeconds]
  )
  const sourceBucketSizeSeconds = metrics?.bucketSizeSeconds ?? desiredBucketSizeSeconds
  const chartBucketSizeSeconds = Math.max(sourceBucketSizeSeconds, desiredBucketSizeSeconds)
  const isRollupActive = sourceBucketSizeSeconds < chartBucketSizeSeconds
  const rollupLabel = isRollupActive
    ? ` - grouped from ${formatBucketLabel(sourceBucketSizeSeconds)} to ${formatBucketLabel(chartBucketSizeSeconds)}.`
    : ""

  const usageSeriesRows = useMemo(() => {
    const grouped = new Map<
      number,
      {
        bucketStart: number
        usageCount: number
        totalUsage: number
      }
    >()

    for (const bucket of metrics?.usageSeries ?? []) {
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = grouped.get(groupStart)
      if (existing) {
        existing.usageCount += bucket.usageCount
        existing.totalUsage += bucket.totalUsage
        continue
      }

      grouped.set(groupStart, {
        bucketStart: groupStart,
        usageCount: bucket.usageCount,
        totalUsage: bucket.totalUsage,
      })
    }

    return Array.from(grouped.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((bucket) => ({
        ...bucket,
        time: formatBucketTimestamp(bucket.bucketStart, chartBucketSizeSeconds),
      }))
  }, [metrics?.usageSeries, chartBucketSizeSeconds])

  const verificationSeriesRows = useMemo(() => {
    const seriesByBucket = new Map<
      number,
      {
        bucketStart: number
        verificationAllowedCount: number
        verificationDeniedPolicyCount: number
        usageReportedCount: number
        usageLimitExceededCount: number
      }
    >()

    for (const bucket of metrics?.verificationSeries ?? []) {
      const policyDeniedCount = Math.max(bucket.deniedCount - bucket.limitExceededCount, 0)
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = seriesByBucket.get(groupStart)
      if (existing) {
        existing.verificationAllowedCount += bucket.allowedCount
        existing.verificationDeniedPolicyCount += policyDeniedCount
        existing.usageLimitExceededCount += bucket.limitExceededCount
        continue
      }

      seriesByBucket.set(groupStart, {
        bucketStart: groupStart,
        verificationAllowedCount: bucket.allowedCount,
        verificationDeniedPolicyCount: policyDeniedCount,
        usageReportedCount: 0,
        usageLimitExceededCount: bucket.limitExceededCount,
      })
    }

    for (const bucket of metrics?.usageSeries ?? []) {
      const groupStart =
        Math.floor(bucket.bucketStart / (chartBucketSizeSeconds * 1000)) *
        chartBucketSizeSeconds *
        1000

      const existing = seriesByBucket.get(groupStart)
      if (existing) {
        existing.usageReportedCount += bucket.usageCount
        continue
      }

      seriesByBucket.set(groupStart, {
        bucketStart: groupStart,
        verificationAllowedCount: 0,
        verificationDeniedPolicyCount: 0,
        usageReportedCount: bucket.usageCount,
        usageLimitExceededCount: 0,
      })
    }

    return Array.from(seriesByBucket.values())
      .sort((a, b) => a.bucketStart - b.bucketStart)
      .map((bucket) => ({
        ...bucket,
        time: formatBucketTimestamp(bucket.bucketStart, chartBucketSizeSeconds),
      }))
  }, [metrics?.verificationSeries, metrics?.usageSeries, chartBucketSizeSeconds])

  const successRate = useMemo(() => {
    if (!metrics || metrics.verificationCount === 0) {
      return null
    }

    return Math.min(100, Math.max(0, (metrics.allowedCount / metrics.verificationCount) * 100))
  }, [metrics?.verificationCount, metrics?.allowedCount])

  const { rows: entitlementRows } = useUnpriceUsage({ scope: "entitlements" })
  const currentPlanSlug = subscription?.planSlug ?? null
  const currentCycleStartAt = subscription?.cycleStartAt ?? null
  const currentCycleEndAt = subscription?.cycleEndAt ?? null
  const cycleTimezone = subscription?.timezone ?? null
  const currentPhaseBillingPeriod = subscription?.billingInterval ?? null

  const maxVisibleEntitlementUsage = useMemo(() => {
    return entitlementRows.reduce((maxUsage, entitlement) => {
      return Math.max(maxUsage, entitlement.usage ?? 0)
    }, 0)
  }, [entitlementRows])

  const formatDateForTimezone = (value: number, timeZone?: string | null) => {
    const date = new Date(value)

    try {
      return new Intl.DateTimeFormat([], {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone ?? undefined,
      }).format(date)
    } catch {
      return new Intl.DateTimeFormat([], {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    }
  }

  const cyclePeriodLabel = useMemo(() => {
    if (!currentCycleStartAt) {
      return "No active cycle"
    }

    if (!currentCycleEndAt) {
      return `${formatDateForTimezone(currentCycleStartAt, cycleTimezone)} → Ongoing`
    }

    return `${formatDateForTimezone(currentCycleStartAt, cycleTimezone)} → ${formatDateForTimezone(currentCycleEndAt, cycleTimezone)}`
  }, [currentCycleStartAt, currentCycleEndAt, cycleTimezone])

  const browserCyclePeriodLabel = useMemo(() => {
    if (!currentCycleStartAt || !browserTimezone) {
      return null
    }

    if (!currentCycleEndAt) {
      return `${formatDateForTimezone(currentCycleStartAt, browserTimezone)} → Ongoing`
    }

    return `${formatDateForTimezone(currentCycleStartAt, browserTimezone)} → ${formatDateForTimezone(currentCycleEndAt, browserTimezone)}`
  }, [currentCycleStartAt, currentCycleEndAt, browserTimezone])

  const bucketLabel = formatBucketLabel(chartBucketSizeSeconds)
  const isRealtimeLive = socketStatus === "open"
  const isRealtimeConnecting = socketStatus === "connecting"
  const isEventStreamPaused = eventStreamState === "paused"
  const hasSocketFailure = socketStatus === "closed" || socketStatus === "error"
  const canSurfaceConnectionFailure =
    hasOpenedRealtimeSocket || hasInitialConnectionFailureGraceElapsed
  const isBootstrappingInitialTicket =
    !realtimeTicket && !hasOpenedRealtimeSocket && !hasInitialConnectionFailureGraceElapsed
  const isAuthRealtimeError =
    typeof realtimeError?.message === "string" && isRealtimeAuthErrorMessage(realtimeError.message)
  const hasRefreshableFailure =
    (hasSocketFailure || (!isRealtimeLive && Boolean(realtimeError))) &&
    socketStatus !== "connecting" &&
    socketStatus !== "idle" &&
    canSurfaceConnectionFailure &&
    !isBootstrappingInitialTicket
  useEffect(() => {
    if (!hasRefreshableFailure || isRefreshingTicket) {
      setShowRefreshNotice(false)
      return
    }

    const timeoutId = setTimeout(() => {
      setShowRefreshNotice(true)
    }, REFRESH_NOTICE_GRACE_MS)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [hasRefreshableFailure, isRefreshingTicket])
  const shouldShowRefreshNotice = showRefreshNotice
  const isSnapshotStale =
    socketStatus === "open" &&
    (typeof lastSnapshotAt !== "number" ||
      snapshotClockMs - lastSnapshotAt > SNAPSHOT_STALE_THRESHOLD_MS)
  const shouldShowRefreshRequiredStatus =
    Boolean(realtimeError) &&
    canSurfaceConnectionFailure &&
    !isRefreshingTicket &&
    !isBootstrappingInitialTicket
  const realtimeStatusLabel = isRealtimeLive
    ? isEventStreamPaused
      ? "Live (events paused)"
      : isSnapshotStale
        ? "Live (stale)"
        : "Live"
    : isRealtimeConnecting || isBootstrappingInitialTicket || isRefreshingTicket
      ? "Connecting"
      : shouldShowRefreshRequiredStatus
        ? "Refresh required"
        : "Unavailable"
  const shouldShowRealtimeError =
    Boolean(realtimeError) &&
    !isBootstrappingInitialTicket &&
    (shouldShowRefreshNotice || (socketStatus === "open" && !isAuthRealtimeError))

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 font-semibold text-lg tracking-tight">
            Realtime Activity
            <div className="inline-block">
              <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs shadow-sm">
                <span className="relative flex h-2 w-2">
                  {isRealtimeLive && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  )}
                  <span
                    className={cn(
                      "relative inline-flex h-2 w-2 rounded-full",
                      isRealtimeLive
                        ? isEventStreamPaused
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                        : isRealtimeConnecting
                          ? "bg-amber-500"
                          : "bg-muted-foreground/50"
                    )}
                  />
                </span>
                <span className="font-medium text-muted-foreground">{realtimeStatusLabel}</span>
              </div>
            </div>
          </h3>
          <p className="text-muted-foreground text-sm">
            Live usage and verification metrics for this customer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RealtimeIntervalFilter className="w-[180px]" />
        </div>
      </div>

      {shouldShowRefreshNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
          <p className="text-amber-800 text-sm dark:text-amber-200">
            Realtime connection needs refresh.{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-amber-800 underline-offset-2 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
              onClick={() => void refreshRealtimeToken()}
              disabled={isRefreshingTicket}
            >
              {isRefreshingTicket ? "Refreshing..." : "Refresh to reconnect"}
            </Button>
          </p>
        </div>
      )}

      {isSnapshotStale && !shouldShowRefreshNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
          <p className="text-amber-800 text-sm dark:text-amber-200">
            Realtime socket is connected but snapshot data is stale.{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-amber-800 underline-offset-2 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
              onClick={() => refreshSnapshot()}
            >
              Retry snapshot now
            </Button>
          </p>
        </div>
      )}

      {isEventStreamPaused && !shouldShowRefreshNotice && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
          <p className="text-amber-800 text-sm dark:text-amber-200">
            Live event stream paused
            {typeof eventStreamPausedAt === "number"
              ? ` at ${new Date(eventStreamPausedAt).toLocaleTimeString()}`
              : ""}
            .{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-amber-800 underline-offset-2 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
              onClick={() => resumeEventStream()}
            >
              Resume event stream
            </Button>
          </p>
        </div>
      )}

      {shouldShowRealtimeError && realtimeError && (
        <p className="text-destructive text-sm">{realtimeError.message}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.25fr_2fr]">
        <Card className="border-muted/60 bg-gradient-to-br from-background to-muted/30">
          <CardHeader className="pb-0" />
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground text-xs">Current plan</p>
              <p className="font-semibold text-base">{currentPlanSlug ?? "No active plan"}</p>
            </div>
            <div>
              <p className="flex items-center gap-1 text-muted-foreground text-xs">
                billing period
                {browserCyclePeriodLabel && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        aria-label="Show billing period in browser timezone"
                      >
                        <CircleHelp className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[320px] text-xs">
                      <p>{browserCyclePeriodLabel}</p>
                      {browserTimezone && (
                        <p className="mt-1 text-muted-foreground">
                          Browser timezone: {browserTimezone}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}
              </p>
              <div className="flex items-center pt-1.5">
                <p className="font-medium text-xs">{cyclePeriodLabel}</p>
              </div>
              {cycleTimezone && <p className="text-muted-foreground text-xs">{cycleTimezone}</p>}
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Billing cycle</p>
              <p className="font-medium text-sm">{currentPhaseBillingPeriod ?? "Unavailable"}</p>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Total usage</CardTitle>
                <InfoTooltip content="Sum of usage units reported by `reportUsage` events in the selected interval." />
              </div>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                <NumberTicker value={metrics?.totalUsage ?? 0} />
              </div>
              <p className="text-muted-foreground text-xs">
                Across {metrics?.usageCount ?? 0} events
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Verifications</CardTitle>
                <InfoTooltip content="Count of `verify` checks. Denied is split into policy denials and limit-exceeded denials." />
              </div>
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                <NumberTicker value={metrics?.verificationCount ?? 0} />
              </div>
              <p className="text-muted-foreground text-xs">
                {metrics?.allowedCount ?? 0} allowed · {metrics?.deniedCount ?? 0} denied ·{" "}
                {metrics?.limitExceededCount ?? 0} exceeded
              </p>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-muted/60 bg-gradient-to-br from-background to-muted/20">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="font-medium text-sm">Success rate</CardTitle>
                <InfoTooltip content="Formula: allowed verifications / total verifications * 100." />
              </div>
              <Zap className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="font-bold text-2xl">
                {successRate === null ? (
                  "—"
                ) : (
                  <NumberTicker value={successRate} decimalPlaces={1} />
                )}
                {successRate === null ? "" : "%"}
              </div>
              <p className="text-muted-foreground text-xs">Verification pass ratio</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 border-muted/60">
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">Usage Volume</CardTitle>
              <InfoTooltip content="Timeline of usage units from `reportUsage`. Buckets are grouped for readability when needed." />
            </div>
            <CardDescription>
              Total usage reported over time ({bucketLabel} buckets){rollupLabel}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 overflow-hidden">
            <ChartContainer config={usageChartConfig} className="h-[280px] w-full min-w-0">
              <AreaChart data={usageSeriesRows}>
                <defs>
                  <linearGradient id="fillTotalUsage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-totalUsage)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-totalUsage)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  dy={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Area
                  type="monotone"
                  dataKey="totalUsage"
                  stroke="var(--color-totalUsage)"
                  fill="url(#fillTotalUsage)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-muted/60">
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">Verification and Usage Outcomes</CardTitle>
              <InfoTooltip content="Verification stack: allowed and policy denied. Usage stack: usage reports and verify denials caused by limit exceeded." />
            </div>
            <CardDescription>
              Verification outcomes are separated from usage reporting ({bucketLabel} buckets)
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0 overflow-hidden">
            <ChartContainer config={verificationChartConfig} className="h-[280px] w-full min-w-0">
              <BarChart data={verificationSeriesRows}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-muted" />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={30}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                  dy={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Bar
                  dataKey="verificationAllowedCount"
                  stackId="verifications"
                  fill="var(--color-verificationAllowedCount)"
                  radius={[0, 0, 4, 4]}
                />
                <Bar
                  dataKey="verificationDeniedPolicyCount"
                  stackId="verifications"
                  fill="var(--color-verificationDeniedPolicyCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="usageReportedCount"
                  stackId="usage"
                  fill="var(--color-usageReportedCount)"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="usageLimitExceededCount"
                  stackId="usage"
                  fill="var(--color-usageLimitExceededCount)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
            <div className="mt-2 grid gap-1 text-muted-foreground text-xs">
              <p>Verification stack: verify allowed + verify denied (policy)</p>
              <p>Usage stack: usage reports + verify denied (limit exceeded)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <Card className="border-muted/60 lg:flex lg:w-[32%] lg:flex-none lg:flex-col">
          <CardHeader>
            <CardTitle className="text-base">Entitlements</CardTitle>
            <CardDescription>Usage in the current billing cycle</CardDescription>
          </CardHeader>
          <CardContent className="lg:flex-1">
            <ScrollArea
              className="h-[455px] lg:h-full [&_[data-radix-scroll-area-scrollbar]]:hidden"
              hideScrollBar
            >
              {entitlementRows.length === 0 ? (
                <EmptyPlaceholder className="h-[240px] w-auto border border-dashed">
                  <EmptyPlaceholder.Icon>
                    <BarChart2 className="h-8 w-8 opacity-30" />
                  </EmptyPlaceholder.Icon>
                  <EmptyPlaceholder.Title>No active entitlements</EmptyPlaceholder.Title>
                  <EmptyPlaceholder.Description>
                    Customer has no active entitlements.
                  </EmptyPlaceholder.Description>
                </EmptyPlaceholder>
              ) : (
                <div className="space-y-4">
                  {entitlementRows.map((entitlement, index) => {
                    const featureType = entitlement.featureType
                    const isFlatFeature = featureType === "flat"
                    const limitValue =
                      typeof entitlement.limit === "number" &&
                      Number.isFinite(entitlement.limit) &&
                      entitlement.limit >= 0
                        ? entitlement.limit
                        : null
                    const hasLimit = limitValue !== null
                    const usageValue = entitlement.usage ?? 0
                    const effectiveLimitType = entitlement.limitType
                    const allowsOverage = effectiveLimitType !== "hard"

                    let usageReference = 1
                    if (limitValue !== null) {
                      usageReference = limitValue
                    } else if (maxVisibleEntitlementUsage > 0) {
                      usageReference = maxVisibleEntitlementUsage
                    }

                    const rawUsagePercent = isFlatFeature
                      ? 100
                      : hasLimit
                        ? (usageValue / usageReference) * 100
                        : usageValue > 0
                          ? 90
                          : 0
                    const usageProgressPercent = isFlatFeature
                      ? 100
                      : hasLimit
                        ? Math.min(100, Math.max(rawUsagePercent, 0))
                        : usageValue > 0
                          ? 90
                          : 0
                    const overagePercent =
                      !isFlatFeature && hasLimit && allowsOverage
                        ? Math.min(100, Math.max(rawUsagePercent - 100, 0))
                        : 0

                    const usageStatusText = isFlatFeature
                      ? "Flat feature"
                      : hasLimit
                        ? `${formatNumber(usageValue)} used of ${formatNumber(limitValue)}`
                        : `${formatNumber(usageValue)} used (unlimited)`

                    const usageBarColor = isFlatFeature
                      ? "hsl(var(--muted-foreground) / 0.35)"
                      : hasLimit && rawUsagePercent > 100
                        ? allowsOverage
                          ? "hsl(var(--chart-5))"
                          : "hsl(var(--destructive))"
                        : `var(--chart-${(index % 5) + 1})`

                    const usageSummaryText = isFlatFeature ? "Flat feature" : `${usageStatusText}`

                    return (
                      <div key={entitlement.featureSlug} className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium">{entitlement.featureSlug}</span>
                          </div>
                          <span className="text-muted-foreground text-xs">{usageSummaryText}</span>
                        </div>
                        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full"
                            style={{
                              backgroundColor: usageBarColor,
                              width: `${usageProgressPercent}%`,
                            }}
                          />
                          {overagePercent > 0 && (
                            <div
                              className="absolute inset-y-0 right-0 bg-amber-500/40"
                              style={{ width: `${overagePercent}%` }}
                            />
                          )}
                        </div>
                        <div className="flex items-center justify-between text-muted-foreground text-xs">
                          <span>{isFlatFeature ? "flat feature" : ""}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="min-w-0 border-muted/60 lg:flex lg:w-[68%] lg:flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Live Event Stream</CardTitle>
                <CardDescription>Real-time verification and usage logs</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {events.length} events
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="lg:flex-1">
            {events.length === 0 ? (
              <EmptyPlaceholder className="h-[240px] w-auto border border-dashed">
                <EmptyPlaceholder.Icon>
                  <BarChart2 className="h-8 w-8 opacity-30" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>Waiting for events</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Live events will appear here automatically.
                </EmptyPlaceholder.Description>
              </EmptyPlaceholder>
            ) : (
              <ScrollArea
                className="h-[460px] [&_[data-radix-scroll-area-scrollbar]]:hidden"
                hideScrollBar
              >
                <AnimatePresence initial={false}>
                  {events.map((event) => {
                    const detailParts: string[] = []

                    if (event.type === "reportUsage") {
                      if (typeof event.usage === "number") {
                        detailParts.push(`usage ${event.usage}`)
                      }
                      if (typeof event.limit === "number") {
                        detailParts.push(`limit ${event.limit}`)
                      }
                    } else {
                      detailParts.push(
                        event.success ? "verification allowed" : "verification denied"
                      )
                    }

                    if (event.deniedReason) {
                      detailParts.push(event.deniedReason)
                    }

                    if (typeof event.latencyMs === "number") {
                      detailParts.push(`${event.latencyMs}ms`)
                    }

                    if (detailParts.length === 0) {
                      detailParts.push("verification check")
                    }

                    return (
                      <motion.div
                        key={`${event.at}-${event.featureSlug}-${event.type}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.18 }}
                        layout="position"
                        className="flex items-center justify-between border-b px-5 py-3.5 hover:bg-muted/40"
                        style={{ borderColor: "hsl(var(--border) / 0.6)" }}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {event.type === "verify" ? (
                            <Shield
                              className={cn(
                                "h-4 w-4",
                                event.success ? "text-muted-foreground" : "text-amber-600"
                              )}
                            />
                          ) : (
                            <Activity className="h-4 w-4 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-medium text-sm">
                                {event.featureSlug}
                              </span>
                              <span className="text-muted-foreground text-xs">{event.type}</span>
                            </div>
                            <p className="truncate text-muted-foreground text-xs">
                              {detailParts.join(" · ")}
                            </p>
                          </div>
                        </div>
                        <div className="ml-3 flex items-center gap-2 whitespace-nowrap text-muted-foreground text-xs">
                          <Clock className="h-3 w-3" />
                          <span>{new Date(event.at).toLocaleTimeString()}</span>
                        </div>
                      </motion.div>
                    )
                  })}
                </AnimatePresence>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
