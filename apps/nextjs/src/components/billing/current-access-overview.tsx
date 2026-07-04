import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Progress } from "@unprice/ui/progress"
import { cn } from "@unprice/ui/utils"
import { ArrowUpRight, CalendarRange, KeyRound } from "lucide-react"
import type { ReactNode } from "react"
import { FreshnessIndicator } from "~/components/analytics/freshness-indicator"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"
import { formatWalletMoney } from "./format-wallet-money"

export type CurrentAccessData = RouterOutputs["customers"]["getCurrentAccess"]
export type CurrentAccessEntitlement = CurrentAccessData["entitlements"][number]
export type CurrentAccessWallet = RouterOutputs["customers"]["getWallet"]["wallet"]

type BillingConfig = NonNullable<
  NonNullable<CurrentAccessData["activePlan"]>["activePhase"]
>["planVersion"]["billingConfig"]

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})

const LONG_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export function CurrentAccessOverview({
  access,
  wallet,
  title = "Current plan + access",
  description = "Active subscription context and entitlement usage for the current entitlement period.",
  isFetching = false,
  billingPeriodAction,
  planAction,
  noActivePlanDescription = "This customer has no active subscription billing period.",
  noActiveEntitlementsDescription = "Access grants will appear here once the customer has an active subscription phase.",
  renderEntitlementAction,
}: {
  access: CurrentAccessData
  wallet: CurrentAccessWallet
  title?: string
  description?: string
  isFetching?: boolean
  billingPeriodAction?: ReactNode
  planAction?: ReactNode
  noActivePlanDescription?: string
  noActiveEntitlementsDescription?: string
  renderEntitlementAction?: (entitlement: CurrentAccessEntitlement) => ReactNode
}) {
  const activePlan = access.activePlan
  const activePhase = activePlan?.activePhase ?? null
  const walletAvailable = wallet.balances.purchased + wallet.balances.granted
  const walletHeld = wallet.balances.reserved

  return (
    <section className="flex flex-col gap-4">
      <SectionIntro
        title={title}
        description={description}
        className="px-0 py-0"
        actions={<FreshnessIndicator generatedAt={access.generatedAt} isFetching={isFetching} />}
      />

      <div className="grid gap-4 lg:grid-cols-[0.95fr_1.55fr]">
        <div className="flex max-h-[520px] min-h-[360px] flex-col overflow-hidden rounded-md border border-border/60">
          <div className="flex items-center justify-between gap-3 border-border/60 border-b bg-card/70 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <CalendarRange className="mr-2 size-6 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium text-sm">Billing period</p>
                <p className="truncate text-muted-foreground text-xs">
                  {activePlan ? "Current subscription window" : "No active subscription window"}
                </p>
              </div>
            </div>
            {billingPeriodAction ? <div className="shrink-0">{billingPeriodAction}</div> : null}
          </div>

          <div className="px-4 py-4">
            {activePlan ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="truncate font-semibold text-lg">{activePlan.planSlug}</p>
                      {activePhase && (
                        <p className="shrink-0 text-muted-foreground text-xs">
                          v{activePhase.planVersion.version}
                        </p>
                      )}
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {formatPeriod(activePlan.currentCycleStartAt, activePlan.currentCycleEndAt, {
                        billingConfig: activePhase?.planVersion.billingConfig,
                        timezone: activePlan.timezone,
                      })}
                    </p>
                  </div>
                  {planAction ? <div className="shrink-0">{planAction}</div> : null}
                </div>

                <dl className="grid gap-3 text-sm">
                  <PlanFact label="Status" value={formatStatus(activePlan.status)} />
                  <PlanFact
                    label="Renews"
                    value={formatDate(activePlan.renewAt ?? activePlan.currentCycleEndAt)}
                  />
                  <PlanFact
                    label="Billing cadence"
                    value={
                      activePhase
                        ? formatBillingCadence(activePhase.planVersion.billingConfig)
                        : "None"
                    }
                  />
                  <PlanFact
                    label="Payment provider"
                    value={
                      activePhase ? formatPaymentProvider(activePhase.paymentProvider) : "None"
                    }
                  />
                  <PlanFact
                    label="Wallet available"
                    value={formatWalletMoney(walletAvailable, wallet.currency)}
                  />
                  <PlanFact
                    label="Wallet held"
                    value={formatWalletMoney(walletHeld, wallet.currency)}
                  />
                </dl>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-lg">No active plan</p>
                <p className="text-muted-foreground text-sm">{noActivePlanDescription}</p>
                <dl className="mt-3 grid gap-3 text-sm">
                  <PlanFact
                    label="Wallet available"
                    value={formatWalletMoney(walletAvailable, wallet.currency)}
                  />
                  <PlanFact
                    label="Wallet held"
                    value={formatWalletMoney(walletHeld, wallet.currency)}
                  />
                </dl>
              </div>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-border/60">
          <div className="flex items-center justify-between gap-3 border-border/60 border-b bg-card/70 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <KeyRound className="mr-2 size-6 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium text-sm">Active entitlements</p>
                <p className="truncate text-muted-foreground text-xs">
                  {access.usageUnavailable
                    ? "Current usage temporarily unavailable"
                    : activePlan
                      ? "Current entitlement period usage"
                      : "Current active access"}
                </p>
              </div>
            </div>
            <p className="shrink-0 text-muted-foreground text-xs">
              {access.entitlementCount} total
            </p>
          </div>

          {access.entitlements.length > 0 ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="divide-y divide-border/60">
                {access.entitlements.map((entitlement) => (
                  <EntitlementUsageRow
                    key={entitlement.id}
                    entitlement={entitlement}
                    usageUnavailable={access.usageUnavailable}
                    timezone={activePlan?.timezone}
                    action={renderEntitlementAction?.(entitlement)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[168px] flex-col items-center justify-center gap-1 px-4 py-8 text-center">
              <p className="font-medium text-sm">No active entitlements</p>
              <p className="max-w-md text-muted-foreground text-sm">
                {noActiveEntitlementsDescription}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export function PlanVersionButton({ href }: { href: string }) {
  return (
    <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
      <SuperLink href={href} target="_blank" rel="noreferrer">
        Open plan version
        <ArrowUpRight className="size-3.5" />
      </SuperLink>
    </Button>
  )
}

function EntitlementUsageRow({
  entitlement,
  usageUnavailable,
  timezone,
  action,
}: {
  entitlement: CurrentAccessEntitlement
  usageUnavailable: boolean
  timezone?: string
  action?: ReactNode
}) {
  const hasMeasuredUsage = entitlement.currentUsage !== null && !usageUnavailable
  const hasFiniteLimit = entitlement.limit !== null && entitlement.limit > 0
  const usagePeriodLabel =
    hasMeasuredUsage && entitlement.usagePeriods.length > 0
      ? formatUsagePeriods(entitlement.usagePeriods, timezone)
      : null

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] md:items-center">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate font-medium text-sm">{entitlement.featureTitle}</p>
          {action}
        </div>
        <p className="truncate text-muted-foreground text-xs">
          {formatFeatureContext(entitlement)}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="truncate text-muted-foreground">
            {usageUnavailable && entitlement.featureType === "usage"
              ? "Usage unavailable"
              : hasMeasuredUsage
                ? "Used this period"
                : "Allowance"}
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            {usageUnavailable && entitlement.featureType === "usage"
              ? "Retry later"
              : formatUsage(entitlement)}
          </span>
        </div>
        {hasMeasuredUsage && hasFiniteLimit && (
          <Progress
            value={entitlement.usagePercent ?? 0}
            className="h-1.5"
            max={100}
            aria-label={`${entitlement.featureTitle} usage`}
          />
        )}
        {usagePeriodLabel && (
          <p className="truncate text-muted-foreground text-xs">{usagePeriodLabel}</p>
        )}
      </div>
    </div>
  )
}

function PlanFact({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right font-medium", valueClassName)}>{value}</dd>
    </div>
  )
}

function formatFeatureContext(entitlement: CurrentAccessEntitlement): string {
  const pieces = [formatFeatureType(entitlement.featureType), entitlement.unitOfMeasure]

  if (entitlement.grantCount > 0) {
    pieces.push(`${entitlement.grantCount} grant${entitlement.grantCount === 1 ? "" : "s"}`)
  }

  return pieces.join(" / ")
}

function formatUsage(entitlement: CurrentAccessEntitlement): string {
  if (entitlement.currentUsage === null) {
    return entitlement.limit === null ? "Included" : nFormatter(entitlement.limit, { digits: 1 })
  }

  const current = nFormatter(entitlement.currentUsage, { digits: 1 })

  if (entitlement.limit === null) {
    return `${current} / unlimited`
  }

  return `${current} / ${nFormatter(entitlement.limit, { digits: 1 })}`
}

function formatFeatureType(type: CurrentAccessEntitlement["featureType"]): string {
  switch (type) {
    case "flat":
      return "Flat"
    case "tier":
      return "Tiered"
    case "package":
      return "Package"
    case "usage":
      return "Usage"
  }
}

function formatPeriod(
  start: number,
  end: number,
  options?: {
    billingConfig?: BillingConfig
    includeTime?: boolean
    timezone?: string
  }
): string {
  const includeTime = options?.includeTime ?? options?.billingConfig?.billingInterval === "minute"
  const timeZone = options?.timezone
  const startDate = new Date(start)
  const endDate = new Date(end)

  if (!includeTime) {
    return `${formatShortDate(startDate, timeZone)} - ${formatLongDate(endDate, timeZone)}`
  }

  return `${formatShortDateTime(startDate, timeZone)} - ${formatLongDateTime(endDate, timeZone)}`
}

function formatUsagePeriods(
  periods: CurrentAccessEntitlement["usagePeriods"],
  timezone?: string
): string | null {
  if (periods.length === 0) {
    return null
  }

  if (periods.length > 1) {
    return `${periods.length} active periods`
  }

  const period = periods[0]
  if (!period) {
    return null
  }

  if (period.end >= Number.MAX_SAFE_INTEGER) {
    return `Period since ${formatLongDate(new Date(period.start), timezone)}`
  }

  return `Period ${formatPeriod(period.start, period.end, {
    includeTime: period.end - period.start < 2 * 24 * 60 * 60 * 1000,
    timezone,
  })}`
}

function formatDate(timestamp: number): string {
  return LONG_DATE_FORMAT.format(new Date(timestamp))
}

function formatShortDate(date: Date, timeZone?: string): string {
  if (!timeZone) {
    return SHORT_DATE_FORMAT.format(date)
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone,
  }).format(date)
}

function formatLongDate(date: Date, timeZone?: string): string {
  if (!timeZone) {
    return LONG_DATE_FORMAT.format(date)
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(date)
}

function formatShortDateTime(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date)
}

function formatLongDateTime(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date)
}

function formatBillingCadence(config: BillingConfig): string {
  if (config.billingInterval === "onetime") {
    return "One-time"
  }

  if (config.billingIntervalCount === 1) {
    return `Every ${config.billingInterval}`
  }

  return `Every ${config.billingIntervalCount} ${config.billingInterval}s`
}

function formatPaymentProvider(provider: string): string {
  return provider
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
