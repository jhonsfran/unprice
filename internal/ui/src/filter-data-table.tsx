"use client"

import type {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  Table as TanStackTable,
  VisibilityState,
} from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { CalendarDays, Check, Loader2, Search, X } from "lucide-react"
import * as React from "react"
import type { DateRange } from "react-day-picker"
import { Badge } from "./badge"
import { Button } from "./button"
import { Calendar } from "./calendar"
import { Input } from "./input"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { ScrollArea } from "./scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table"
import { cn } from "./utils"

export type FilterDataTableOption = {
  label: string
  value: string
  count?: number
  className?: string
}

export type FilterDataTableFilter =
  | {
      type: "checkbox"
      id: string
      label: string
      options: FilterDataTableOption[]
      defaultOpen?: boolean
      showCounts?: boolean
      hideEmptyOptions?: boolean
      emptyOptionsLabel?: string
    }
  | {
      type: "date"
      id: string
      label: string
      value?: DateRange
      onChange?: (range: DateRange | undefined) => void
      defaultOpen?: boolean
      /** Earliest selectable date */
      fromDate?: Date
      /** Latest selectable date (defaults to today to block future) */
      toDate?: Date
      /** Number of months to display */
      numberOfMonths?: number
    }

export type FilterDataTableToolbarActions<TData> =
  | React.ReactNode
  | ((params: { clearSelection: () => void; selectedRows: TData[] }) => React.ReactNode)

export interface FilterDataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  filters?: FilterDataTableFilter[]
  searchColumn?: string
  searchPlaceholder?: string
  searchValue?: string
  onSearchValueChange?: (value: string) => void
  emptyTitle?: string
  emptyDescription?: string
  emptyState?: React.ReactNode
  loadingState?: React.ReactNode
  getRowId?: (row: TData, index: number) => string
  getRowClassName?: (row: TData) => string | undefined
  toolbarActions?: FilterDataTableToolbarActions<TData>
  initialColumnVisibility?: VisibilityState
  initialColumnFilters?: ColumnFiltersState
  hasMore?: boolean
  isLoading?: boolean
  isRefreshing?: boolean
  isLoadingMore?: boolean
  loadingLabel?: string
  onLoadMore?: () => void | Promise<void>
}

