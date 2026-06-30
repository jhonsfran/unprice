"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { cn } from "@unprice/ui/utils"
import { Activity, DollarSign, Users } from "lucide-react"
import StatsCards, { StatsSkeleton } from "~/components/analytics/stats-cards"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useTRPC } from "~/trpc/client"

export const iconsOverviewStats = {
  totalRevenue: DollarSign,
  newSignups: Users,
  newSubscriptions: Activity,
  newCustomers: Users,
}

export const OverviewStatsSkeleton = ({ isLoading }: { isLoading?: boolean }) => {
  const skeletonStats = [
    { title: "Recognized revenue" },
    { title: "New Signups" },
    { title: "New Subscriptions" },
    { title: "New Customers" },
  ]

  return (
    <div className="min-h-[150px]">
      <StatsSkeleton stats={skeletonStats} isLoading={isLoading} />
    </div>
  )
}

const OverviewStats = () => {
  const trpc = useTRPC()
  const [interval] = useIntervalFilter()
  const { data: stats, isFetching } = useSuspenseQuery(
    trpc.analytics.getOverviewStats.queryOptions(
      { interval: interval.name },
      {
        placeholderData: (previousData) => previousData,
        staleTime: interval.intervalDays === 1 ? 45 * 1000 : 5 * 60 * 1000,
        refetchInterval: interval.intervalDays === 1 ? 60 * 1000 : (false as const),
        refetchOnWindowFocus: false,
      }
    )
  )

  if (!stats.stats) {
    return <OverviewStatsSkeleton isLoading={false} />
  }

  const statsCards = Object.entries(stats.stats).map(([key, value]) => {
    return {
      total: value.total,
      unit: value.unit,
      icon: iconsOverviewStats[key as keyof typeof iconsOverviewStats],
      title: value.title,
      description: value.description,
    }
  })

  return (
    <div className="relative min-h-[150px]">
      <div
        suppressHydrationWarning
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/55 to-transparent transition-opacity duration-300",
          isFetching ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        suppressHydrationWarning
        className={cn(
          "transition-opacity duration-300 motion-reduce:transition-none",
          isFetching ? "opacity-90" : "opacity-100"
        )}
      >
        <div className="mb-3 flex flex-col gap-1">
          <p className="font-medium text-sm">Growth evidence</p>
          <p className="text-muted-foreground text-xs">
            Supporting business context. Operational health and spend evidence above are the primary
            dashboard state.
          </p>
        </div>
        <StatsCards stats={statsCards} />
      </div>
    </div>
  )
}

export default OverviewStats
