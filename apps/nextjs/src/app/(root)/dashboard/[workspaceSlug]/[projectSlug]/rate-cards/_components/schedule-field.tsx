"use client"

import { Input } from "@unprice/ui/input"
import { Label } from "@unprice/ui/label"
import { Switch } from "@unprice/ui/switch"

/**
 * When a row change takes effect: now by default (the server picks the earliest the card allows),
 * or a chosen time behind a "Schedule for later" toggle.
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
          <Input
            id={id}
            type="datetime-local"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
          />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{nowText}</p>
      )}
    </div>
  )
}
