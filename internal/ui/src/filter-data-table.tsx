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
import { CalendarDays, Search, X } from "lucide-react"
import * as React from "react"
import type { DateRange } from "react-day-picker"
import { Badge } from "./badge"
import { Button } from "./button"
import { Calendar } from "./calendar"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
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

export interface FilterDataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  filters?: FilterDataTableFilter[]
  searchColumn?: string
  searchPlaceholder?: string
  emptyTitle?: string
  emptyDescription?: string
  getRowClassName?: (row: TData) => string | undefined
  toolbarActions?: React.ReactNode
  initialColumnVisibility?: VisibilityState
}

export function FilterDataTable<TData, TValue>({
  columns,
  data,
  filters = [],
  searchColumn,
  searchPlaceholder = "Search data table...",
  emptyTitle = "No results",
  emptyDescription = "There are no rows for the selected filters.",
  getRowClassName,
  toolbarActions,
  initialColumnVisibility,
}: FilterDataTableProps<TData, TValue>) {
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>(
    initialColumnVisibility ?? {}
  )
  const [rowSelection, setRowSelection] = React.useState({})

  const table = useReactTable({
    data,
    columns,
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
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  })

  const searchValue =
    searchColumn && table.getColumn(searchColumn)
      ? String(table.getColumn(searchColumn)?.getFilterValue() ?? "")
      : ""

  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="grid min-h-[520px] md:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-border border-b bg-muted/30 md:border-r md:border-b-0">
          <div className="flex h-14 items-center border-b px-4 font-medium text-sm">Filters</div>
          <div className="space-y-1 p-2 [&>*:last-child]:border-b-0">
            {filters.map((filter) =>
              filter.type === "checkbox" ? (
                <CheckboxFilter key={filter.id} table={table} filter={filter} />
              ) : (
                <DateFilter key={filter.id} filter={filter} />
              )
            )}
          </div>
        </aside>
        <section className="min-w-0">
          <div className="flex h-14 items-center gap-2 border-b px-2">
            {searchColumn && table.getColumn(searchColumn) ? (
              <div className="relative min-w-0 flex-1">
                <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
                <Input
                  value={searchValue}
                  onChange={(event) =>
                    table.getColumn(searchColumn)?.setFilterValue(event.target.value)
                  }
                  placeholder={searchPlaceholder}
                  className="h-10 pl-9"
                />
              </div>
            ) : null}
            {toolbarActions}
          </div>
          <div className="overflow-auto">
            <Table className="[&_td:first-child]:px-4 [&_th:first-child]:px-4">
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id} style={{ width: header.getSize() }}>
                        {header.isPlaceholder ? null : (
                          <button
                            type="button"
                            className={cn(
                              "flex w-full items-center gap-2 text-left font-medium",
                              header.column.getCanSort() && "cursor-pointer"
                            )}
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {header.column.getIsSorted() ? (
                              <span className="text-muted-foreground text-xs">
                                {header.column.getIsSorted() === "desc" ? "desc" : "asc"}
                              </span>
                            ) : null}
                          </button>
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.length > 0 ? (
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
                    <TableCell colSpan={columns.length} className="h-48 text-center">
                      <div className="space-y-1">
                        <p className="font-medium text-sm">{emptyTitle}</p>
                        <p className="text-muted-foreground text-sm">{emptyDescription}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
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

  return (
    <div className="border-b py-3">
      <div className="mb-2 px-2 font-medium text-sm">{filter.label}</div>
      <div className="space-y-1">
        {filter.options.map((option) => {
          const checked = selectedValues.has(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/60"
              onClick={() => {
                if (checked) {
                  selectedValues.delete(option.value)
                } else {
                  selectedValues.add(option.value)
                }
                const next = Array.from(selectedValues)
                column?.setFilterValue(next.length > 0 ? next : undefined)
              }}
            >
              <Checkbox checked={checked} aria-label={option.label} />
              <span className={cn("min-w-0 flex-1 truncate", option.className)}>
                {option.label}
              </span>
              {typeof option.count === "number" ? (
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
