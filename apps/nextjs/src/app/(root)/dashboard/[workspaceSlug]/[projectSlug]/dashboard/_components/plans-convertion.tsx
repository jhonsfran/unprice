"use client"

import { useSuspenseQuery } from "@tanstack/react-query"
import { Typography } from "@unprice/ui/typography"
import { DataTable } from "~/components/data-table/data-table"
import { DataTableSkeleton } from "~/components/data-table/data-table-skeleton"
import { useIntervalFilter } from "~/hooks/use-filter"
import { useQueryInvalidation } from "~/hooks/use-query-invalidation"
import { useTRPC } from "~/trpc/client"
import { WEB_ANALYTICS_QUERY_CONFIG } from "~/trpc/shared"
import { columns } from "./plans/columns"

export function PlansConversionSkeleton() {
  const [intervalFilter] = useIntervalFilter()
  return (
    <div className="mt-4">
      <div className="flex flex-col px-1 py-4">
        <Typography variant="h3" affects="removePaddingMargin">
          Plans conversion
        </Typography>
        <Typography variant="p" affects="removePaddingMargin">
          Plans conversion for the {intervalFilter.label}
        </Typography>
      </div>
      <DataTableSkeleton
        columnCount={7}
        showDateFilterOptions={false}
        showViewOptions={true}
        searchableColumnCount={1}
        cellWidths={["10rem", "10rem", "10rem", "10rem", "10rem", "10rem", "12rem"]}
      />
    </div>
  )
}

export function PlansConversion() {
  const trpc = useTRPC()
  const [intervalFilter] = useIntervalFilter()

  const {
    data: plansConversion,
    isLoading,
    dataUpdatedAt,
    isFetching,
  } = useSuspenseQuery(
    trpc.analytics.getPlansConversion.queryOptions(
      {
        interval_days: intervalFilter.intervalDays,
      },
      {
        ...WEB_ANALYTICS_QUERY_CONFIG,
      }
    )
  )

  // invalidate the query when the interval changes
  useQueryInvalidation({
    paramKey: intervalFilter.intervalDays,
    dataUpdatedAt,
    isFetching,
    getQueryKey: (intervalDays) => [
      ["analytics", "getPlansConversion"],
      {
        input: {
          interval_days: intervalDays,
        },
        type: "query",
      },
    ],
  })

  if (isLoading) {
    return <PlansConversionSkeleton />
  }

  return (
    <div className="mt-4">
      <div className="flex flex-col px-1 py-4">
        <Typography variant="h3" affects="removePaddingMargin">
          Plans conversion
        </Typography>
        <Typography variant="p" affects="removePaddingMargin">
          Plans conversion for the {intervalFilter.label}
        </Typography>
      </div>
      <DataTable
        columns={columns}
        data={plansConversion.data}
        error={plansConversion.error}
        filterOptions={{
          filterBy: "plan_version_id",
          filterColumns: true,
          filterDateRange: false,
          filterServerSide: false,
        }}
      />
    </div>
  )
}
