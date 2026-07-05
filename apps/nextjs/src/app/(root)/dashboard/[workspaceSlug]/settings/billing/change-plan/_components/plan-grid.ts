import { cn } from "@unprice/ui/utils"

const MAX_PLAN_GRID_COLUMNS = 4

export function getPlanGridClassName(planCount: number): string {
  const columnCount = Math.min(Math.max(planCount, 1), MAX_PLAN_GRID_COLUMNS)

  return cn(
    "mx-auto grid w-full grid-cols-1 gap-5 md:gap-6",
    columnCount === 1 && "max-w-[28rem]",
    columnCount === 2 && "max-w-[58rem] md:grid-cols-2",
    columnCount === 3 && "max-w-[87rem] md:grid-cols-2 xl:grid-cols-3",
    columnCount >= 4 && "max-w-[117rem] md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
  )
}
