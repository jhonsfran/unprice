"use client"

import { WHEN_TO_BILLING } from "@unprice/db/utils"
import type { WhenToBill } from "@unprice/db/validators"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import type { FieldPath, FieldValues, UseFormReturn } from "react-hook-form"
import { WHEN_TO_BILL_LABEL, WHEN_TO_BILL_NOTE } from "./billing-labels"

interface FormValues extends FieldValues {
  whenToBill?: WhenToBill | null
}

export default function WhenToBillFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  return (
    <FormField
      control={form.control}
      name={"whenToBill" as FieldPath<TFieldValues>}
      render={({ field }) => {
        const value = (field.value ?? undefined) as WhenToBill | undefined
        return (
          <FormItem className="flex w-full flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>When to bill</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  Whether a period is invoiced when it starts or when it ends.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select onValueChange={field.onChange} value={value ?? ""} disabled={isDisabled}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select when to bill" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {WHEN_TO_BILLING.map((type) => (
                  <SelectItem key={type} value={type}>
                    {WHEN_TO_BILL_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {value && (
              <FormDescription className="text-xs">{WHEN_TO_BILL_NOTE[value]}</FormDescription>
            )}
            <FormMessage />
          </FormItem>
        )
      }}
    />
  )
}
