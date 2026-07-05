"use client"

import { add, addDays, endOfDay, startOfDay, startOfMonth } from "date-fns"
import { ArrowRight, CalendarIcon, HelpCircle } from "lucide-react"
import { useState } from "react"
import type { FieldErrors, FieldPath, UseFormReturn } from "react-hook-form"

import { Button } from "@unprice/ui/button"
import { Calendar } from "@unprice/ui/calendar"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Popover, PopoverContent, PopoverTrigger } from "@unprice/ui/popover"
import { cn } from "@unprice/ui/utils"
import { toastAction } from "~/lib/toast"

import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { toZonedTime } from "date-fns-tz"
import type { FieldValues } from "react-hook-form"
import { formatDate } from "~/lib/dates"

interface FormValues extends FieldValues {
  startAt: number
  endAt?: number | null
}

export default function DurationFormField<TFieldValues extends FormValues>({
  form,
  startDisabled,
  endDisabled,
  className,
}: {
  form: UseFormReturn<TFieldValues>
  startDisabled?: boolean
  endDisabled?: boolean
  className?: string
}) {
  const startAt = form.getValues("startAt" as FieldPath<TFieldValues>)
  const endAt = form.getValues("endAt" as FieldPath<TFieldValues>)
  const timezone =
    form.getValues("timezone" as FieldPath<TFieldValues>) ??
    Intl.DateTimeFormat().resolvedOptions().timeZone

  const [start, setStart] = useState<Date | undefined>(
    startAt ? toZonedTime(new Date(startAt), timezone) : undefined
  )
  const [end, setEnd] = useState<Date | undefined>(
    endAt ? toZonedTime(new Date(endAt), timezone) : undefined
  )
  const [isOpenPopOverStart, setIsOpenPopOverStart] = useState(false)
  const [isOpenPopOverEnd, setIsOpenPopOverEnd] = useState(false)

  const { errors } = form.formState

  // Helper function to safely get the error message
  const getErrorMessage = (
    errors: FieldErrors<TFieldValues>,
    field: string
  ): string | undefined => {
    const error = errors[field as keyof typeof errors]
    return error && typeof error === "object" && "message" in error
      ? (error.message as string)
      : undefined
  }

  return (
    <div className={cn("flex w-full flex-col gap-2", className)}>
      <div className="flex items-center gap-1">
        <FormLabel
          className={cn({
            "text-destructive": errors.startAt,
          })}
        >
          Duration
        </FormLabel>

        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="size-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-[250px]">
            The duration of the phase
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="flex flex-row rounded-md border bg-background-bg">
        <FormField
          control={form.control}
          name={"startAt" as FieldPath<TFieldValues>}
          render={({ field }) => (
            <FormItem className="flex w-full flex-col">
              <Popover open={isOpenPopOverStart} onOpenChange={setIsOpenPopOverStart}>
                <PopoverTrigger asChild disabled={startDisabled}>
                  <FormControl>
                    <Button
                      variant={"custom"}
                      className={cn(
                        "h-9 rounded-e-none pl-3 text-left font-normal hover:bg-muted hover:text-background-textContrast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
                        !start && "text-muted-foreground"
                      )}
                      disabled={startDisabled}
                    >
                      {start ? (
                        formatDate(start.getTime(), timezone, "MMM dd, yyyy")
                      ) : (
                        <span>Start Date</span>
                      )}
                      <ArrowRight className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="flex w-auto p-0" side="bottom" align="end">
                  <div className="border-r">
                    <Calendar
                      mode="single"
                      selected={start}
                      onSelect={(date) => {
                        setStart(date)
                        setIsOpenPopOverStart(false)

                        if (!date) {
                          field.onChange(undefined)
                          setIsOpenPopOverStart(false)
                          return
                        }

                        const today = startOfDay(new Date())
                        if (startOfDay(date).getTime() === today.getTime()) {
                          field.onChange(Date.now())
                        } else {
                          const midnight = startOfDay(date)
                          field.onChange(midnight.getTime())
                        }
                      }}
                      defaultMonth={start}
                      initialFocus
                      disabled={(date) => {
                        const today = startOfDay(new Date())
                        // disable dates before today
                        if (date < today) return true
                        // if disabled, disable all dates
                        if (startDisabled) return true
                        return false
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-2 px-2 py-4">
                    <div className="px-3 font-medium text-sm">Shortcuts</div>
                    <div className="grid gap-1">
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          const now = Date.now()
                          setStart(new Date(now))
                          field.onChange(now)
                          setIsOpenPopOverStart(false)
                        }}
                      >
                        Today
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          const tomorrow = addDays(new Date(), 1)
                          setStart(tomorrow)
                          field.onChange(tomorrow.getTime())
                          setIsOpenPopOverStart(false)
                        }}
                      >
                        Tomorrow
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          const data = addDays(new Date(), 7)
                          setStart(data)
                          field.onChange(data.getTime())
                          setIsOpenPopOverStart(false)
                        }}
                      >
                        Next week
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          const nextMonth = startOfMonth(add(new Date(), { months: 1 }))
                          setStart(nextMonth)
                          field.onChange(nextMonth.getTime())
                          setIsOpenPopOverStart(false)
                        }}
                      >
                        Next month
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={"endAt" as FieldPath<TFieldValues>}
          render={({ field }) => (
            <FormItem className="flex w-full flex-col">
              <Popover open={isOpenPopOverEnd} onOpenChange={setIsOpenPopOverEnd}>
                <PopoverTrigger asChild disabled={endDisabled}>
                  <FormControl>
                    <Button
                      variant={"custom"}
                      className={cn(
                        "h-9 rounded-s-none pl-3 text-left font-normal hover:bg-muted hover:text-background-textContrast focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
                        !end && "text-muted-foreground"
                      )}
                      disabled={endDisabled}
                    >
                      {end ? (
                        formatDate(end.getTime(), timezone, "MMM dd, yyyy")
                      ) : (
                        <span>Forever</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="flex w-auto p-0" side="bottom" align="end">
                  <div className="border-r">
                    <Calendar
                      mode="single"
                      selected={end}
                      defaultMonth={end ?? start}
                      onSelect={(date) => {
                        setEnd(date)
                        setIsOpenPopOverEnd(false)

                        if (!date) {
                          field.onChange(undefined)
                          setIsOpenPopOverEnd(false)
                          return
                        }

                        const today = startOfDay(new Date())
                        if (startOfDay(date).getTime() === today.getTime()) {
                          field.onChange(Date.now())
                        } else {
                          const endday = endOfDay(date)
                          field.onChange(endday.getTime())
                        }
                      }}
                      disabled={(date) => {
                        const today = startOfDay(new Date())
                        return (
                          !start ||
                          startOfDay(date) < startOfDay(start) ||
                          date < today ||
                          !!endDisabled
                        )
                      }}
                      initialFocus
                    />
                  </div>
                  <div className="flex flex-col gap-2 px-2 py-4">
                    <div className="px-3 font-medium text-sm">Shortcuts</div>
                    <div className="grid gap-1">
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          setEnd(undefined)
                          field.onChange(null)
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        Forever
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }

                          const now = Date.now()

                          if (now < start.getTime()) {
                            toastAction("error", "End date can't be before the start date")
                            return
                          }

                          setEnd(new Date(now))
                          field.onChange(now)
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        Now
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }

                          const date = add(start, { months: 1 })
                          const endday = endOfDay(date)

                          const today = startOfDay(new Date())
                          if (endday < today) {
                            toastAction("error", "The calculated end date is in the past")
                            return
                          }

                          setEnd(endday)
                          field.onChange(endday.getTime())
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        1 Month
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }
                          const date = add(start, { months: 2 })
                          const endday = endOfDay(date)

                          const today = startOfDay(new Date())
                          if (startOfDay(endday) < today) {
                            toastAction("error", "The calculated end date is in the past")
                            return
                          }

                          setEnd(endday)
                          field.onChange(endday.getTime())
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        2 Months
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }
                          const date = add(start, { months: 3 })
                          const endday = endOfDay(date)

                          const today = startOfDay(new Date())
                          if (startOfDay(endday) < today) {
                            toastAction("error", "The calculated end date is in the past")
                            return
                          }

                          setEnd(endday)
                          field.onChange(endday.getTime())
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        3 Months
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }
                          const date = add(start, { months: 6 })
                          const endday = endOfDay(date)

                          const today = startOfDay(new Date())
                          if (startOfDay(endday) < today) {
                            toastAction("error", "The calculated end date is in the past")
                            return
                          }

                          setEnd(endday)
                          field.onChange(endday.getTime())
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        6 Months
                      </Button>
                      <Button
                        variant="ghost"
                        className="justify-start font-normal"
                        onClick={() => {
                          if (!start) {
                            toastAction("error", "Please select a start date first")
                            return
                          }
                          const date = add(start, { months: 12 })
                          const endday = endOfDay(date)

                          const today = startOfDay(new Date())
                          if (startOfDay(endday) < today) {
                            toastAction("error", "The calculated end date is in the past")
                            return
                          }

                          setEnd(endday)
                          field.onChange(endday.getTime())
                          setIsOpenPopOverEnd(false)
                        }}
                      >
                        12 Months
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </FormItem>
          )}
        />
      </div>
      {errors.startAt && <FormMessage>{getErrorMessage(errors, "startAt")}</FormMessage>}
      {errors.endAt && <FormMessage>{getErrorMessage(errors, "endAt")}</FormMessage>}
    </div>
  )
}
