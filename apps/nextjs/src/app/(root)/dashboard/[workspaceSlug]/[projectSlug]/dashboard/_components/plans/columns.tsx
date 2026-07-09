"use client"

import type { ColumnDef } from "@tanstack/react-table"

import type { analytics } from "@unprice/analytics/client"
import { Badge } from "@unprice/ui/badge"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@unprice/ui/drawer"

import { useQuery } from "@tanstack/react-query"
import { Button } from "@unprice/ui/button"
import { ScrollArea } from "@unprice/ui/scroll-area"
import { cn } from "@unprice/ui/utils"
import { BarChart3, Eye, Loader2, MousePointerClick, UserCheck2 } from "lucide-react"
import { DataTableColumnHeader } from "~/components/data-table/data-table-column-header"
import { useMediaQuery } from "~/hooks/use-media-query"
import { useTRPC } from "~/trpc/client"
import { PageForm } from "../../../pages/_components/page-form"
import { PlanVersionForm } from "../../../plans/[planSlug]/_components/plan-version-form"

type PlanConversion = Awaited<ReturnType<typeof analytics.getPlansConversion>>["data"][number]

export const columns: ColumnDef<PlanConversion>[] = [
  {
    accessorKey: "page_id",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Page" />,
    cell: ({ row }) => <TableCellPage pageId={row.original.page_id} />,
    enableSorting: true,
    enableHiding: false,
    enableResizing: true,
  },
  {
    accessorKey: "plan_version_id",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Plan Version" />,
    cell: ({ row }) => <TableCellPlanVersion planVersionId={row.original.plan_version_id} />,
    filterFn: (row, _id, value) => {
      if (value === undefined) return true
      // filter by page id and plan version id
      return (
        row.original.page_id.toLowerCase().includes(value.toLowerCase()) ||
        row.original.plan_version_id.toLowerCase().includes(value.toLowerCase())
      )
    },
    size: 20,
  },
  {
    accessorKey: "plan_views",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Views" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-2 whitespace-nowrap font-mono text-xs tabular-nums">
        <Eye className="h-4 w-4 text-info" />
        {row.original.plan_views}
      </div>
    ),
    size: 20,
  },
  {
    accessorKey: "plan_clicks",
    enableResizing: true,
    header: ({ column }) => <DataTableColumnHeader column={column} title="Clicks" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-2 whitespace-nowrap font-mono text-xs tabular-nums">
        <MousePointerClick className="h-4 w-4 text-info" />
        {row.original.plan_clicks}
      </div>
    ),
    size: 20,
  },
  {
    accessorKey: "plan_signups",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Signups" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-2 whitespace-nowrap font-mono text-xs tabular-nums">
        <UserCheck2 className="h-4 w-4 text-info" />
        {row.original.plan_signups}
      </div>
    ),
    enableSorting: true,
    enableHiding: true,
    size: 20,
  },
  {
    accessorKey: "conversion",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Conversion" />,
    cell: ({ row }) => (
      <Badge
        variant={
          row.original.conversion > 5 ? "success" : row.original.conversion > 1 ? "info" : "outline"
        }
        className={cn("flex w-fit items-center gap-2 px-1.5 text-muted-foreground", {
          "text-info": row.original.conversion > 1 && row.original.conversion < 5,
          "text-success": row.original.conversion > 5,
        })}
      >
        <BarChart3 className={"h-4 w-4"} />
        <div className="whitespace-nowrap text-sm">{row.original.conversion.toFixed(1)}%</div>
      </Badge>
    ),
    size: 20,
  },
]

function TableCellPage({ pageId }: { pageId: string }) {
  const { isMobile } = useMediaQuery()
  const trpc = useTRPC()
  const { data: page, isLoading } = useQuery(
    trpc.pages.getById.queryOptions({
      id: pageId,
    })
  )

  return (
    <Drawer direction={isMobile ? "bottom" : "right"}>
      <DrawerTrigger asChild>
        <Button variant="link" className="w-fit px-0 text-left font-mono text-foreground text-xs">
          {pageId}
        </Button>
      </DrawerTrigger>
      <DrawerContent className="h-screen w-full data-[vaul-drawer-direction=right]:sm:max-w-2xl">
        <DrawerHeader className="gap-1 px-4">
          <DrawerTitle>{page?.page?.title}</DrawerTitle>
          <DrawerDescription>{page?.page?.description}</DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="h-[800px] px-4 py-4 md:px-6">
          {isLoading || !page?.page ? (
            <div className="flex items-center justify-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : (
            <PageForm defaultValues={page.page} />
          )}
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  )
}

function TableCellPlanVersion({ planVersionId }: { planVersionId: string }) {
  const { isMobile } = useMediaQuery()
  const trpc = useTRPC()
  const { data: planVersion, isLoading } = useQuery(
    trpc.planVersions.getById.queryOptions({
      id: planVersionId,
    })
  )

  return (
    <Drawer direction={isMobile ? "bottom" : "right"}>
      <DrawerTrigger asChild>
        <Button variant="link" className="w-fit px-0 text-left font-mono text-foreground text-xs">
          {planVersionId}
        </Button>
      </DrawerTrigger>
      <DrawerContent className="h-screen w-full data-[vaul-drawer-direction=right]:sm:max-w-2xl">
        <DrawerHeader className="gap-1 px-4">
          <DrawerTitle>
            {planVersion?.planVersion.title} - V{planVersion?.planVersion.version}
          </DrawerTitle>
          <DrawerDescription>{planVersion?.planVersion.description}</DrawerDescription>
        </DrawerHeader>
        <ScrollArea className="h-[800px] px-4 py-4 md:px-6">
          {isLoading || !planVersion ? (
            <div className="flex items-center justify-center">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : (
            <PlanVersionForm defaultValues={planVersion.planVersion} />
          )}
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  )
}
