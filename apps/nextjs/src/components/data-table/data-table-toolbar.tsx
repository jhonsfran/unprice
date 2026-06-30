"use client"

import type { Table } from "@tanstack/react-table"

import { Button } from "@unprice/ui/button"
import { XCircle } from "@unprice/ui/icons"
import { Input } from "@unprice/ui/input"

import { DateRangePicker } from "../analytics/date-range-picker"
import type { FilterOptionDataTable } from "./data-table"
import { DataTableFacetedFilter } from "./data-table-faceted-filter"
import { DataTableViewOptions } from "./data-table-view-options"

interface DataTableToolbarProps<TData> {
  table: Table<TData>
  filterOptions?: FilterOptionDataTable
}

export function DataTableToolbar<TData>({ table, filterOptions }: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0
  const filterBy = filterOptions?.filterBy ?? ""

  const filterBySelectors = filterOptions?.filterSelectors ?? {}
  const filterSelectors = Object.keys(filterBySelectors).map((key) => {
    const filter = table.getColumn(key)
    const options = filterBySelectors[key] ?? []

    // get all possible values from the column key so I don't need to pass the options manually
    const allValues = table.getFilteredRowModel().rows.map((row) => {
      const value = row.original as Record<string, string>
      const label = value[key] ?? ""

      if (label === "") return null
      return {
        label,
        value: label,
      }
    })

    // delete duplicates with the key value in the object [{label: "value", value: "value"}]
    const allOptions = options
      .concat(allValues.filter((value) => value !== null))
      .filter(
        (value, index, self) =>
          index === self.findIndex((t) => t.value === value.value && t.label === value.label)
      )

    if (filter && options.length > 0) {
      return (
        <DataTableFacetedFilter
          key={key}
          column={filter}
          title={key.charAt(0).toUpperCase() + key.slice(1)}
          options={allOptions}
        />
      )
    }

    return null
  })

  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        {table.getColumn(filterBy) && (
          <Input
            placeholder={`Filter by ${filterBy}`}
            value={(table.getColumn(filterBy)?.getFilterValue() as string) ?? ""}
            onChange={(event) => {
              table.getColumn(filterBy)?.setFilterValue(event.target.value)
            }}
            className="h-8 w-full bg-background sm:w-[220px] lg:w-[250px]"
          />
        )}
        {filterSelectors}
        {isFiltered && (
          <Button
            variant="ghost"
            size={"sm"}
            onClick={() => table.resetColumnFilters()}
            className="h-8 px-2 lg:px-3"
          >
            Reset
            <XCircle className="ml-2 size-4" />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {filterOptions?.filterDateRange && (
          <DateRangePicker triggerSize="sm" triggerClassName="w-full sm:w-60" align="end" />
        )}
        {filterOptions?.filterColumns && <DataTableViewOptions table={table} />}
      </div>
    </div>
  )
}
