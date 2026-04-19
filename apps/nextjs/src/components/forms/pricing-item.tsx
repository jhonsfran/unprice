"use client"

import { FEATURE_TYPES_MAPS, TIER_MODES_MAP, USAGE_MODES_MAP } from "@unprice/db/utils"

import { nFormatter } from "@unprice/db/utils"
import {
  type PlanVersionExtended,
  calculateFreeUnits,
  calculatePricePerFeature,
} from "@unprice/db/validators"
import { currencySymbol } from "@unprice/money"
import { CheckIcon, HelpCircle } from "@unprice/ui/icons"
import { Slider } from "@unprice/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { useMemo, useState } from "react"
import { useDebounce } from "~/hooks/use-debounce"

export function PricingItem({
  feature,
  withCalculator,
  withQuantity,
  onQuantityChange,
  noCheckIcon = false,
  noTitle = false,
  className,
}: {
  feature: PlanVersionExtended["planFeatures"][number]
  withCalculator?: boolean
  withQuantity?: boolean
  onQuantityChange?: (quantity: number) => void
  noCheckIcon?: boolean
  noTitle?: boolean
  className?: string
}) {
  const defaultQuantity = feature.defaultQuantity ?? 1
  const [quantity, setQuantity] = useState<number>(defaultQuantity)
  const quantityDebounce = useDebounce(quantity, 100)

  const { err, val: pricePerFeature } = useMemo(
    () =>
      calculatePricePerFeature({
        config: feature.config!,
        featureType: feature.featureType,
        quantity: quantityDebounce,
      }),
    [quantityDebounce, feature.id]
  )

  if (err) {
    return (
      <div className="inline text-muted-foreground text-xs italic">error calculating price</div>
    )
  }

  let displayFeature = ""
  const calculatorParams = {
    max: 100,
    min: 1,
    step: 1,
    value: quantityDebounce,
    onValueChange: (value: number) => {
      setQuantity(value)
      onQuantityChange?.(value)
    },
  }

  const { val: freeUnits, err: freeUnitsErr } = calculateFreeUnits({
    config: feature.config!,
    featureType: feature.featureType,
  })

  if (freeUnitsErr) {
    console.error(freeUnitsErr)
    return "error calculating free units"
  }

  // if the feature is usage and the feature slug does not include the unit, we don't show the units
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

  switch (feature.featureType) {
    case "flat": {
      displayFeature = `${feature.feature.title}`
      break
    }

    case "tier": {
      const lastTier = feature.config?.tiers![feature.config.tiers!.length - 1]
      displayFeature = withQuantity
        ? `${freeUnitsText} ${feature.feature.title}`
        : feature.feature.title
      calculatorParams.max = feature.limit ?? lastTier?.lastUnit ?? 100000
      break
    }

    case "usage": {
      displayFeature = withQuantity
        ? `${freeUnitsText} ${feature.feature.title}`
        : feature.feature.title
      calculatorParams.max = feature.limit ?? 100000

      if (feature.config?.usageMode === "tier") {
        const lastTier = feature.config?.tiers![feature.config.tiers!.length - 1]
        calculatorParams.max = feature.limit ?? lastTier?.lastUnit ?? 100000
      }

      break
    }

    case "package": {
      displayFeature = withQuantity
        ? `${freeUnitsText} ${feature.feature.title}`
        : feature.feature.title
      calculatorParams.max = feature.config?.units! * 10
      break
    }
  }

  return (
    <div className="flex flex-row items-center gap-1">
      {!noCheckIcon && (
        <div className="flex justify-start">
          <CheckIcon className="mr-1 h-5 w-5 text-success" />
        </div>
      )}
      <div className="flex w-full items-center gap-1">
        {!noTitle && (
          <span className={cn("font-light text-muted-foreground text-xs", className)}>
            {displayFeature}
          </span>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <HelpCircle className="size-3.5 font-light text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent align="end" side="right" sideOffset={10} alignOffset={-5}>
            <div className="flex w-[300px] flex-col gap-2 p-2">
              <Typography variant="h6" affects="removePaddingMargin">
                Feature type {feature.featureType} {feature.config?.usageMode}
              </Typography>

              <Typography
                variant="p"
                affects="removePaddingMargin"
                className="text-background-solidHover"
              >
                {feature.feature.description}
              </Typography>

              <Typography
                variant="p"
                affects="removePaddingMargin"
                className="font-light text-xs italic"
              >
                {feature.featureType && `* ${FEATURE_TYPES_MAPS[feature.featureType].description}`}{" "}
                {feature.featureType && <br />}
                {feature.config?.tierMode &&
                  `* ${TIER_MODES_MAP[feature.config.tierMode].description}`}{" "}
                {feature.config?.tierMode && <br />}
                {feature.config?.usageMode &&
                  `* ${USAGE_MODES_MAP[feature.config.usageMode].description}`}{" "}
                {feature.config?.usageMode && <br />}
              </Typography>

              {(feature.featureType === "tier" || feature.config?.usageMode === "tier") && (
                <div className="mt-2 mb-2">
                  <Typography
                    variant="p"
                    affects="removePaddingMargin"
                    className="mb-1 font-medium text-xs"
                  >
                    Tier Pricing:
                  </Typography>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="py-1 text-left">Units</th>
                        <th className="py-1 text-right">Flat Price</th>
                        <th className="py-1 text-right">Unit Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feature.config?.tiers?.map((tier, index) => (
                        <tr key={index.toString()} className="border-b last:border-b-0">
                          <td className="py-1">
                            {tier.firstUnit} - {tier.lastUnit ?? feature.limit ?? "∞"}
                          </td>
                          {/* this prices can be decimals, so we dont format them */}
                          <td className="py-1 text-right">
                            {currencySymbol(tier.flatPrice.dinero.currency.code)}
                            {tier.flatPrice.displayAmount}
                          </td>
                          {/* this prices can be decimals, so we dont format them */}
                          <td className="py-1 text-right">
                            {currencySymbol(tier.unitPrice.dinero.currency.code)}
                            {tier.unitPrice.displayAmount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {feature.featureType !== "tier" && feature.config?.usageMode !== "tier" && (
                <div className="mt-2 mb-2">
                  <Typography
                    variant="p"
                    affects="removePaddingMargin"
                    className="mb-1 font-medium text-xs"
                  >
                    Pricing:
                  </Typography>
                  <span className="text-xs">{pricePerFeature.unitPrice.displayAmount}</span>
                </div>
              )}

              {withCalculator && ["usage", "tier", "package"].includes(feature.featureType) && (
                <div className="mb-2">
                  <Typography
                    variant="p"
                    affects="removePaddingMargin"
                    className="mb-1 font-medium text-xs"
                  >
                    Tier Calculator:
                  </Typography>

                  <span className="text-xs">
                    Total price per {nFormatter(quantity)} {feature.feature.title} is{" "}
                    {pricePerFeature.totalPrice.displayAmount}
                  </span>

                  <PriceCalculator {...calculatorParams} />
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

const PriceCalculator = ({
  max,
  min,
  step,
  value,
  onValueChange,
}: {
  max: number
  min: number
  step: number
  value: number
  onValueChange: (value: number) => void
}) => {
  return (
    <div className="my-2 flex items-center">
      <Slider
        max={max}
        min={min}
        step={step}
        size="sm"
        className="my-2"
        defaultValue={[value]}
        onValueChange={([sliderValue]) => onValueChange(sliderValue ?? 1)}
      />
      <span className="ml-4 w-[15%] font-bold text-sm">{nFormatter(value)}</span>
    </div>
  )
}
