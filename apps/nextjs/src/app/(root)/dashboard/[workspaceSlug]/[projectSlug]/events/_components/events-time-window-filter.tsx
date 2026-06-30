"use client"

import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { format } from "date-fns"
import { CalendarDays, X } from "lucide-react"
import type { DateRange } from "react-day-picker"

function today(): Date {
  return new Date()
}

function oneMonthAgo(): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d
}

export function EventsTimeWindowFilter({
  value,
  onChange,
}: {
  value?: DateRange
  onChange: (range: DateRange | undefined) => void
}) {
  const hasExplicitValue = Boolean(value?.from || value?.to)

  return (
    <div className="flex items-center gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-44 justify-start gap-2 font-medium text-xs"
          >
            <CalendarDays className="size-4" />
            <span className="truncate">{formatDateRangeLabel(value)}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            initialFocus
            mode="range"
            selected={value}
            onSelect={onChange}
            numberOfMonths={1}
            fromDate={oneMonthAgo()}
            toDate={today()}
            disabled={{ after: today() }}
          />
        </PopoverContent>
      </Popover>
      {hasExplicitValue ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Clear time window"
          onClick={() => onChange(undefined)}
        >
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}

function formatDateRangeLabel(range?: DateRange): string {
  if (!range?.from) {
    return "Last hour"
  }

  if (!range.to) {
    return format(range.from, "LLL dd, y")
  }

  return `${format(range.from, "LLL dd, y")} - ${format(range.to, "LLL dd, y")}`
}
