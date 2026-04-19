"use client"

import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import { dinero, toDecimal } from "dinero.js"
import { CalendarClock, EyeOff, RotateCw, Settings, Trash2, X, Zap } from "lucide-react"
import type React from "react"
import type { ElementRef } from "react"
import { forwardRef, useState } from "react"

import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { currencySymbol } from "@unprice/money"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { cn, focusRing } from "@unprice/ui/utils"

import { Ping } from "~/components/ping"
import {
  useActiveFeature,
  useActivePlanVersion,
  usePlanFeaturesList,
  usePlanVersionFeatureOpen,
} from "~/hooks/use-features"
import { useTRPC } from "~/trpc/client"
import { PlanVersionFeatureSheet } from "../[planSlug]/_components/plan-version-feature-sheet"
import { FeatureDialog } from "./feature-dialog"

import { useMutation } from "@tanstack/react-query"
import { Tooltip, TooltipArrow, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"

const featureVariants = cva(
  "flex gap-2 rounded-lg border text-left text-sm transition-all bg-background-bgSubtle hover:bg-background-bgHover",
  {
    variants: {
      variant: {
        feature: "h-10 px-2 items-center disabled:opacity-50",
        default: "flex-col items-start p-3",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface FeaturePlanProps
  extends React.ComponentPropsWithoutRef<"div">,
    VariantProps<typeof featureVariants> {
  planFeatureVersion: PlanVersionFeatureDragDrop
  mode: "Feature" | "FeaturePlan"
  disabled?: boolean
}

const FeaturePlan = forwardRef<ElementRef<"div">, FeaturePlanProps>((props, ref) => {
  const { mode, variant, className, planFeatureVersion, ...rest } = props

  const [isDelete, setConfirmDelete] = useState<boolean>(false)

  const [active, setActiveFeature] = useActiveFeature()
  const [activePlanVersion] = useActivePlanVersion()
  const [planVersionFeatureOpen] = usePlanVersionFeatureOpen()
  const [, setPlanFeaturesList] = usePlanFeaturesList()
  const trpc = useTRPC()

  const removePlanVersionFeature = useMutation(trpc.planVersionFeatures.remove.mutationOptions())

  const feature = planFeatureVersion.feature

  const handleClick = (_event: React.MouseEvent<HTMLDivElement>) => {
    if (planVersionFeatureOpen || mode !== "FeaturePlan") return
    setActiveFeature(planFeatureVersion)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      if (planVersionFeatureOpen || mode !== "FeaturePlan") return

      setActiveFeature(planFeatureVersion)
    }
  }

  const isPublished = activePlanVersion?.status === "published"

  return (
    <div
      ref={planVersionFeatureOpen ? undefined : ref}
      {...rest}
      className={cn(
        featureVariants({ variant, className }),
        {
          "relative z-0 border-2 border-background-borderHover bg-background-bgHover shadow-sm":
            mode === "FeaturePlan" && active?.featureId === planFeatureVersion.featureId,
        },
        focusRing
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown} // Add onKeyDown event listener
      // biome-ignore lint/a11y/useSemanticElements: <explanation>
      role="button" // Add the role attribute to indicate interactive nature
      tabIndex={0} // Add tabIndex to make it focusable
    >
      {mode === "Feature" ? (
        <div className="flex flex-row items-center gap-2">
          <FeatureDialog defaultValues={feature}>
            <Button variant="link" size={"icon"}>
              <Settings className="h-4 w-4" />
            </Button>
          </FeatureDialog>

          <span className={cn("line-clamp-1 w-full font-medium text-sm")}>
            {`${
              feature.title.length > 10
                ? `${feature.title.substring(0, 10)}...`
                : feature.title.substring(0, 10)
            }`}
          </span>
        </div>
      ) : mode === "FeaturePlan" ? (
        <PlanVersionFeatureSheet planFeatureVersion={planFeatureVersion}>
          <div className="flex w-full flex-col gap-2">
            <div className="flex w-full flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="flex flex-row gap-2">
                  <div className="line-clamp-1 items-center gap-1 text-left font-bold">
                    {feature.slug}
                  </div>
                  {/* // If there is no id it means that the feature is not saved yet */}
                  {!planFeatureVersion?.id && (
                    <div className="relative">
                      <div className="1right-1 absolute top-2">
                        <Ping variant={"destructive"} />
                      </div>
                    </div>
                  )}
                  {planFeatureVersion.metadata?.hidden && (
                    <Tooltip>
                      <div className="flex items-center justify-center gap-2 font-normal text-xs">
                        <span>
                          <TooltipTrigger asChild>
                            <EyeOff className="h-4 w-4 text-muted-foreground" />
                          </TooltipTrigger>
                        </span>
                      </div>

                      <TooltipContent
                        className="bg-background-bg font-normal text-xs"
                        align="center"
                      >
                        This feature is hidden in the pricing card.
                        <TooltipArrow className="fill-background-bg" />
                      </TooltipContent>
                    </Tooltip>
                  )}

                  {planFeatureVersion.featureType === "usage" &&
                    activePlanVersion?.billingConfig.name !==
                      planFeatureVersion.billingConfig.name && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center justify-center rounded-md bg-secondary p-1 text-secondary-foreground">
                            <CalendarClock className="h-3 w-3" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent
                          className="bg-background-bg font-normal text-xs"
                          align="center"
                        >
                          Billing: {planFeatureVersion.billingConfig.name}
                          <TooltipArrow className="fill-background-bg" />
                        </TooltipContent>
                      </Tooltip>
                    )}
                  {planFeatureVersion.featureType === "usage" &&
                    planFeatureVersion.resetConfig?.name &&
                    planFeatureVersion.resetConfig.name !==
                      activePlanVersion?.billingConfig?.name && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center justify-center rounded-md bg-secondary p-1 text-secondary-foreground">
                            <RotateCw className="h-3 w-3" />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent
                          className="bg-background-bg font-normal text-xs"
                          align="center"
                        >
                          Resets: {planFeatureVersion.resetConfig.name}
                          <TooltipArrow className="fill-background-bg" />
                        </TooltipContent>
                      </Tooltip>
                    )}

                  {planFeatureVersion.metadata?.realtime && (
                    <Tooltip>
                      <div className="flex items-center justify-center gap-2 font-normal text-xs">
                        <span>
                          <TooltipTrigger asChild>
                            <Zap className="h-4 w-4 text-warning" />
                          </TooltipTrigger>
                        </span>
                      </div>

                      <TooltipContent
                        className="bg-background-bg font-normal text-xs"
                        align="center"
                      >
                        This feature is reporting usage in realtime.
                        <TooltipArrow className="fill-background-bg" />
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <div className="flex- flex-row gap-1">
                    {!isPublished && isDelete && (
                      <div className="flex flex-row items-center">
                        <Button
                          className="px-0 font-light text-xs"
                          variant="link"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            setConfirmDelete(false)
                          }}
                        >
                          cancel
                          <span className="sr-only">cancel delete from plan</span>
                        </Button>
                        <Button
                          className="px-0"
                          variant="link"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()

                            if (active?.id === feature.id) {
                              setActiveFeature(null)
                            }

                            if (planFeatureVersion.id) {
                              // delete from plan
                              void removePlanVersionFeature.mutateAsync({
                                id: planFeatureVersion.id,
                              })
                            }

                            // delete feature from the list in the drag and drop
                            setPlanFeaturesList((features) => {
                              const filteredFeatures = features.filter(
                                (f) => f.featureId !== feature.id
                              )

                              return filteredFeatures
                            })

                            setConfirmDelete(false)
                          }}
                        >
                          <X className="h-4 w-4" />
                          <span className="sr-only">Confirm delete from plan</span>
                        </Button>
                      </div>
                    )}
                    {!isPublished && !isDelete && (
                      <Button
                        className="px-0"
                        variant="link"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          setConfirmDelete(true)
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        <span className="sr-only">Delete from plan</span>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="line-clamp-1 font-normal text-muted-foreground text-xs">
              {feature.description ?? "No description"}
            </div>

            <div className="mt-2 hidden w-full flex-row items-center justify-between gap-2 md:flex">
              <div className="flex flex-row gap-1">
                <Badge>{planFeatureVersion.featureType}</Badge>
                {planFeatureVersion.config.usageMode && (
                  <Badge>{planFeatureVersion.config.usageMode}</Badge>
                )}
              </div>
              <div className="line-clamp-1 pr-3 font-light text-xs">
                {/* // TODO: fix this */}
                {planFeatureVersion?.config?.price
                  ? `${
                      planFeatureVersion?.config?.price.dinero.amount === 0
                        ? "Free"
                        : planFeatureVersion?.config?.units
                          ? `${toDecimal(
                              dinero(planFeatureVersion?.config?.price.dinero),
                              ({ value, currency }) => `${currencySymbol(currency.code)}${value}`
                            )} per ${planFeatureVersion?.config?.units} ${planFeatureVersion?.unitOfMeasure ?? "units"}`
                          : toDecimal(
                              dinero(planFeatureVersion?.config?.price.dinero),
                              ({ value, currency }) => `${currencySymbol(currency.code)}${value}`
                            )
                    }`
                  : planFeatureVersion.config?.tiers?.length?.toString()
                    ? `${planFeatureVersion?.config?.tiers?.length ?? 0} tiers`
                    : null}
              </div>
            </div>
          </div>
        </PlanVersionFeatureSheet>
      ) : null}
    </div>
  )
})

FeaturePlan.displayName = "FeatureCard"

export { FeaturePlan }
