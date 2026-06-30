import { nFormatter } from "@unprice/db/utils"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Progress } from "@unprice/ui/progress"
import { CalendarRange, KeyRound } from "lucide-react"
import { SuperLink } from "~/components/super-link"
import { formatWalletMoney } from "../../_components/wallet/format-wallet-money"

type CustomerCurrentAccessData = RouterOutputs["customers"]["getCurrentAccess"]
type CurrentAccessEntitlement = CustomerCurrentAccessData["entitlements"][number]
type WalletData = RouterOutputs["customers"]["getWallet"]["wallet"]

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
}: {
  access: CustomerCurrentAccessData
  wallet: WalletData
  subscriptionsHref: string
}) {
  const visibleEntitlements = access.entitlements.slice(0, 5)
  const hiddenEntitlementCount = Math.max(
    0,
    access.entitlements.length - visibleEntitlements.length
  )
  const activePlan = access.activePlan
  const walletAvailable = wallet.balances.purchased + wallet.balances.granted
  const walletHeld = wallet.balances.reserved

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="font-semibold text-lg leading-none">Current plan + access</h2>
          <p className="text-muted-foreground text-sm">
            Active subscription context and entitlement usage for the current entitlement period.
          </p>
        </div>
        <SuperLink
          href={subscriptionsHref}
          className="text-muted-foreground text-sm transition-colors hover:text-foreground"
        >
          Manage subscription
        </SuperLink>
      </div>
      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.6fr]">
        <div className="flex flex-col gap-4 rounded-md border border-border/60 bg-card/70 p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <CalendarRange className="size-4" />
            Billing period
          </div>
          {activePlan ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <p className="truncate font-semibold text-lg">{activePlan.planSlug}</p>
                <p className="text-muted-foreground text-sm">
                  {formatPeriod(activePlan.currentCycleStartAt, activePlan.currentCycleEndAt)}
                </p>
              </div>
              <dl className="grid gap-3 text-sm">
                <PlanFact label="Status" value={formatStatus(activePlan.status)} />
                <PlanFact
                  label="Renews"
                  value={formatDate(activePlan.renewAt ?? activePlan.currentCycleEndAt)}
                />
                <PlanFact
                  label="Active subscriptions"
                  value={String(access.activeSubscriptionCount)}
                />
                <PlanFact label="Active entitlements" value={String(access.entitlementCount)} />
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
                  label="Active subscriptions"
                  value={String(access.activeSubscriptionCount)}
                />
                <PlanFact label="Active entitlements" value={String(access.entitlementCount)} />
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

        <div className="overflow-hidden rounded-md border border-border/60">
          <div className="flex items-center justify-between gap-3 border-border/60 border-b bg-card/70 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" />
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

          {visibleEntitlements.length > 0 ? (
            <div className="divide-y divide-border/60">
              {visibleEntitlements.map((entitlement) => (
                <EntitlementUsageRow
                  key={entitlement.id}
                  entitlement={entitlement}
                  usageUnavailable={access.usageUnavailable}
                />
              ))}
              {hiddenEntitlementCount > 0 && (
                <div className="px-4 py-3 text-muted-foreground text-sm">
                  +{hiddenEntitlementCount} more active entitlements
                </div>
              )}
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
}: {
  entitlement: CurrentAccessEntitlement
  usageUnavailable: boolean
}) {
  const hasMeasuredUsage = entitlement.currentUsage !== null && !usageUnavailable
  const hasFiniteLimit = entitlement.limit !== null && entitlement.limit > 0

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] md:items-center">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="truncate font-medium text-sm">{entitlement.featureTitle}</p>
          <p className="shrink-0 text-muted-foreground text-xs">{entitlement.featureSlug}</p>
        </div>
        <p className="mt-1 truncate text-muted-foreground text-xs">
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

function PlanFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
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

function formatPeriod(start: number, end: number): string {
  return `${SHORT_DATE_FORMAT.format(new Date(start))} - ${LONG_DATE_FORMAT.format(new Date(end))}`
}

function formatDate(timestamp: number): string {
  return LONG_DATE_FORMAT.format(new Date(timestamp))
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
