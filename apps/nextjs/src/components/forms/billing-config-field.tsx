"use client"

import { BILLING_CONFIG } from "@unprice/db/utils"
import type { BillingConfig, BillingInterval, InsertBillingConfig } from "@unprice/db/validators"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { HelpCircle } from "@unprice/ui/icons"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import type { FieldPath, FieldValues, PathValue, UseFormReturn } from "react-hook-form"
import { FilterScroll } from "~/components/filter-scroll"
import { billingAnchorLabel, billingIntervalOptions } from "./billing-labels"

interface FormValues extends FieldValues {
  billingConfig: BillingConfig | InsertBillingConfig
}

export default function BillingConfigFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
}) {
  const options = billingIntervalOptions()

  const billingNamePath = "billingConfig.name" as const as FieldPath<TFieldValues>
  const billingName = form.watch(billingNamePath) as BillingInterval
  const interval = BILLING_CONFIG[billingName]
  const optionAnchor = interval?.billingAnchorOptions

  return (
    <>
      <FormField
        control={form.control}
        name={"billingConfig.name" as FieldPath<TFieldValues>}
        render={({ field }) => (
          <FormItem className="flex w-full flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>Billing interval</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  How often customers are invoiced.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              onValueChange={(value) => {
                const config = BILLING_CONFIG[value]
                if (!config) return

                const planTypePath = "billingConfig.planType" as FieldPath<TFieldValues>
                form.setValue(
                  planTypePath,
                  config.planType as PathValue<TFieldValues, typeof planTypePath>
                )

                const intervalCountPath =
                  "billingConfig.billingIntervalCount" as FieldPath<TFieldValues>
                form.setValue(
                  intervalCountPath,
                  config.billingIntervalCount as PathValue<TFieldValues, typeof intervalCountPath>
                )

                const intervalPath = "billingConfig.billingInterval" as FieldPath<TFieldValues>
                form.setValue(
                  intervalPath,
                  config.billingInterval as PathValue<TFieldValues, typeof intervalPath>
                )

                if (config.billingAnchorOptions.length === 0) {
                  const anchorPath = "billingConfig.billingAnchor" as FieldPath<TFieldValues>
                  form.setValue(
                    anchorPath,
                    "dayOfCreation" as PathValue<TFieldValues, typeof anchorPath>
                  )
                }

                const namePath = "billingConfig.name" as FieldPath<TFieldValues>
                form.setValue(namePath, value as PathValue<TFieldValues, typeof namePath>)
              }}
              value={field.value?.toString() ?? ""}
              disabled={isDisabled}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select a billing interval" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <FilterScroll>
                  {options.map((option) => (
                    <SelectItem
                      value={option.value}
                      key={option.value}
                      description={option.description}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </FilterScroll>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      {optionAnchor && optionAnchor.length > 0 && (
        <FormField
          control={form.control}
          name={"billingConfig.billingAnchor" as FieldPath<TFieldValues>}
          render={({ field }) => (
            <FormItem className="flex w-full flex-col">
              <div className="flex items-center gap-1">
                <FormLabel>Billing anchor</FormLabel>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-[250px]">
                    The day each billing period starts, such as the 1st of the month.
                  </TooltipContent>
                </Tooltip>
              </div>
              <Select
                onValueChange={(value) => {
                  field.onChange(value)
                }}
                value={field.value?.toString() ?? "dayOfCreation"}
                disabled={isDisabled}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a billing anchor" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <FilterScroll>
                    {optionAnchor.map((option) => (
                      <SelectItem value={option.toString()} key={option.toString()}>
                        {billingAnchorLabel(option, interval?.billingInterval)}
                      </SelectItem>
                    ))}
                  </FilterScroll>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </>
  )
}
