"use client"

import { add, format, startOfDay } from "date-fns"
import { CalendarIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
import { Label } from "@unprice/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Switch } from "@unprice/ui/switch"

import { toDateTimeLocal } from "./rate-card-format"

/** "2026-11-06T18:07" as a Date in the browser's time zone; null while incomplete. */
function parseLocal(value: string): Date | null {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? date : null
}

/**
 * When a row change takes effect: now by default (the server picks the earliest the card allows),
 * or a chosen day and time behind a "Schedule for later" toggle. The day comes from the same
 * Calendar popover the rest of the dashboard uses; the value stays a `datetime-local` string.
 */
export function ScheduleField({
  id,
  label,
  nowText = "Starts now, or as soon as the card allows.",
  schedule,
  onScheduleChange,
  value,
  onChange,
}: {
  id: string
  label: string
  /** What happens without a schedule. */
  nowText?: string
  schedule: boolean
  onScheduleChange: (schedule: boolean) => void
  value: string
  onChange: (value: string) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const date = parseLocal(value)
  const time = date ? format(date, "HH:mm") : "00:00"

  // A new day keeps the chosen time; a new time keeps the chosen day.
  const setDay = (day: Date) => {
    const [hours = 0, minutes = 0] = time.split(":").map(Number)
    onChange(toDateTimeLocal(add(startOfDay(day), { hours, minutes }).getTime()))
  }
  const setTime = (next: string) => {
    const [hours, minutes] = next.split(":").map(Number)
    if (hours === undefined || minutes === undefined || Number.isNaN(hours)) return
    onChange(toDateTimeLocal(add(startOfDay(date ?? new Date()), { hours, minutes }).getTime()))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-schedule`} className="font-normal text-sm">
          Schedule for later
        </Label>
        <Switch id={`${id}-schedule`} checked={schedule} onCheckedChange={onScheduleChange} />
      </div>
      {schedule ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>{label}</Label>
          <div className="flex items-center gap-2">
            <Popover open={isOpen} onOpenChange={setIsOpen}>
              <PopoverTrigger asChild>
                <Button
                  id={id}
                  type="button"
                  variant="outline"
                  className="h-9 flex-1 justify-start gap-2 pl-3 font-normal"
                >
                  <CalendarIcon className="size-4 opacity-50" />
                  {date ? format(date, "EEE, MMM d, yyyy") : "Pick a day"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="flex w-auto p-0" align="start">
                <div className="border-r">
                  <Calendar
                    mode="single"
                    selected={date ?? undefined}
                    defaultMonth={date ?? undefined}
                    onSelect={(day) => {
                      if (!day) return
                      setDay(day)
                      setIsOpen(false)
                    }}
                    disabled={(day) => day < startOfDay(new Date())}
                    initialFocus
                  />
                </div>
                <div className="flex flex-col gap-1 p-2">
                  <span className="px-2 py-1 font-medium text-xs">Shortcuts</span>
                  {[
                    { label: "Tomorrow", day: add(new Date(), { days: 1 }) },
                    { label: "Next week", day: add(new Date(), { weeks: 1 }) },
                    {
                      label: "First of next month",
                      day: add(new Date(new Date().getFullYear(), new Date().getMonth(), 1), {
                        months: 1,
                      }),
                    },
                  ].map((shortcut) => (
                    <Button
                      key={shortcut.label}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="justify-start font-normal"
                      onClick={() => {
                        setDay(shortcut.day)
                        setIsOpen(false)
                      }}
                    >
                      {shortcut.label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <TimeSelect label={label} value={time} onChange={setTime} />
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{nowText}</p>
      )}
    </div>
  )
}

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"))
const MINUTES = Array.from({ length: 12 }, (_, step) => String(step * 5).padStart(2, "0"))

/** "18:42" as an hour and a minute picked from lists, in five-minute steps plus the current one. */
function TimeSelect({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [hour = "00", minute = "00"] = value.split(":")
  // The earliest allowed start is rarely on a five-minute mark; keep it pickable.
  const minutes = MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort()

  return (
    <div className="flex items-center gap-1">
      <Select value={hour} onValueChange={(next) => onChange(`${next}:${minute}`)}>
        <SelectTrigger className="h-9 w-[68px] tabular-nums" aria-label={`${label}, hour`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {HOURS.map((option) => (
            <SelectItem key={option} value={option} className="tabular-nums">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">:</span>
      <Select value={minute} onValueChange={(next) => onChange(`${hour}:${next}`)}>
        <SelectTrigger className="h-9 w-[68px] tabular-nums" aria-label={`${label}, minute`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-64">
          {minutes.map((option) => (
            <SelectItem key={option} value={option} className="tabular-nums">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
