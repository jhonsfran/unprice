"use client"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { InputWithAddons } from "~/components/input-addons"

interface FormValues extends FieldValues {
  trialUnits?: number
}

export default function TrialUnitsFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
  className,
  unitLabel = "days",
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  className?: string
  unitLabel?: string
}) {
  return (
    <FormField
      control={form.control}
      name={"trialUnits" as FieldPath<TFieldValues>}
      render={({ field }) => (
        <FormItem className={cn("flex w-full flex-col", className)}>
          <div className="flex items-center gap-1">
            <FormLabel>Trial Duration</FormLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-[250px]">
                Free trial duration. Minute-billed plans use minutes; all other plans use days.
              </TooltipContent>
            </Tooltip>
          </div>
          <FormControl className="w-full">
            <InputWithAddons
              {...field}
              trailing={unitLabel}
              value={field.value ?? 0}
              disabled={isDisabled}
            />
          </FormControl>

          <FormMessage className="self-start pt-1" />
        </FormItem>
      )}
    />
  )
}
