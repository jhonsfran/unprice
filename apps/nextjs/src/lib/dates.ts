import { addDays, format } from "date-fns"
import { toZonedTime } from "date-fns-tz"

export function formatDate(date: number, timezone?: string, formatString?: string) {
  const userTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  return format(toZonedTime(date, userTimezone), formatString ?? "yyyy-MM-dd")
}

/**
 * Whenever you select a date, it will use the midnight timestamp of that date.
 * We need to add a day minus one second to include the whole day.
 */
export function manipulateDate(
  date?: {
    from: Date | undefined
    to?: Date | undefined
  } | null
) {
  const isToDateMidnight = String(date?.to?.getTime()).endsWith("00000")

  // We might wanna use `endOfDay(new Date(date.to))` here
  const addOneDayToDate = date?.to ? addDays(new Date(date.to), 1).getTime() - 1 : null

  return {
    from: date?.from?.getTime() ?? null,
    to: isToDateMidnight ? addOneDayToDate : (date?.to?.getTime() ?? null),
  }
}
