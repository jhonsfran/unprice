"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Skeleton } from "@unprice/ui/skeleton"
import { Activity, DollarSign, Users } from "lucide-react"
import {
  EvidenceMetricStrip,
  EvidenceMetricTile,
  EvidenceSection,
} from "~/components/analytics/evidence-panel"
import { NumberTicker } from "~/components/analytics/number-ticker"
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
    <EvidenceSection
      title="Growth evidence"
      description="Supporting business context."
      className="min-h-[132px]"
      contentClassName="mt-3"
    >
      <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
        {skeletonStats.map((stat) => (
          <EvidenceMetricTile
            key={stat.title}
            label={stat.title}
            value={isLoading ? <Skeleton className="h-6 w-20" /> : "0"}
            helper={<Skeleton className="h-3 w-28" />}
            icon={<Skeleton className="size-4 shrink-0" />}
          />
        ))}
      </EvidenceMetricStrip>
    </EvidenceSection>
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
    <EvidenceSection
      title="Growth evidence"
      description="Supporting business context."
      isRefreshing={isFetching}
      className="min-h-[150px]"
      contentClassName="mt-3"
    >
      <EvidenceMetricStrip className="sm:grid-cols-2 lg:grid-cols-4">
        {statsCards.map((stat) => {
          const hasDecimalPlaces = stat.total % 1 !== 0

          return (
            <EvidenceMetricTile
              key={stat.title}
              label={stat.title}
              value={
                <div className="flex items-baseline gap-1.5">
                  <NumberTicker
                    value={stat.total}
                    decimalPlaces={hasDecimalPlaces ? 2 : 0}
                    startValue={0}
                  />
                  {stat.unit && <span>{stat.unit}</span>}
                </div>
              }
              helper={stat.description}
              icon={<stat.icon className="mt-0.5 size-4 shrink-0" />}
            />
          )
        })}
      </EvidenceMetricStrip>
    </EvidenceSection>
  )
}

export default OverviewStats
