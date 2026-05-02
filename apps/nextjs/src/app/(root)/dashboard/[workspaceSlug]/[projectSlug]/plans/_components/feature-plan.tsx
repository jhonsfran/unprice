"use client"

import { useMutation } from "@tanstack/react-query"
import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"
import { dinero, toDecimal } from "dinero.js"
import {
  CalendarClock,
  ChevronRight,
  EyeOff,
  Plus,
  RotateCw,
  Settings,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import type React from "react"
import type { ElementRef } from "react"
import { forwardRef, useState } from "react"

import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { currencySymbol } from "@unprice/money"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Tooltip, TooltipArrow, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { cn, focusRing } from "@unprice/ui/utils"

import { Ping } from "~/components/ping"
import { useActiveFeature, useActivePlanVersion, usePlanFeaturesList } from "~/hooks/use-features"
import { useTRPC } from "~/trpc/client"
import { FeatureConfigForm } from "../[planSlug]/_components/feature-config-form"
import { FeatureDialog } from "./feature-dialog"

const featureVariants = cva(
  "rounded-lg border text-left text-sm transition-all bg-background-bgSubtle hover:bg-background-bgHover",
  {
    variants: {
      variant: {
        feature: "flex h-10 flex-row items-center gap-2 px-2 disabled:opacity-50",
        default: "flex flex-col",
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
  onAdd?: () => void
}

const FeaturePlan = forwardRef<ElementRef<"div">, FeaturePlanProps>((props, ref) => {
  const { mode, variant, className, planFeatureVersion, onAdd, disabled, ...rest } = props
  const feature = planFeatureVersion.feature

  const [active, setActiveFeature] = useActiveFeature()
  const [activePlanVersion] = useActivePlanVersion()
  const [, setPlanFeaturesList] = usePlanFeaturesList()
  const [isDelete, setConfirmDelete] = useState(false)
  const trpc = useTRPC()

  const removePlanVersionFeature = useMutation(trpc.planVersionFeatures.remove.mutationOptions())

  const isExpanded = mode === "FeaturePlan" && active?.featureId === planFeatureVersion.featureId
  const isPublished = activePlanVersion?.status === "published"

  const handleToggle = () => {
    if (mode !== "FeaturePlan") return
    setActiveFeature(isExpanded ? null : planFeatureVersion)
  }

  // ── Library mode: compact card with + Add ─────────────────────
  if (mode === "Feature") {
    return (
      <div
        ref={ref}
        {...rest}
        className={cn(featureVariants({ variant: "feature" }), className, {
          "pointer-events-none opacity-50": disabled,
        })}
      >
        <FeatureDialog defaultValues={feature}>
          <Button variant="link" size="icon" className="shrink-0">
            <Settings className="h-4 w-4" />
          </Button>
        </FeatureDialog>

        <span className="line-clamp-1 flex-1 font-medium text-sm">{feature.title}</span>

        {!disabled && onAdd && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 gap-1 text-xs"
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              onAdd()
            }}
          >
            <Plus className="size-3" />
            Add
          </Button>
        )}
      </div>
    )
  }

  // ── Plan mode: full card with inline expansion ────────────────
  return (
    <div
      ref={ref}
      {...rest}
      className={cn(
        featureVariants({ variant: "default" }),
        {
          "border-background-borderHover bg-background-bgHover shadow-sm": isExpanded,
        },
        focusRing,
        className
      )}
    >
      {/* clickable summary header */}
      <div
        // biome-ignore lint/a11y/useSemanticElements: header is part of a draggable surface; semantic button breaks dnd-kit pointer behavior
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            handleToggle()
          }
        }}
        className="flex w-full cursor-pointer flex-col gap-2 p-3"
      >
        <div className="flex w-full items-center justify-between">
          <div className="flex flex-row items-center gap-2">
            <ChevronRight
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                isExpanded && "rotate-90"
              )}
            />
            <div className="line-clamp-1 text-left font-bold">{feature.slug}</div>

            {!planFeatureVersion?.id && (
              <div className="relative">
                <div className="absolute top-1">
                  <Ping variant="destructive" />
                </div>
              </div>
            )}

            {planFeatureVersion.metadata?.hidden && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                  This feature is hidden in the pricing card.
                  <TooltipArrow className="fill-background-bg" />
                </TooltipContent>
              </Tooltip>
            )}

            {planFeatureVersion.featureType === "usage" &&
              activePlanVersion?.billingConfig.name !== planFeatureVersion.billingConfig.name && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center justify-center rounded-md bg-secondary p-1 text-secondary-foreground">
                      <CalendarClock className="h-3 w-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                    Billing: {planFeatureVersion.billingConfig.name}
                    <TooltipArrow className="fill-background-bg" />
                  </TooltipContent>
                </Tooltip>
              )}

            {planFeatureVersion.featureType === "usage" &&
              planFeatureVersion.resetConfig?.name &&
              planFeatureVersion.resetConfig.name !== activePlanVersion?.billingConfig?.name && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center justify-center rounded-md bg-secondary p-1 text-secondary-foreground">
                      <RotateCw className="h-3 w-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                    Resets: {planFeatureVersion.resetConfig.name}
                    <TooltipArrow className="fill-background-bg" />
                  </TooltipContent>
                </Tooltip>
              )}

            {planFeatureVersion.metadata?.realtime && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Zap className="h-4 w-4 text-warning" />
                </TooltipTrigger>
                <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                  This feature is reporting usage in realtime.
                  <TooltipArrow className="fill-background-bg" />
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {!isPublished && (
            <div className="flex items-center gap-1 text-xs">
              {isDelete ? (
                <div className="flex flex-row items-center">
                  <Button
                    className="px-1 font-light text-xs"
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
                    className="px-1"
                    variant="link"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()

                      if (active?.id === feature.id) {
                        setActiveFeature(null)
                      }

                      if (planFeatureVersion.id) {
                        void removePlanVersionFeature.mutateAsync({
                          id: planFeatureVersion.id,
                        })
                      }

                      setPlanFeaturesList((features) =>
                        features.filter((f) => f.featureId !== feature.id)
                      )

                      setConfirmDelete(false)
                    }}
                  >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Confirm delete from plan</span>
                  </Button>
                </div>
              ) : (
                <Button
                  className="px-1"
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
          )}
        </div>

        <div className="line-clamp-1 pl-6 font-normal text-muted-foreground text-xs">
          {feature.description ?? "No description"}
        </div>

        <div className="hidden w-full flex-row items-center justify-between gap-2 pl-6 md:flex">
          <div className="flex flex-row gap-1">
            <Badge>{planFeatureVersion.featureType}</Badge>
            {planFeatureVersion.config?.usageMode && (
              <Badge>{planFeatureVersion.config.usageMode}</Badge>
            )}
          </div>
          <div className="line-clamp-1 pr-3 font-light text-xs">
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
              : planFeatureVersion.config?.tiers?.length
                ? `${planFeatureVersion.config.tiers.length} tiers`
                : null}
          </div>
        </div>
      </div>

      {/* expanded inline editor */}
      {isExpanded && activePlanVersion && (
        <div
          className="border-t bg-background p-4"
          // stop click bubbling so editing inside doesn't collapse the card
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-base">{feature.title}</span>
              <FeatureDialog defaultValues={feature}>
                <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground">
                  <Settings className="h-3.5 w-3.5" />
                </Button>
              </FeatureDialog>
            </div>
            {feature.description && (
              <span className="line-clamp-1 text-muted-foreground text-xs">
                {feature.description}
              </span>
            )}
          </div>

          <FeatureConfigForm
            defaultValues={planFeatureVersion}
            planVersion={activePlanVersion}
            setDialogOpen={(open) => {
              if (!open) setActiveFeature(null)
            }}
          />
        </div>
      )}
    </div>
  )
})

FeaturePlan.displayName = "FeaturePlan"

export { FeaturePlan }
