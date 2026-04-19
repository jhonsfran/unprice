"use client"
import * as currencies from "dinero.js/currencies"
import { AnimatePresence, motion } from "framer-motion"
import { ChevronDown, LayoutGrid, Settings, Trash2, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  type ArrayPath,
  type FieldArray,
  type FieldArrayPath,
  type FieldArrayWithId,
  type FieldErrors,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
  useFieldArray,
} from "react-hook-form"

import { nFormatter } from "@unprice/db/utils"
import type {
  Currency,
  SubscriptionItem,
  SubscriptionItemConfig,
  SubscriptionItemsConfig,
} from "@unprice/db/validators"
import {
  calculateFreeUnits,
  calculatePricePerFeature,
  createDefaultSubscriptionConfig,
  getBillingCycleMessage,
} from "@unprice/db/validators"
import { currencySymbol } from "@unprice/money"
import type { RouterOutputs } from "@unprice/trpc/routes"
import { Button } from "@unprice/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@unprice/ui/dialog"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@unprice/ui/form"
import { Input } from "@unprice/ui/input"
import { Separator } from "@unprice/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@unprice/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { type Dinero, add, dinero, toDecimal } from "dinero.js"
import { FeatureConfigForm } from "~/app/(root)/dashboard/[workspaceSlug]/[projectSlug]/plans/[planSlug]/_components/feature-config-form"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { PriceFeature } from "~/components/forms/price-feature"
import { PricingItem } from "~/components/forms/pricing-item"
import { PropagationStopper } from "~/components/prevent-propagation"
import { capitalize } from "~/lib/capitalize"

type PlanVersionFeaturesResponse =
  RouterOutputs["planVersions"]["listByActiveProject"]["planVersions"][0]["planFeatures"][0]

interface FormValues extends FieldValues {
  config?: SubscriptionItemsConfig
  planVersionId: string
  items?: SubscriptionItem[]
}

