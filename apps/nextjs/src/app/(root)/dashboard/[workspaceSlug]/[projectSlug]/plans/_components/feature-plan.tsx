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

import { FEATURE_TYPES_MAPS } from "@unprice/db/utils"
import type { PlanVersionFeatureDragDrop } from "@unprice/db/validators"
import { currencySymbol } from "@unprice/money"
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
        default: "flex flex-col overflow-hidden",
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
  /** Render slot for the drag handle (provided by SortableFeature). */
  renderDragHandle?: () => React.ReactNode
  /** Active drag state — used to collapse the expanded editor while reordering. */
  isDragging?: boolean
}

const FeaturePlan = forwardRef<ElementRef<"div">, FeaturePlanProps>((props, ref) => {
  const {
    mode,
    variant,
    className,
    planFeatureVersion,
    onAdd,
    disabled,
    renderDragHandle,
    isDragging,
    ...rest
  } = props
  const feature = planFeatureVersion.feature

  const [active, setActiveFeature] = useActiveFeature()
  const [activePlanVersion] = useActivePlanVersion()
  const [, setPlanFeaturesList] = usePlanFeaturesList()
  const [isDelete, setConfirmDelete] = useState(false)
  const trpc = useTRPC()

  const removePlanVersionFeature = useMutation(trpc.planVersionFeatures.remove.mutationOptions())

  const isExpanded = mode === "FeaturePlan" && active?.featureId === planFeatureVersion.featureId
  const isPublished = activePlanVersion?.status === "published"

  const priceSummary = (() => {
    const cfg = planFeatureVersion.config
    if (cfg?.price) {
      if (cfg.price.dinero.amount === 0) return "Free"
      const formatted = toDecimal(
        dinero(cfg.price.dinero),
        ({ value, currency }) => `${currencySymbol(currency.code)}${value}`
      )
      if (cfg.units) {
        return `${formatted} / ${cfg.units} ${planFeatureVersion?.unitOfMeasure ?? "units"}`
      }
      return formatted
    }
    if (cfg?.tiers?.length) {
      return `${cfg.tiers.length} tiers`
    }
    return "—"
  })()

  const handleToggle = () => {
    if (mode !== "FeaturePlan") return
    if (isDragging) return
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
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </FeatureDialog>

        <span className="line-clamp-1 flex-1 font-medium text-sm">{feature.title}</span>

        {!disabled && onAdd && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2 font-medium text-xs"
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
          "border-primary shadow-md ring-1 ring-primary/40": isExpanded,
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
        className="flex w-full cursor-pointer items-start justify-between gap-2 p-3"
      >
        {/* Drag handle (only present in attached mode via SortableFeature) */}
        {renderDragHandle && <div className="mt-0.5">{renderDragHandle()}</div>}

        {/* Left: chevron + title + indicators + description */}
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <ChevronRight
            className={cn(
              "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
              isExpanded && "rotate-90"
            )}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="line-clamp-1 font-semibold text-sm">{feature.title}</span>

              {!planFeatureVersion?.id && <Ping variant="destructive" />}

              {planFeatureVersion.metadata?.hidden && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <EyeOff className="size-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                    Hidden from the customer pricing card.
                    <TooltipArrow className="fill-background-bg" />
                  </TooltipContent>
                </Tooltip>
              )}

              {planFeatureVersion.featureType === "usage" &&
                activePlanVersion?.billingConfig.name !== planFeatureVersion.billingConfig.name && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <CalendarClock className="size-3.5 text-muted-foreground" />
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
                      <RotateCw className="size-3.5 text-muted-foreground" />
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
                    <Zap className="size-3.5 text-warning" />
                  </TooltipTrigger>
                  <TooltipContent className="bg-background-bg font-normal text-xs" align="center">
                    Reports usage in realtime.
                    <TooltipArrow className="fill-background-bg" />
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {feature.description && (
              <p className="line-clamp-1 text-muted-foreground text-xs">{feature.description}</p>
            )}
          </div>
        </div>

        {/* Right: price summary + type + delete */}
        <div className="flex shrink-0 items-start gap-2">
          <div className="text-right">
            <div className="font-medium font-mono text-sm tabular-nums">{priceSummary}</div>
            <div className="text-muted-foreground text-xs">
              {FEATURE_TYPES_MAPS[planFeatureVersion.featureType]?.shortLabel ??
                planFeatureVersion.featureType}
            </div>
          </div>

          {!isPublished &&
            (isDelete ? (
              <div className="flex items-center">
                <Button
                  className="h-7 px-1 font-light text-xs"
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
                  className="h-7 px-1"
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
                className="h-7 px-1 text-muted-foreground hover:text-destructive"
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
            ))}
        </div>
      </div>

      {/* expanded inline editor — hidden while dragging so the card stays compact during reorder */}
      {isExpanded && !isDragging && activePlanVersion && (
        <div
          className="border-t bg-background p-4"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
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
