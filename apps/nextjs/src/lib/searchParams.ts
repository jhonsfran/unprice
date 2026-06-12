import { DEFAULT_INTERVAL, INTERVAL_KEYS } from "@unprice/analytics"
import {
  createLoader,
  parseAsInteger,
  parseAsJson,
  parseAsString,
  parseAsStringEnum,
} from "nuqs/server"

export type DataTableFilterValue = boolean | number | string
export type DataTableFilterParams = Record<string, DataTableFilterValue[]>

function parseDataTableFilterParams(value: unknown): DataTableFilterParams | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const filters: DataTableFilterParams = {}

  for (const [key, rawValues] of Object.entries(value)) {
    if (
      !Array.isArray(rawValues) ||
      rawValues.some(
        (rawValue) =>
          typeof rawValue !== "boolean" &&
          typeof rawValue !== "number" &&
          typeof rawValue !== "string"
      )
    ) {
      return null
    }

    const values = rawValues.filter((rawValue) => {
      if (typeof rawValue === "string") {
        return rawValue.length > 0
      }

      return true
    })

    if (values.length > 0) {
      filters[key] = values
    }
  }

  return filters
}

export const filtersDataTableParsers = {
  page: parseAsInteger.withDefault(1),
  page_size: parseAsInteger.withDefault(10),
  to: parseAsInteger,
  from: parseAsInteger,
  search: parseAsString,
  sort: parseAsString,
  filters: parseAsJson(parseDataTableFilterParams).withDefault({}),
  intervalDays: parseAsInteger.withDefault(7),
}

export const intervalParser = {
  intervalFilter: parseAsStringEnum(INTERVAL_KEYS).withDefault(DEFAULT_INTERVAL),
}

export const pageParser = {
  pageId: parseAsString.withDefault("all"),
}

export const intervalParams = createLoader(intervalParser)
export const dataTableParams = createLoader(filtersDataTableParsers)
export const pageParams = createLoader(pageParser)
