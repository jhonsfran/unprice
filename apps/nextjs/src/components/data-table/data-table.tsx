"use client"

import type { ColumnDef, VisibilityState } from "@tanstack/react-table"
import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import * as React from "react"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { cn } from "@unprice/ui/utils"

import { AlertTriangle } from "lucide-react"
import { useDataTableUrlState } from "~/hooks/use-data-table-url-state"
import { EmptyPlaceholder } from "../empty-placeholder"
import { DataTablePagination } from "./data-table-pagination"
import { DataTableToolbar } from "./data-table-toolbar"

export interface FilterOptionDataTable {
  filterBy?: string
  filterDateRange?: boolean
  filterColumns?: boolean
  filterServerSide?: boolean
  // when you define filterSelectors, you need filterfn in the column definition
  filterSelectors?: Record<
    string,
    {
      label: string
      value: string | number
      icon?: React.ComponentType<{ className?: string }>
    }[]
  >
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[]
  data: TData[]
  filterOptions?: FilterOptionDataTable
  className?: string
  pageCount?: number
  error?: string
}

export function DataTable<TData, TValue>({
  columns,
  data,
  filterOptions,
  className,
  pageCount,
  error,
}: DataTableProps<TData, TValue>) {
  const [rowSelection, setRowSelection] = React.useState({})
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})

  // if pageCount is provided, we assume server-side pagination
  // otherwise, we assume client-side pagination done by the library
  const isServerSidePagination = !!pageCount
  const isServerSideFiltering = filterOptions?.filterServerSide === true

  const {
    pagination,
    sorting,
    columnFilters,
    onPaginationChange,
    onSortingChange,
    onColumnFiltersChange,
  } = useDataTableUrlState({
    searchColumnId: filterOptions?.filterBy,
    serverSide: isServerSidePagination || isServerSideFiltering,
  })

  const table = useReactTable({
    data,
    columns,
    ...(isServerSidePagination && { pageCount }),
    state: {
      sorting,
      pagination,
      columnVisibility,
      rowSelection,
      columnFilters,
      columnPinning: { right: ["actions"] },
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange,
    onColumnFiltersChange,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    ...(isServerSideFiltering
      ? { manualFiltering: true }
      : { getFilteredRowModel: getFilteredRowModel() }),
    ...(isServerSidePagination && {
      manualPagination: true,
    }),
  })

  return (
    <div className={cn("w-full space-y-4 overflow-auto", className)}>
      <DataTableToolbar table={table} filterOptions={filterOptions} />
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const isPinned = header.column.getIsPinned()

                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      style={{
                        minWidth: header.getSize() ? header.getSize() : 0,
                      }}
                      className={cn("relative", {
                        "sticky z-10 bg-background-bgSubtle": isPinned,
                        "-left-1 border-r": isPinned === "left",
                        "-right-1 border-l": isPinned === "right",
                      })}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => {
                    const isPinned = cell.column.getIsPinned()

                    return (
                      <TableCell
                        key={cell.id}
                        className={cn("relative", {
                          "sticky z-10 bg-background-bgSubtle": isPinned,
                          "-left-1 border-r": isPinned === "left",
                          "-right-1 border-l": isPinned === "right",
                        })}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={table.getAllColumns().length} className="h-24 p-4 text-center">
                  <EmptyPlaceholder className="min-h-[300px]">
                    <EmptyPlaceholder.Icon>
                      <AlertTriangle className="h-8 w-8" />
                    </EmptyPlaceholder.Icon>
                    <EmptyPlaceholder.Title>
                      {error ? "Ups, something went wrong" : "No Results"}
                    </EmptyPlaceholder.Title>
                    <EmptyPlaceholder.Description>
                      {error ? error : "There are no results for the selected filters."}
                    </EmptyPlaceholder.Description>
                  </EmptyPlaceholder>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} />
    </div>
  )
}
