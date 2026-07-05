"use client"

import { getTrialUnitLabel } from "@unprice/db/validators"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@unprice/ui/alert-dialog"
import { Badge } from "@unprice/ui/badge"
import { Button } from "@unprice/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { ArrowDownIcon, EyeIcon, PencilIcon, TrashIcon } from "lucide-react"
import { Ping } from "~/components/ping"
import { formatDate } from "~/lib/dates"
import {
  type PhaseTimingState,
  type SubscriptionPhaseFieldValue,
  type SubscriptionPhaseFormMode,
  type SubscriptionPhasePlanVersionSummary,
  formatPhaseCreditLinePolicy,
} from "./subscription-phase-types"

export function SubscriptionPhaseRow({
  fieldsLength,
  hasError,
  index,
  onOpenPhase,
  onRemovePhase,
  phase,
  phaseTimingState,
  removePending,
  selectedPlanVersion,
  showConnector,
  timezone,
}: {
  fieldsLength: number
  hasError?: boolean
  index: number
  onOpenPhase: (
    phase: SubscriptionPhaseFieldValue,
    mode: Extract<SubscriptionPhaseFormMode, "edit" | "view">,
    selectedPlanVersion: SubscriptionPhasePlanVersionSummary
  ) => void
  onRemovePhase: (phaseId: string, index: number) => void
  phase: SubscriptionPhaseFieldValue
  phaseTimingState: PhaseTimingState
  removePending: boolean
  selectedPlanVersion: SubscriptionPhasePlanVersionSummary
  showConnector: boolean
  timezone: string
}) {
  const isActive = phaseTimingState === "active"
  const isFuture = phaseTimingState === "future"
  const canRemovePhase = phaseTimingState === "future"
  const canEditPhase = phaseTimingState === "future"
  const trialUnitsMessage = getTrialUnitLabel({
    billingInterval: selectedPlanVersion.billingConfig.billingInterval,
    units: phase.trialUnits,
  })

  return (
    <div className="relative">
      <div
        className={cn("flex w-full flex-col gap-2 rounded-md border border-dashed px-4 py-4", {
          "border-destructive": hasError,
          "border-info": isActive,
        })}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Typography variant="h5">
              {index + 1}. {selectedPlanVersion.title} v{selectedPlanVersion.version} -{" "}
              {selectedPlanVersion.billingConfig.name}
            </Typography>
            <div className="mt-2 hidden items-center sm:flex">
              {phase.trialUnits && phase.trialUnits > 0 ? (
                <Badge>
                  {phase.trialUnits} {trialUnitsMessage} trial
                </Badge>
              ) : (
                <Badge>no trial</Badge>
              )}
              <Badge className="ml-2" variant="secondary">
                {phase.paymentProvider} provider
              </Badge>
              <Badge className="ml-2">
                {formatPhaseCreditLinePolicy(phase, selectedPlanVersion.currency)}
              </Badge>
              {isActive && (
                <div className="mx-2 inline-flex items-center font-semibold text-info text-xs">
                  <span className="mr-1">Active phase</span>
                  <div className="relative">
                    <Ping variant="info" />
                  </div>
                </div>
              )}
              {!isActive && (
                <div className="mx-2 inline-flex items-center font-semibold text-xs">
                  <span className="mr-1">{isFuture ? "Future phase" : "Inactive phase"}</span>
                  <span className="flex size-1.5 rounded-full bg-muted-foreground" />
                </div>
              )}
            </div>
            <Typography variant="p" affects="removePaddingMargin">
              from {formatDate(phase.startAt, timezone, "MMM dd, yyyy")} to{" "}
              {phase.endAt ? formatDate(phase.endAt, timezone, "MMM dd, yyyy") : "forever"}
            </Typography>
          </div>
          <div className="ml-2 flex shrink-0 items-center justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={canEditPhase ? "Edit phase" : "View phase"}
                  onClick={(event) => {
                    event.stopPropagation()
                    event.preventDefault()
                    onOpenPhase(phase, canEditPhase ? "edit" : "view", selectedPlanVersion)
                  }}
                >
                  {canEditPhase ? (
                    <PencilIcon className="size-3.5" />
                  ) : (
                    <EyeIcon className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{canEditPhase ? "Edit phase" : "View phase"}</TooltipContent>
            </Tooltip>

            {canRemovePhase && fieldsLength > 1 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    className="px-0 text-destructive"
                    variant="link"
                    size="icon"
                    aria-label="Delete future phase"
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete future phase?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This removes the scheduled phase from the subscription. Current and historical
                      phases are not changed.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={removePending}
                      onClick={() => {
                        if (!phase.id) return
                        onRemovePhase(phase.id, index)
                      }}
                    >
                      Delete phase
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
      </div>
      {showConnector && (
        <div
          className="flex h-5 items-center justify-center text-muted-foreground"
          aria-hidden="true"
        >
          <div className="flex h-full flex-col items-center">
            <span className="h-2 w-px bg-border" />
            <ArrowDownIcon className="size-4" strokeWidth={1.75} />
          </div>
        </div>
      )}
    </div>
  )
}
