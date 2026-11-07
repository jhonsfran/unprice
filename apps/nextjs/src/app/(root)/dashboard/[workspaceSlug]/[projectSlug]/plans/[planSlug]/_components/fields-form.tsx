"use client"

import { HelpCircle } from "lucide-react"
import type { UseFormReturn } from "react-hook-form"

import { BILLING_CONFIG, OVERAGE_STRATEGIES_MAP, RESET_CONFIG } from "@unprice/db/utils"
import { type PlanVersionFeatureInsert, isResetCadenceAtMostBilling } from "@unprice/db/validators"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"

import { InputWithAddons } from "~/components/input-addons"

export function QuantityFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="defaultQuantity"
        render={({ field }) => (
          <FormItem className="">
            <div className="flex items-center gap-1">
              <FormLabel>Default Quantity</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  Initial quantity assigned when a subscription starts. Leave empty to require
                  quantity selection during checkout.
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  trailing={"units"}
                  value={field.value ?? ""}
                  disabled={isDisabled}
                />
              </FormControl>

              <FormMessage className="self-start" />
            </div>
          </FormItem>
        )}
      />
    </div>
  )
}

export function LimitFormField({
  form,
  isDisabled,
  units,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
  units: string
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="limit"
        render={({ field }) => (
          <FormItem className="">
            <div className="flex items-center gap-1">
              <FormLabel>Usage Limit</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  Maximum allowed usage. When reached, access is blocked or overage charges apply.
                  Leave empty for unlimited usage.
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  trailing={units}
                  placeholder="No limit"
                  value={field.value ?? ""}
                  disabled={isDisabled}
                />
              </FormControl>

              <FormMessage className="self-start" />
            </div>
          </FormItem>
        )}
      />
    </div>
  )
}

/**
 * Units free per statement period (ADR-0008 D5): the rate card prices only usage past them. Only
 * for a usage feature whose meter has no group-by dimensions.
 */
export function IncludedFormField({
  form,
  isDisabled,
  units,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
  units: string
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="included"
        render={({ field }) => (
          <FormItem className="">
            <div className="flex items-center gap-1">
              <FormLabel>Included</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  Units free each billing period. The rate card prices only the usage past them.
                  Leave empty to include none.
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  trailing={units}
                  placeholder="None"
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value.trim() || null)}
                  disabled={isDisabled}
                />
              </FormControl>

              <FormMessage className="self-start" />
            </div>
          </FormItem>
        )}
      />
    </div>
  )
}

export function UnitsFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="config.units"
        render={({ field }) => (
          <FormItem className="">
            <div className="flex items-center gap-1">
              <FormLabel>Bundle size</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  How many units the customer gets in each bundle. The rate card prices each bundle.
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  trailing={"units"}
                  value={field.value ?? ""}
                  disabled={isDisabled}
                />
              </FormControl>

              <FormMessage className="self-start" />
            </div>
          </FormItem>
        )}
      />
    </div>
  )
}

export function ResetConfigFeatureFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  const billingConfig = form.watch("billingConfig")

  // filter dev option when node_env is production
  const options: { label: string; key: string; description: string }[] = []
  for (const [key, value] of Object.entries(RESET_CONFIG)) {
    // Exclude dev-only options in production, exclude onetime in development
    if (process.env.NODE_ENV === "production") {
      if (value?.dev === true) continue
    } else {
      if (key === "onetime") continue
    }

    // Exclude options that exceed the billing cadence
    if (billingConfig) {
      if (
        !isResetCadenceAtMostBilling(
          {
            name: key,
            resetInterval: value.resetInterval,
            resetIntervalCount: value.resetIntervalCount,
            resetAnchor: "dayOfCreation",
            planType: value.planType,
          },
          billingConfig
        )
      ) {
        continue
      }
    }

    options.push({ label: value.label, key, description: value.description })
  }

  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name={"resetConfig.name"}
        render={({ field }) => (
          <FormItem className="flex w-full flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>Usage Reset</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  When usage counters reset to zero (e.g., monthly, weekly). This controls when
                  customers get fresh allowances.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              onValueChange={(value) => {
                const config = RESET_CONFIG[value]
                if (!config) return

                form.setValue("resetConfig.planType", config.planType)
                form.setValue("resetConfig.resetIntervalCount", config.resetIntervalCount)
                form.setValue("resetConfig.resetInterval", config.resetInterval)
                form.setValue("resetConfig.name", value)
              }}
              value={field.value?.toString() ?? ""}
              disabled={isDisabled}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reset interval" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className="text-xs">
                {options.map((value) => (
                  <SelectItem value={value.key} key={value.key} description={value.description}>
                    {value.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}

export function BillingConfigFeatureFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  // filter dev option when node_env is production
  const options: { label: string; key: string; description: string }[] = []
  for (const [key, value] of Object.entries(BILLING_CONFIG)) {
    if (process.env.NODE_ENV === "production") {
      if (value?.dev === true) continue
    } else {
      if (key === "onetime") continue
    }
    options.push({ label: value.label, key, description: value.description })
  }

  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name={"billingConfig.name"}
        render={({ field }) => (
          <FormItem className="flex w-full flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>Feature Billing</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  How often this specific feature is charged. Can differ from the main plan billing
                  cycle.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              onValueChange={(value) => {
                const config = BILLING_CONFIG[value]
                if (!config) return

                form.setValue("billingConfig.planType", config.planType)
                form.setValue("billingConfig.billingIntervalCount", config.billingIntervalCount)
                form.setValue("billingConfig.billingInterval", config.billingInterval)
                form.setValue("billingConfig.name", value)

                const matchingResetConfig = RESET_CONFIG[value]
                if (!matchingResetConfig) return

                form.setValue("resetConfig.planType", matchingResetConfig.planType, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
                form.setValue(
                  "resetConfig.resetIntervalCount",
                  matchingResetConfig.resetIntervalCount,
                  {
                    shouldDirty: true,
                    shouldValidate: true,
                  }
                )
                form.setValue("resetConfig.resetInterval", matchingResetConfig.resetInterval, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
                form.setValue("resetConfig.resetAnchor", "dayOfCreation", {
                  shouldDirty: true,
                  shouldValidate: true,
                })
                form.setValue("resetConfig.name", value, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }}
              value={field.value?.toString() ?? ""}
              disabled={isDisabled}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select a billing interval" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className="text-xs">
                {options.map((value) => (
                  <SelectItem value={value.key} key={value.key} description={value.description}>
                    {value.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}

export function OverageStrategyFormField({
  form,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  isDisabled?: boolean
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="metadata.overageStrategy"
        render={({ field }) => (
          <FormItem className="flex flex-col">
            <div className="flex items-center gap-1">
              <FormLabel>Overage Handling</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  What happens when usage exceeds the limit: block access, allow with extra charges,
                  or continue free. Only applies if a limit is set.
                </TooltipContent>
              </Tooltip>
            </div>
            <Select onValueChange={field.onChange} value={field.value ?? ""} disabled={isDisabled}>
              <FormControl className="truncate">
                <SelectTrigger disabled={isDisabled}>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
              </FormControl>
              <SelectContent className="text-xs">
                {Object.entries(OVERAGE_STRATEGIES_MAP).map(([key, value]) => (
                  <SelectItem value={key} key={key} description={value.description}>
                    {value.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}