export function FilterDataTable<TData, TValue>({
  columns,
  data,
  filters = [],
  searchColumn,
  searchPlaceholder = "Search data table...",
  searchValue: controlledSearchValue,
  onSearchValueChange,
  emptyTitle = "No results",
  emptyDescription = "There are no rows for the selected filters.",
  emptyState,
  loadingState,
  getRowId,
  getRowClassName,
  toolbarActions,
  initialColumnVisibility,
  initialColumnFilters,
  hasMore = false,
  isLoading = false,
  isRefreshing = false,
  isLoadingMore = false,
  loadingLabel = "Loading rows",
  onLoadMore,
}: FilterDataTableProps<TData, TValue>) {
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    initialColumnFilters ?? []
  )
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(
    initialColumnVisibility ?? {}
  )
  const [rowSelection, setRowSelection] = React.useState({})

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      columnFilters,
      sorting,
      columnVisibility,
      rowSelection,
    },
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  const localSearchValue =
    searchColumn && table.getColumn(searchColumn)
      ? String(table.getColumn(searchColumn)?.getFilterValue() ?? "")
      : ""
  const searchValue = controlledSearchValue ?? localSearchValue
  const loadMoreRef = React.useRef<HTMLDivElement | null>(null)
  const loadMoreRequestedRef = React.useRef(false)
  const canLoadMore = Boolean(hasMore && onLoadMore)
  const selectedRows = table.getFilteredSelectedRowModel().rows.map((row) => row.original)
  const computedToolbarActions =
    typeof toolbarActions === "function"
      ? toolbarActions({
          clearSelection: () => table.resetRowSelection(),
          selectedRows,
        })
      : toolbarActions

  React.useEffect(() => {
    const target = loadMoreRef.current
    if (!target || !canLoadMore || isLoadingMore) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry?.isIntersecting || loadMoreRequestedRef.current) {
          return
        }

        loadMoreRequestedRef.current = true
        void Promise.resolve(onLoadMore?.()).finally(() => {
          loadMoreRequestedRef.current = false
        })
      },
      {
        rootMargin: "240px",
      }
    )

    observer.observe(target)
    return () => observer.disconnect()
  }, [canLoadMore, isLoadingMore, onLoadMore])

  return (
    <div className="relative overflow-hidden rounded-md border bg-background">
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-primary/55 to-transparent transition-opacity duration-300",
          isRefreshing ? "opacity-100" : "opacity-0"
        )}
      />
      <div
        className={cn(
          "grid min-h-[520px] transition-opacity duration-300 motion-reduce:transition-none md:grid-cols-[260px_minmax(0,1fr)]",
          isRefreshing ? "opacity-90" : "opacity-100"
        )}
      >
        <aside className="border-border border-b bg-muted/30 md:border-r md:border-b-0">
          <div className="flex h-14 items-center border-b px-4 font-medium text-sm">Filters</div>
          <ScrollArea className="h-[calc(80vh-3.5rem)]">
            <div className="space-y-1 p-2 [&>*:last-child]:border-b-0">
              {filters.map((filter) =>
                filter.type === "checkbox" ? (
                  <CheckboxFilter key={filter.id} table={table} filter={filter} />
                ) : (
                  <DateFilter key={filter.id} filter={filter} />
                )
              )}
            </div>
          </ScrollArea>
        </aside>
        <section className="min-w-0">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-2">
            {searchColumn && table.getColumn(searchColumn) ? (
              <div className="relative min-w-0 flex-1">
                <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
                <Input
                  value={searchValue}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    table.getColumn(searchColumn)?.setFilterValue(nextValue)
                    onSearchValueChange?.(nextValue)
                  }}
                  placeholder={searchPlaceholder}
                  className="h-10 pl-9"
                />
              </div>
            ) : null}
            {computedToolbarActions}
          </div>
          <ScrollArea className="h-[calc(80vh-3.5rem)]">
            <Table className="[&_td:first-child]:px-4 [&_th:first-child]:px-4">
              <TableHeader className="sticky top-0 z-10 bg-background">
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const headerContent = header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())
                      const sorted = header.column.getIsSorted()

                      return (
                        <TableHead key={header.id} style={{ width: header.getSize() }}>
                          {headerContent && header.column.getCanSort() ? (
                            <button
                              type="button"
                              className="flex w-full cursor-pointer items-center gap-2 text-left font-medium"
                              onClick={header.column.getToggleSortingHandler()}
                            >
                              {headerContent}
                              {sorted ? (
                                <span className="text-muted-foreground text-xs">
                                  {sorted === "desc" ? "desc" : "asc"}
                                </span>
                              ) : null}
                            </button>
                          ) : (
                            <div className="flex w-full items-center gap-2 text-left font-medium">
                              {headerContent}
                            </div>
                          )}
                        </TableHead>
                      )
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-48 p-4 text-center">
                      {loadingState ?? (
                        <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                          <Loader2 className="size-4 animate-spin" />
                          <span>{loadingLabel}</span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ) : table.getRowModel().rows.length > 0 ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                      className={getRowClassName?.(row.original)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-48 p-4 text-center">
                      {emptyState ?? (
                        <div className="space-y-1">
                          <p className="font-medium text-sm">{emptyTitle}</p>
                          <p className="text-muted-foreground text-sm">{emptyDescription}</p>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {canLoadMore ? (
              <div
                ref={loadMoreRef}
                className="flex items-center justify-center border-t bg-background/80 px-4 py-3"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-2 text-muted-foreground text-xs"
                  disabled={isLoadingMore}
                  onClick={() => {
                    if (loadMoreRequestedRef.current) {
                      return
                    }

                    loadMoreRequestedRef.current = true
                    void Promise.resolve(onLoadMore?.()).finally(() => {
                      loadMoreRequestedRef.current = false
                    })
                  }}
                >
                  {isLoadingMore ? <Loader2 className="size-3 animate-spin" /> : null}
                  {isLoadingMore ? "Loading more" : "Load more"}
                </Button>
              </div>
            ) : null}
          </ScrollArea>
        </section>
      </div>
    </div>
  )
}

function CheckboxFilter<TData>({
  table,
  filter,
}: {
  table: TanStackTable<TData>
  filter: Extract<FilterDataTableFilter, { type: "checkbox" }>
}) {
  const column = table.getColumn(filter.id)
  const selectedValues = new Set((column?.getFilterValue() as string[] | undefined) ?? [])
  const facetedUniqueValues = column?.getFacetedUniqueValues()
  const options = filter.options
    .map((option) => {
      const facetedCount = facetedUniqueValues?.get(option.value) ?? 0
      const count = typeof option.count === "number" ? option.count : facetedCount
      const checked = selectedValues.has(option.value)
      const hidden = filter.hideEmptyOptions && !checked && facetedUniqueValues && count === 0

      return {
        ...option,
        checked,
        count,
        hidden,
        showsCount: filter.showCounts || typeof option.count === "number",
      }
    })
    .filter((option) => !option.hidden)

  return (
    <div className="border-b py-3">
      <div className="mb-2 px-2 font-medium text-sm">{filter.label}</div>
      <div className="space-y-1">
        {options.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-sm">
            {filter.emptyOptionsLabel ?? "No options"}
          </p>
        ) : null}
        {options.map((option) => {
          return (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/60"
              onClick={() => {
                if (option.checked) {
                  selectedValues.delete(option.value)
                } else {
                  selectedValues.add(option.value)
                }
                const next = Array.from(selectedValues)
                column?.setFilterValue(next.length > 0 ? next : undefined)
              }}
            >
              <FilterCheckboxMark checked={option.checked} />
              <span className={cn("min-w-0 flex-1 truncate", option.className)}>
                {option.label}
              </span>
              {option.showsCount ? (
                <Badge variant="secondary" className="font-mono text-xs">
                  {option.count}
                </Badge>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FilterCheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-state={checked ? "checked" : "unchecked"}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary text-primary-foreground data-[state=checked]:bg-primary"
    >
      {checked ? <Check className="h-4 w-4" /> : null}
    </span>
  )
}

function DateFilter({ filter }: { filter: Extract<FilterDataTableFilter, { type: "date" }> }) {
  return (
    <div className="border-b py-3">
      <div className="mb-2 px-2 font-medium text-sm">{filter.label}</div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="mx-2 w-[calc(100%-1rem)] justify-start">
            <CalendarDays className="mr-2 size-4" />
            {formatDateRange(filter.value)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={filter.value}
            onSelect={filter.onChange}
            numberOfMonths={filter.numberOfMonths ?? 2}
            fromDate={filter.fromDate}
            toDate={filter.toDate}
            disabled={filter.toDate ? { after: filter.toDate } : undefined}
          />
        </PopoverContent>
      </Popover>
      {filter.value?.from || filter.value?.to ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-2 mt-2 h-7 px-2"
          onClick={() => filter.onChange?.(undefined)}
        >
          <X className="mr-1 size-3" />
          Clear
        </Button>
      ) : null}
    </div>
  )
}

function formatDateRange(range?: DateRange): string {
  if (!range?.from) {
    return "Pick a date"
  }

  const from = range.from.toLocaleDateString()
  if (!range.to) {
    return from
  }

  return `${from} - ${range.to.toLocaleDateString()}`
}
