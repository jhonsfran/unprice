"use client"
import { prepareInterval, preparePage } from "@unprice/analytics"
import { useQueryStates } from "nuqs"
import { useMemo } from "react"
import { intervalParser, pageParser } from "~/lib/searchParams"

export function useIntervalFilter() {
  const [intervalFilter, setIntervalFilter] = useQueryStates(intervalParser, {
    history: "replace",
    shallow: true,
    scroll: false,
    clearOnDefault: true,
    throttleMs: 1000,
  })

  const parsedInterval = useMemo(() => {
    return prepareInterval(intervalFilter.intervalFilter)
  }, [intervalFilter.intervalFilter])

  return [parsedInterval, setIntervalFilter] as const
}

export function usePageFilter() {
  const [pageFilter, setPageFilter] = useQueryStates(pageParser, {
    history: "replace",
    shallow: true,
    scroll: false,
    clearOnDefault: true,
    throttleMs: 1000,
  })

  const parsedPage = useMemo(() => {
    return preparePage(pageFilter.pageId)
  }, [pageFilter.pageId])

  return [parsedPage, setPageFilter] as const
}
