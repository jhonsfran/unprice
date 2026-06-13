"use client"

import type {
  ColumnFiltersState,
  OnChangeFn,
  PaginationState,
  SortingState,
} from "@tanstack/react-table"
import * as React from "react"

import { useFilterDataTable } from "~/hooks/use-filter-datatable"
import type { DataTableFilterParams, DataTableFilterValue } from "~/lib/searchParams"

interface UseDataTableUrlStateOptions {
  searchColumnId?: string
  serverSide?: boolean
}

function resolveUpdater<T>(updaterOrValue: T | ((old: T) => T), old: T): T {
  if (typeof updaterOrValue === "function") {
    return (updaterOrValue as (old: T) => T)(old)
  }

  return updaterOrValue
}

function parseSorting(sort: string | null): SortingState {
  if (!sort) {
    return []
  }

  if (sort.endsWith(".desc")) {
    const id = sort.slice(0, -".desc".length)

    return id ? [{ id, desc: true }] : []
  }

  if (sort.endsWith(".asc")) {
    const id = sort.slice(0, -".asc".length)

    return id ? [{ id, desc: false }] : []
  }

  return []
}

function serializeSorting(sorting: SortingState): string | null {
  const [column] = sorting

  if (!column?.id) {
    return null
  }

  return `${column.id}.${column.desc ? "desc" : "asc"}`
}

function normalizeFilterValue(value: unknown): DataTableFilterValue[] {
  const values = Array.isArray(value) ? value : [value]

  return values.filter((filterValue): filterValue is DataTableFilterValue => {
    if (
      typeof filterValue !== "boolean" &&
      typeof filterValue !== "number" &&
      typeof filterValue !== "string"
    ) {
      return false
    }

    return typeof filterValue !== "string" || filterValue.length > 0
  })
}

function serializeColumnFilters(
  columnFilters: ColumnFiltersState,
  searchColumnId?: string
): {
  search: string | null
  filters: DataTableFilterParams | null
} {
  const filters: DataTableFilterParams = {}
  let search: string | null = null

  for (const columnFilter of columnFilters) {
    if (columnFilter.id === searchColumnId) {
      search =
        typeof columnFilter.value === "string" && columnFilter.value ? columnFilter.value : null
      continue
    }

    const values = normalizeFilterValue(columnFilter.value)

    if (values.length > 0) {
      filters[columnFilter.id] = values
    }
  }

  return {
    search,
    filters: Object.keys(filters).length > 0 ? filters : null,
  }
}

export function useDataTableUrlState({
  searchColumnId,
  serverSide = false,
}: UseDataTableUrlStateOptions = {}) {
  const [filters, setFilters] = useFilterDataTable({
    shallow: !serverSide,
  })

  const pagination = React.useMemo<PaginationState>(
    () => ({
      pageIndex: Math.max(filters.page - 1, 0),
      pageSize: Math.max(filters.page_size, 1),
    }),
    [filters.page, filters.page_size]
  )

  const sorting = React.useMemo<SortingState>(() => parseSorting(filters.sort), [filters.sort])

  const columnFilters = React.useMemo<ColumnFiltersState>(() => {
    const nextFilters: ColumnFiltersState = []

    if (searchColumnId && filters.search) {
      nextFilters.push({
        id: searchColumnId,
        value: filters.search,
      })
    }

    for (const [id, value] of Object.entries(filters.filters)) {
      if (id !== searchColumnId && value.length > 0) {
        nextFilters.push({ id, value })
      }
    }

    return nextFilters
  }, [filters.filters, filters.search, searchColumnId])

  const onPaginationChange = React.useCallback<OnChangeFn<PaginationState>>(
    (updaterOrValue) => {
      const nextPagination = resolveUpdater(updaterOrValue, pagination)

      void setFilters({
        page: nextPagination.pageIndex + 1,
        page_size: nextPagination.pageSize,
      })
    },
    [pagination, setFilters]
  )

  const onSortingChange = React.useCallback<OnChangeFn<SortingState>>(
    (updaterOrValue) => {
      const nextSorting = resolveUpdater(updaterOrValue, sorting)

      void setFilters({
        page: 1,
        sort: serializeSorting(nextSorting),
      })
    },
    [setFilters, sorting]
  )

  const onColumnFiltersChange = React.useCallback<OnChangeFn<ColumnFiltersState>>(
    (updaterOrValue) => {
      const nextColumnFilters = resolveUpdater(updaterOrValue, columnFilters)
      const nextFilters = serializeColumnFilters(nextColumnFilters, searchColumnId)

      void setFilters({
        page: 1,
        search: nextFilters.search,
        filters: nextFilters.filters,
      })
    },
    [columnFilters, searchColumnId, setFilters]
  )

  return {
    pagination,
    sorting,
    columnFilters,
    onPaginationChange,
    onSortingChange,
    onColumnFiltersChange,
  }
}