export default function ConfigItemsFormField<TFieldValues extends FormValues>({
  form,
  isDisabled,
  withSeparator,
  withFeatureDetails,
  planVersions,
  isLoading,
}: {
  form: UseFormReturn<TFieldValues>
  isDisabled?: boolean
  withSeparator?: boolean
  withFeatureDetails?: boolean
  planVersions: RouterOutputs["planVersions"]["listByActiveProject"]["planVersions"]
  isLoading?: boolean
}) {
  const planVersionId = form.watch("planVersionId" as FieldPath<TFieldValues>)
  const itemsSubs = form.watch("items" as FieldPath<TFieldValues>)

  // TODO: use later for addons support
  const isSubscriptionTypeAddons = false

  const selectedPlanVersion = planVersions.find((version) => version.id === planVersionId)

  const items = useFieldArray({
    control: form.control,
    name: "config" as FieldArrayPath<TFieldValues>,
  })

  type ConfigFieldName<T> = "config" extends ArrayPath<T> ? "config" : never

  const fields = items.fields as FieldArrayWithId<
    TFieldValues,
    ConfigFieldName<TFieldValues>,
    "id"
  >[]

  useEffect(() => {
    if (selectedPlanVersion) {
      const { err, val: itemsConfig } = createDefaultSubscriptionConfig({
        planVersion: selectedPlanVersion,
        items: itemsSubs,
      })

      if (err) {
        console.error(err)
        form.setError("config" as FieldPath<TFieldValues>, { message: err.message })
        return
      }

      form.clearErrors("config" as FieldPath<TFieldValues>)

      items.replace(itemsConfig as FieldArray<TFieldValues, ArrayPath<TFieldValues>>[])
    }
  }, [selectedPlanVersion?.id])

  const { versionFeatures, versionAddons } = useMemo(() => {
    const features = new Map<string, PlanVersionFeaturesResponse>()
    const addons = new Map<string, PlanVersionFeaturesResponse>()

    selectedPlanVersion?.planFeatures.forEach((feature) => {
      features.set(feature.id, feature)
      addons.set(feature.id, feature)
    })

    return { versionFeatures: features, versionAddons: addons }
  }, [selectedPlanVersion?.id])

  const [isExpanded, setIsExpanded] = useState(false)

  const [isDelete, setConfirmDelete] = useState<Map<string, boolean>>(
    new Map<string, boolean>(fields.map((item) => [item.id, false] as [string, boolean]))
  )

  const { errors } = form.formState

  const getErrorMessage = (
    errors: FieldErrors<TFieldValues>,
    field: string
  ): string | undefined => {
    const error = errors[field as keyof typeof errors]
    return error && typeof error === "object" && "message" in error
      ? (error.message as string)
      : undefined
  }

  const configValues = form.watch("config" as FieldPath<TFieldValues>)

  // calculate the total price for the plan
  const displayTotalPrice = useMemo(() => {
    if (!selectedPlanVersion || !configValues) return ""

    const initialTotal = dinero({
      amount: 0,
      currency: currencies[selectedPlanVersion.currency],
    })

    let hasUsage = false

    const totalPrice = configValues.reduce(
      (total: Dinero<number>, field: SubscriptionItemConfig) => {
        const feature = versionFeatures.get(field.featurePlanId)

        if (!feature) return total

        if (feature.featureType === "usage") {
          hasUsage = true
        }

        const { val: price, err } = calculatePricePerFeature({
          quantity: field.units ?? 0,
          featureType: feature.featureType,
          config: feature.config!,
        })

        if (err) return total

        return add(total, price.totalPrice.dinero)
      },
      initialTotal
    )

    return toDecimal(totalPrice, ({ value, currency }) => {
      if (hasUsage) {
        return `${currencySymbol(currency.code as Currency)}${Number.parseFloat(value).toFixed(
          2
        )} + usage`
      }

      return `${currencySymbol(currency.code as Currency)}${Number.parseFloat(value).toFixed(2)}`
    })
  }, [JSON.stringify(configValues)])

  return (
    <div className="flex w-full flex-col gap-4">
      {withSeparator && <Separator className="my-2" />}

      <div className="flex flex-col items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className={cn("gap-2 text-muted-foreground hover:text-foreground", {
            "border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive":
              errors.config,
          })}
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? "Hide features configuration" : "Configure features"}
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", {
              "rotate-180": isExpanded,
            })}
          />
        </Button>
        {errors.config && !isExpanded && (
          <span className="text-destructive text-xs">
            {getErrorMessage(errors, "config") ?? "Invalid configuration"}
          </span>
        )}
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mb-4 flex flex-col gap-2 pt-2">
              <FormLabel
                className={cn({
                  "text-destructive": errors.config,
                })}
              >
                <Typography variant="h5">Features configuration</Typography>
              </FormLabel>

              <FormDescription>
                Configure the quantity for each feature, for usage based feature, the price will be
                calculated with the reported usage. You can't change the quantity for flat features"
              </FormDescription>
              {errors.config && <FormMessage>{getErrorMessage(errors, "config")}</FormMessage>}
            </div>

            <div className="flex items-center justify-center px-1 py-2">
              {fields.length > 0 ? (
                <Table>
                  <TableHeader className="border-t border-b bg-transparent">
                    <TableRow className="pointer-events-none">
                      <TableHead className="h-10 pl-1">Features</TableHead>
                      <TableHead className="h-10 px-0 text-center">Quantity Units</TableHead>
                      <TableHead
                        className={cn("h-10 text-end", {
                          "pr-1": !isSubscriptionTypeAddons,
                          "pr-8": isSubscriptionTypeAddons,
                        })}
                      >
                        Estimated Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((item, index) => {
                      const itemConfig = item as unknown as SubscriptionItemConfig & { id: string }

                      const feature =
                        versionFeatures.get(itemConfig.featurePlanId) ??
                        versionAddons.get(itemConfig.featurePlanId)

                      // if the feature is hidden, don't show it
                      if (!feature) return null

                      // if the units are not set, use the minimum units
                      const units =
                        form.watch(`config.${index}.units` as FieldPath<TFieldValues>) ||
                        itemConfig.min ||
                        0

                      const { val: freeUnits, err: freeUnitsErr } = calculateFreeUnits({
                        config: feature.config!,
                        featureType: feature.featureType,
                      })

                      if (freeUnitsErr) {
                        console.error(freeUnitsErr)
                        return "error calculating free units"
                      }

                      const showUnits =
                        feature.featureType === "usage" &&
                        !feature.feature.slug.includes(feature.unitOfMeasure ?? "units")

                      const freeUnitsText =
                        freeUnits === Number.POSITIVE_INFINITY
                          ? feature.limit
                            ? `Up to ${nFormatter(feature.limit)} ${showUnits ? (feature.unitOfMeasure ?? "units") : ""}`
                            : "Unlimited"
                          : freeUnits === 0
                            ? feature.limit
                              ? `Up to ${nFormatter(feature.limit)} ${showUnits ? (feature.unitOfMeasure ?? "units") : ""}`
                              : "Starts at 0"
                            : `${nFormatter(freeUnits)} ${showUnits ? (feature.unitOfMeasure ?? "units") : ""}`

                      return (
                        <TableRow key={item.id} className="border-b bg-transparent">
                          <TableCell className="table-cell h-16 flex-row items-center gap-1 pl-1">
                            <div className="flex items-center justify-start gap-1">
                              {withFeatureDetails && (
                                <PropagationStopper className="flex items-center justify-start">
                                  <Dialog>
                                    <DialogTrigger asChild>
                                      <Button className="mr-1 size-4" variant="link" size="icon">
                                        <Settings className="size-4" />
                                        <span className="sr-only">View feature</span>
                                      </Button>
                                    </DialogTrigger>

                                    <DialogContent className="flex max-h-[800px] w-full flex-col justify-between overflow-y-scroll md:w-1/2 lg:w-[600px]">
                                      <DialogHeader>
                                        <DialogTitle>Feature: {feature.feature.title}</DialogTitle>
                                      </DialogHeader>
                                      <DialogDescription>
                                        {feature.feature.description ?? ""}
                                      </DialogDescription>
                                      <FeatureConfigForm
                                        defaultValues={feature}
                                        planVersion={selectedPlanVersion!}
                                        className="my-6"
                                      />
                                    </DialogContent>
                                  </Dialog>
                                </PropagationStopper>
                              )}
                              <PricingItem
                                feature={feature}
                                withCalculator
                                noCheckIcon
                                withQuantity={false}
                              />
                            </div>
                          </TableCell>
                          <TableCell className="table-cell">
                            {feature.featureType === "usage" ? (
                              <div className="text-center text-xs">{freeUnitsText}</div>
                            ) : feature.featureType === "flat" ? (
                              <div className="text-center text-xs">{itemConfig.units}</div>
                            ) : (
                              <FormField
                                control={form.control}
                                name={`config.${index}.units` as FieldPath<TFieldValues>}
                                render={({ field }) => (
                                  <FormItem className="justify-center text-center">
                                    <FormMessage className="font-light text-xs" />
                                    <FormControl>
                                      <div className="flex flex-col">
                                        <Input
                                          {...field}
                                          type="number"
                                          min={1}
                                          className="mx-auto h-8 w-20 text-center text-xs"
                                          disabled={
                                            feature.featureType === "flat" ||
                                            feature.featureType === "usage" ||
                                            isDisabled
                                          }
                                          value={field.value ?? ""}
                                        />
                                      </div>
                                    </FormControl>
                                  </FormItem>
                                )}
                              />
                            )}
                          </TableCell>
                          <TableCell className="flex h-16 items-center justify-end gap-1 pr-1">
                            <PriceFeature quantity={units || 0} feature={feature} type="total" />
                            {isSubscriptionTypeAddons && isDelete.get(itemConfig.featurePlanId) && (
                              <div className="flex flex-row items-center">
                                <Button
                                  className="px-0"
                                  variant="link"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    e.preventDefault()
                                    items.remove(index)

                                    setConfirmDelete(
                                      (prev) => new Map(prev.set(itemConfig.featurePlanId, false))
                                    )
                                  }}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                            {isSubscriptionTypeAddons &&
                              !isDelete.get(itemConfig.featurePlanId) && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      className="px-0"
                                      variant="link"
                                      size="icon"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        e.preventDefault()
                                        setConfirmDelete(
                                          (prev) =>
                                            new Map(prev.set(itemConfig.featurePlanId, true))
                                        )

                                        setTimeout(() => {
                                          setConfirmDelete(
                                            (prev) =>
                                              new Map(prev.set(itemConfig.featurePlanId, false))
                                          )
                                        }, 2000)
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <div className="max-w-[200px] text-sm">
                                      remove this addon from the subscription
                                    </div>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                          </TableCell>
                        </TableRow>
                      )
                    })}

                    <TableRow className="border-t border-b text-muted-foreground">
                      <TableCell colSpan={2} className="h-10 gap-1 pl-1 text-left font-semibold">
                        {capitalize(
                          getBillingCycleMessage(selectedPlanVersion?.billingConfig!).message
                        )}
                      </TableCell>
                      <TableCell colSpan={1} className="h-10 text-right text-xs">
                        {displayTotalPrice}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              ) : (
                <div className="flex w-full items-center justify-center px-1 py-2">
                  <EmptyPlaceholder isLoading={isLoading} className="min-h-[200px]">
                    <EmptyPlaceholder.Icon>
                      <LayoutGrid className="h-8 w-8" />
                    </EmptyPlaceholder.Icon>
                    <EmptyPlaceholder.Title>No plan selected</EmptyPlaceholder.Title>
                    <EmptyPlaceholder.Description>
                      Select a plan to configure the items
                    </EmptyPlaceholder.Description>
                  </EmptyPlaceholder>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
