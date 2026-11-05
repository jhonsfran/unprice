"use client"

import { FEATURE_TYPES_MAPS, USAGE_MODES_MAP, nFormatter } from "@unprice/db/utils"
import type { PlanVersionExtended } from "@unprice/db/validators"
import { CheckIcon, HelpCircle } from "@unprice/ui/icons"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"

export type PlanVersionFeatureListItemDisplayOptions = {
  showQuantity?: boolean
  showCheckIcon?: boolean
  showTitle?: boolean
}

/**
 * A plan feature as a pricing card lists it. Its price comes from the plan version's rate card
 * (ADR-0008 D2) as `displayPrice`; the feature itself stores none.
 */
export function PlanVersionFeatureListItem({
  feature,
  displayOptions,
  className,
}: {
  feature: PlanVersionExtended["planFeatures"][number] & { displayPrice?: string | null }
  displayOptions?: PlanVersionFeatureListItemDisplayOptions
  className?: string
}) {
  const { showQuantity = false, showCheckIcon = true, showTitle = true } = displayOptions ?? {}

  const unit = feature.unitOfMeasure ?? "units"
  const unitText =
    feature.featureType === "usage" && !feature.feature.slug.includes(unit) ? ` ${unit}` : ""
  const included = Number(feature.included ?? 0)
  const allowance =
    included > 0
      ? `${nFormatter(included)}${unitText} included,`
      : feature.limit
        ? `Up to ${nFormatter(feature.limit)}${unitText}`
        : "Unlimited"
  const displayFeature =
    feature.featureType === "flat" || !showQuantity
      ? feature.feature.title
      : `${allowance} ${feature.feature.title}`

  return (
    <div className="flex flex-row items-center gap-1">
      {showCheckIcon && (
        <div className="flex justify-start">
          <CheckIcon className="mr-1 h-5 w-5 text-success" />
        </div>
      )}
      <div className="flex w-full items-center gap-1">
        {showTitle && (
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
                {feature.config?.usageMode &&
                  `* ${USAGE_MODES_MAP[feature.config.usageMode].description}`}{" "}
                {feature.config?.usageMode && <br />}
              </Typography>

              <div className="mt-2 mb-2">
                <Typography
                  variant="p"
                  affects="removePaddingMargin"
                  className="mb-1 font-medium text-xs"
                >
                  Priced by card:
                </Typography>
                <span className="font-mono text-xs">{feature.displayPrice ?? "not priced"}</span>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
