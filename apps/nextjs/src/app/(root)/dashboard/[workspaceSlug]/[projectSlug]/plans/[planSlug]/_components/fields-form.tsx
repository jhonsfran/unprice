"use client"

import { DollarSignIcon, HelpCircle, Plus, XCircle } from "lucide-react"
import type { UseFormReturn } from "react-hook-form"
import { useFieldArray } from "react-hook-form"

import { BILLING_CONFIG, OVERAGE_STRATEGIES_MAP, RESET_CONFIG } from "@unprice/db/utils"
import type { Currency, PlanVersionFeatureInsert } from "@unprice/db/validators"

import { currencySymbol } from "@unprice/money"
import { Button } from "@unprice/ui/button"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@unprice/ui/select"
import { Tooltip, TooltipArrow, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn } from "@unprice/ui/utils"

import { InputWithAddons } from "~/components/input-addons"
import { SectionLabel } from "./section-label"

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

export function PriceFormField({
  form,
  currency,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  currency: Currency
  isDisabled?: boolean
}) {
  return (
    <div className="w-full">
      <FormField
        control={form.control}
        name="config.price.displayAmount"
        render={({ field }) => (
          <FormItem className="">
            <div className="flex items-center gap-1">
              <FormLabel>Price</FormLabel>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[250px]">
                  The cost in the plan's currency. Supports decimals (e.g., $1.99).
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  leading={currencySymbol(currency)}
                  trailing={currency}
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
            <div className="flex flex-col items-center space-y-1">
              <FormControl className="w-full">
                <InputWithAddons
                  {...field}
                  leading={"per"}
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
  // filter dev option when node_env is production
  const options = Object.entries(RESET_CONFIG)
    .filter(([key]) => {
      if (process.env.NODE_ENV === "production") {
        return RESET_CONFIG[key]?.dev !== true
      }

      // deactivate yearly for now
      return !["yearly", "onetime"].includes(key)
    })
    .map(([key, value]) => ({
      label: value.label,
      key,
      description: value.description,
    }))

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
  const options = Object.entries(BILLING_CONFIG)
    .filter(([key]) => {
      if (process.env.NODE_ENV === "production") {
        return BILLING_CONFIG[key]?.dev !== true
      }

      // deactivate yearly for now
      return !["yearly", "onetime"].includes(key)
    })
    .map(([key, value]) => ({
      label: value.label,
      key,
      description: value.description,
    }))

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

export function TierFormField({
  form,
  currency,
  isDisabled,
}: {
  form: UseFormReturn<PlanVersionFeatureInsert>
  currency: Currency
  isDisabled?: boolean
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "config.tiers",
  })

  return (
    <div className="flex w-full flex-col">
      <div className="mb-3">
        <SectionLabel
          tooltip={
            form.getValues("featureType") === "usage"
              ? "Set up pricing tiers based on usage volume. Customers pay different rates as their usage increases."
              : "Set up pricing tiers based on quantity selected. Different quantities unlock different price points."
          }
        >
          Tier configuration
        </SectionLabel>
      </div>

      {fields.length > 0 ? (
        <div className="px-2 py-2">
          {fields.map((field, index) => (
            <div
              key={field.id}
              className="grid grid-cols-[1fr_1fr_1fr_28px] items-end gap-2 space-y-2"
            >
              <div>
                <FormField
                  control={form.control}
                  key={field.id}
                  name={`config.tiers.${index}.lastUnit`}
                  render={({ field }) => {
                    const isLastRow = index === fields.length - 1
                    return (
                      <FormItem>
                        <FormLabel className={cn(index !== 0 && "sr-only")}>
                          <Tooltip>
                            <div className="flex items-center gap-2 font-normal text-xs">
                              Up to
                              <span>
                                <TooltipTrigger asChild>
                                  <HelpCircle className="h-4 w-4 font-light" />
                                </TooltipTrigger>
                              </span>
                            </div>
                            <TooltipContent
                              className="w-56 bg-background-bg font-normal text-xs"
                              align="center"
                            >
                              Maximum unit covered by this tier. Use ∞ for the final tier — every
                              following tier starts one unit above the previous "up to".
                              <TooltipArrow className="fill-background-bg" />
                            </TooltipContent>
                          </Tooltip>
                        </FormLabel>

                        <FormMessage className="font-light text-xs" />

                        <FormControl>
                          <Input
                            {...field}
                            className="h-8"
                            value={field.value ?? "∞"}
                            disabled={
                              (index !== 0 && isLastRow) || fields.length === 1 || isDisabled
                            }
                            onChange={(e) => {
                              const next = e.target.value
                              field.onChange(next)

                              // keep the next tier's firstUnit in sync (= this lastUnit + 1)
                              if (!isLastRow && next !== "" && next !== "∞") {
                                const parsed = Number(next)
                                if (!Number.isNaN(parsed)) {
                                  form.setValue(`config.tiers.${index + 1}.firstUnit`, parsed + 1)
                                }
                              }
                            }}
                          />
                        </FormControl>
                      </FormItem>
                    )
                  }}
                />
              </div>
              <div>
                <FormField
                  control={form.control}
                  key={field.id}
                  name={`config.tiers.${index}.flatPrice.displayAmount`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={cn(index !== 0 && "sr-only")}>
                        <Tooltip>
                          <div className="flex items-center justify-center gap-2 font-normal text-xs">
                            Flat Fee
                            <span>
                              <TooltipTrigger asChild>
                                <HelpCircle className="h-4 w-4 font-light" />
                              </TooltipTrigger>
                            </span>
                          </div>

                          <TooltipContent
                            className="w-40 bg-background-bg font-normal text-xs"
                            align="center"
                          >
                            Fixed charge added when this tier is reached, on top of per-unit costs.
                            <TooltipArrow className="fill-background-bg" />
                          </TooltipContent>
                        </Tooltip>
                      </FormLabel>

                      <FormMessage className="font-light text-xs" />

                      <FormControl>
                        <div className="relative">
                          <DollarSignIcon className="absolute top-2 left-2 h-4 w-4 text-muted-foreground" />
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            disabled={isDisabled}
                            onChange={(e) => {
                              field.onChange(e.target.value)

                              // if the value is empty, set the flatPrice to null
                              if (e.target.value === "") {
                                form.setValue(
                                  `config.tiers.${index}.flatPrice.displayAmount`,
                                  "0.00"
                                )
                              }
                            }}
                            className="h-8 pl-8"
                          />
                        </div>
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <div>
                <FormField
                  control={form.control}
                  key={field.id}
                  name={`config.tiers.${index}.unitPrice.displayAmount`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={cn(index !== 0 && "sr-only")}>
                        <Tooltip>
                          <div className="flex items-center justify-center gap-2 font-normal text-xs">
                            Unit Price
                            <span>
                              <TooltipTrigger asChild>
                                <HelpCircle className="h-4 w-4 font-light" />
                              </TooltipTrigger>
                            </span>
                          </div>

                          <TooltipContent
                            className="w-40 bg-background-bg font-normal text-xs"
                            align="center"
                          >
                            Cost per unit within this tier. Multiplied by quantity used.
                            <TooltipArrow className="fill-background-bg" />
                          </TooltipContent>
                        </Tooltip>
                      </FormLabel>

                      <FormMessage className="font-light text-xs" />

                      <FormControl>
                        <div className="relative">
                          <DollarSignIcon className="absolute top-2 left-2 h-4 w-4 text-muted-foreground" />
                          <Input {...field} className="h-8 pl-8" disabled={isDisabled} />
                        </div>
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <div>
                <Button
                  variant="link"
                  size={"icon"}
                  className="h-8 w-8 rounded-full"
                  disabled={isDisabled}
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    if (fields.length === 1) return

                    // change last unit of the previous tier to the last unit of the current tier
                    form.setValue(
                      `config.tiers.${index - 1}.lastUnit`,
                      form.getValues(`config.tiers.${index}.lastUnit`)
                    )

                    remove(index)
                  }}
                >
                  <XCircle className="h-5 w-5" />
                  <span className="sr-only">delete tier</span>
                </Button>
              </div>
            </div>
          ))}
          <div className="w-full px-2 py-4">
            <div className="flex justify-end">
              <Button
                variant="default"
                size={"sm"}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()

                  if (isDisabled) return

                  const firstUnitValue = Number(
                    form.getValues(`config.tiers.${fields.length - 1}.firstUnit`)
                  )

                  const lastUnitValue = form.getValues(`config.tiers.${fields.length - 1}.lastUnit`)

                  form.setValue(
                    `config.tiers.${fields.length - 1}.lastUnit`,
                    lastUnitValue ?? firstUnitValue + 1
                  )

                  append({
                    firstUnit:
                      lastUnitValue === null ? firstUnitValue + 2 : (lastUnitValue ?? 0) + 1,
                    lastUnit: null,
                    unitPrice: {
                      displayAmount: "0.00",
                      dinero: {
                        amount: 0,
                        currency: {
                          code: currency,
                          base: 10,
                          exponent: 2,
                        },
                        scale: 2,
                      },
                    },
                    flatPrice: {
                      displayAmount: "0.00",
                      dinero: {
                        amount: 0,
                        currency: {
                          code: currency,
                          base: 10,
                          exponent: 2,
                        },
                        scale: 2,
                      },
                    },
                  })
                }}
              >
                <Plus className="h-3 w-3" />
                <span className="ml-2">add tier</span>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center p-4">
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <div className="grid gap-2">
                <p className="self-center font-semibold text-sm">No tiers</p>
                <p className="justify-center font-normal text-muted-foreground text-xs leading-snug">
                  Something went wrong, please add the first tier.
                </p>
                <Button
                  variant="default"
                  size={"sm"}
                  className="py-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    append({
                      firstUnit: 1,
                      lastUnit: null,
                      unitPrice: {
                        displayAmount: "0.00",
                        dinero: {
                          amount: 0,
                          currency: {
                            code: currency,
                            base: 10,
                            exponent: 2,
                          },
                          scale: 2,
                        },
                      },
                      flatPrice: {
                        displayAmount: "0.00",
                        dinero: {
                          amount: 0,
                          currency: {
                            code: currency,
                            base: 10,
                            exponent: 2,
                          },
                          scale: 2,
                        },
                      },
                    })
                  }}
                >
                  Add first tier
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
