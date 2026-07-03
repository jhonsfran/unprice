import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import { Progress } from "@unprice/ui/progress"
import { ArrowUpRight, CalendarRange, KeyRound } from "lucide-react"
import { SectionIntro } from "~/components/layout/section-intro"
import { SuperLink } from "~/components/super-link"
import { formatWalletMoney } from "../../_components/wallet/format-wallet-money"
import { EntitlementConfigSheet } from "./entitlement-config-sheet"

type CustomerCurrentAccessData = RouterOutputs["customers"]["getCurrentAccess"]
type CurrentAccessEntitlement = CustomerCurrentAccessData["entitlements"][number]
type WalletData = RouterOutputs["customers"]["getWallet"]["wallet"]
type BillingConfig = NonNullable<
  NonNullable<CustomerCurrentAccessData["activePlan"]>["activePhase"]
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

export function CustomerCurrentAccess({
  access,
  wallet,
  subscriptionsHref,
  plansHref,
}: {
  access: CustomerCurrentAccessData
  wallet: WalletData
  subscriptionsHref: string
  plansHref: string
}) {
  const activePlan = access.activePlan
  const activePhase = activePlan?.activePhase ?? null
  const walletAvailable = wallet.balances.purchased + wallet.balances.granted
  const walletHeld = wallet.balances.reserved
  const planVersionHref =
    activePlan && activePhase
      ? `${plansHref}/${encodeURIComponent(activePlan.planSlug)}/${encodeURIComponent(
          activePhase.planVersion.id
        )}`
      : null

  return (
    <section className="flex flex-col gap-4">
      <SectionIntro
        title="Current plan + access"
        description="Active subscription context and entitlement usage for the current entitlement period."
        className="px-0 py-0"
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
            <Button asChild variant="ghost" size="sm" className="shrink-0">
              <SuperLink href={subscriptionsHref}>Manage</SuperLink>
            </Button>
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
                  {planVersionHref && (
                    <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
                      <SuperLink href={planVersionHref} target="_blank" rel="noreferrer">
                        Open plan version
                        <ArrowUpRight className="size-3.5" />
                      </SuperLink>
                    </Button>
                  )}
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
                <p className="text-muted-foreground text-sm">
                  This customer has no active subscription billing period.
                </p>
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
                    planVersionId={activePhase?.planVersion.id ?? null}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[168px] flex-col items-center justify-center gap-1 px-4 py-8 text-center">
              <p className="font-medium text-sm">No active entitlements</p>
              <p className="max-w-md text-muted-foreground text-sm">
                Access grants will appear here once the customer has an active subscription phase.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function EntitlementUsageRow({
  entitlement,
  usageUnavailable,
  planVersionId,
}: {
  entitlement: CurrentAccessEntitlement
  usageUnavailable: boolean
  planVersionId: string | null
}) {
  const hasMeasuredUsage = entitlement.currentUsage !== null && !usageUnavailable
  const hasFiniteLimit = entitlement.limit !== null && entitlement.limit > 0

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] md:items-center">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <p className="min-w-0 truncate font-medium text-sm">{entitlement.featureTitle}</p>
          <EntitlementConfigSheet entitlement={entitlement} planVersionId={planVersionId} />
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
      <dd
        className={["min-w-0 truncate text-right font-medium", valueClassName]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
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
    timezone?: string
  }
): string {
  const includeTime = options?.billingConfig?.billingInterval === "minute"
  const timeZone = options?.timezone
  const startDate = new Date(start)
  const endDate = new Date(end)

  if (!includeTime) {
    return `${formatShortDate(startDate, timeZone)} - ${formatLongDate(endDate, timeZone)}`
  }

  return `${formatShortDateTime(startDate, timeZone)} - ${formatLongDateTime(endDate, timeZone)}`
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

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
