"use client"

import { useQueryStates } from "nuqs"
import { filtersDataTableParsers } from "~/lib/searchParams"

export function useFilterDataTable({ shallow = false }: { shallow?: boolean } = {}) {
  return useQueryStates(filtersDataTableParsers, {
    history: "push",
    shallow,
    scroll: false,
    clearOnDefault: true,
  })
}
