"use client"
import type { InsertSubscription, InsertSubscriptionPhase } from "@unprice/db/validators"
import { Button } from "@unprice/ui/button"
import { FormDescription, FormLabel, FormMessage } from "@unprice/ui/form"
import { Separator } from "@unprice/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@unprice/ui/sheet"
import { toast } from "@unprice/ui/sonner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@unprice/ui/tooltip"
import { Typography } from "@unprice/ui/typography"
import { cn } from "@unprice/ui/utils"
import { motion } from "framer-motion"
import { LayoutGrid } from "lucide-react"
import { useEffect, useState } from "react"
import { type FieldErrors, type UseFormReturn, useFieldArray } from "react-hook-form"
import { EmptyPlaceholder } from "~/components/empty-placeholder"
import { PropagationStopper } from "~/components/prevent-propagation"
import { useTRPC } from "~/trpc/client"
import { SubscriptionPhaseForm } from "./subscription-phase-form"

import { useMutation, useQuery } from "@tanstack/react-query"
import { Skeleton } from "@unprice/ui/skeleton"
import { startTransition } from "react"
import { toastAction } from "~/lib/toast"
import { SubscriptionPhaseRow } from "./subscription-phase-row"
import {
  type SubscriptionPhaseFieldValue,
  type SubscriptionPhaseFormMode,
  type SubscriptionPhaseFormValue,
  getPhaseSheetDescription,
  getPhaseSheetTitle,
  getPhaseTimingState,
} from "./subscription-phase-types"

export default function SubscriptionPhaseFormField({
  form,
  subscriptionId,
  timezone,
}: {
  form: UseFormReturn<InsertSubscription>
  subscriptionId: string
  timezone: string
}) {
  const trpc = useTRPC()
  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: "phases",
    keyName: "_id",
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [phaseFormMode, setPhaseFormMode] = useState<SubscriptionPhaseFormMode>("create")

  const selectedCustomer = form.watch("customerId")

  const defaultValuesPhase = {
    customerId: form.getValues("customerId"),
    id: "",
    planVersionId: "",
    config: [],
    items: [],
    startAt: Date.now(),
    subscriptionId,
    paymentMethodRequired: false,
    creditLinePolicy: "uncapped",
    creditLineAmount: null,
    trialUnits: 0,
  } as SubscriptionPhaseFormValue

  const [selectedPhase, setSelectedPhase] = useState<SubscriptionPhaseFormValue>(defaultValuesPhase)

  const { errors } = form.formState
  const now = Date.now()
  const activePhase = fields.find(
    (phase) => getPhaseTimingState(phase as SubscriptionPhaseFieldValue, now) === "active"
  ) as SubscriptionPhaseFieldValue | undefined
  const hasFuturePhase = fields.some(
    (phase) => getPhaseTimingState(phase as SubscriptionPhaseFieldValue, now) === "future"
  )
  const lastPhase = fields.at(-1) as SubscriptionPhaseFieldValue | undefined
  const lastPhaseTimingState = lastPhase ? getPhaseTimingState(lastPhase, now) : undefined
  const canAddScheduledPhase = Boolean(subscriptionId && activePhase && !hasFuturePhase)
  const canAddPhaseAfterFuture = Boolean(
    subscriptionId && hasFuturePhase && lastPhaseTimingState === "future" && lastPhase?.endAt
  )

  // this query is deduplicated from the parent component
  const { data: planVersions, isLoading: isPlanVersionsLoading } = useQuery(
    trpc.planVersions.listByActiveProject.queryOptions({
      onlyPublished: true,
      onlyLatest: false,
    })
  )

  const removePhase = useMutation(
    trpc.subscriptions.removePhase.mutationOptions({
      onSuccess: () => {
        toastAction("success")
      },
    })
  )

  const getErrorMessage = (
    errors: FieldErrors<InsertSubscriptionPhase>,
    field: string
  ): string | undefined => {
    // show the errros for the given field, if not found, show the all errors
    const error = errors[field as keyof typeof errors]

    if (error && Array.isArray(error)) {
      return error
        .map((e) => {
          const keys = Object.keys(e)

          return keys
            .map((key) => {
              return `${key}: ${e[key as keyof typeof e].message}`
            })
            .join(" ")
        })
        .join(" ")
    }

    return error && typeof error === "object" && "message" in error
      ? (error.message as string)
      : undefined
  }

  useEffect(() => {
    if (selectedCustomer) {
      setSelectedPhase({
        ...defaultValuesPhase,
        customerId: selectedCustomer,
      })
      setPhaseFormMode("create")

      form.clearErrors("customerId")
    }
  }, [selectedCustomer])

  function openSchedulePhase() {
    if (!selectedCustomer) {
      form.setError("customerId", {
        message: "You need to select a customer first",
      })
      return
    }

    if (!subscriptionId || !activePhase) return

    setSelectedPhase({
      ...defaultValuesPhase,
      id: subscriptionId,
      projectId: form.getValues("projectId") ?? "",
      customerId: selectedCustomer,
      subscriptionId,
      planVersionId: "",
      currentPlanVersionId: activePhase.planVersionId,
      config: [],
      whenToChange: "end_of_cycle",
      currentCycleEndAt: form.getValues("currentCycleEndAt") ?? Date.now(),
      timezone,
      startAt: form.getValues("currentCycleEndAt") ?? Date.now(),
      paymentProvider: undefined,
      paymentMethodRequired: false,
      paymentMethodId: null,
      creditLinePolicy: "uncapped",
      creditLineAmount: null,
      trialUnits: 0,
    })
    setPhaseFormMode("schedule")
    setDialogOpen(true)
  }

  function openCreatePhaseAfterLastFuture() {
    if (!selectedCustomer) {
      form.setError("customerId", {
        message: "You need to select a customer first",
      })
      return
    }

    if (!lastPhase?.endAt) return

    setSelectedPhase({
      ...defaultValuesPhase,
      customerId: selectedCustomer,
      subscriptionId,
      startAt: lastPhase.endAt + 1,
    })
    setPhaseFormMode("create")
    setDialogOpen(true)
  }

  function onRemovePhase(phaseId: string, callback: () => void) {
    startTransition(() => {
      toast.promise(
        removePhase
          .mutateAsync({
            id: phaseId,
          })
          .then(() => {
            callback()
          }),
        {
          loading: "Removing phase...",
          success: "Phase removed",
        }
      )
    })
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <Separator className="my-2" />
      <div className="mb-4 flex flex-col gap-2">
        <FormLabel
          className={cn({
            "text-destructive": errors.phases,
          })}
        >
          <Typography variant="h5">Phases configuration</Typography>
        </FormLabel>
        <FormDescription>
          Each phase represents a different period of time for the subscription. You can add a trial
          duration for every phase and configure the billing method. Use Add phase to create the
          next scheduled phase without manually closing the current one.
        </FormDescription>
        {errors.phases && <FormMessage>{getErrorMessage(errors, "phases")}</FormMessage>}
      </div>

      {isPlanVersionsLoading ? (
        <Skeleton className="h-[84px] w-full" />
      ) : (
        <motion.div
          className="flex items-center justify-center px-1 py-2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {fields.length > 0 ? (
            <div className="flex w-full flex-col gap-4">
              {fields.map((phase, index) => {
                const phaseValue = phase as SubscriptionPhaseFieldValue
                const selectedPlanVersion =
                  planVersions?.planVersions.find(
                    (version) => version.id === phaseValue.planVersionId
                  ) ?? phaseValue.planVersion

                const phaseTimingState = getPhaseTimingState(phaseValue, now)

                if (!selectedPlanVersion) return null

                return (
                  <SubscriptionPhaseRow
                    key={phaseValue.id || phaseValue._id}
                    fieldsLength={fields.length}
                    hasError={Boolean(errors.phases?.[index])}
                    index={index}
                    phase={phaseValue}
                    phaseTimingState={phaseTimingState}
                    removePending={removePhase.isPending}
                    selectedPlanVersion={selectedPlanVersion}
                    showConnector={index < fields.length - 1}
                    timezone={timezone}
                    onOpenPhase={(phaseToOpen, mode, planVersion) => {
                      setSelectedPhase({
                        ...phaseToOpen,
                        subscriptionId,
                        customerId: selectedCustomer,
                        paymentMethodRequired: planVersion.paymentMethodRequired ?? false,
                        planVersionId: planVersion.id,
                        trialUnits: phaseToOpen.trialUnits ?? planVersion.trialUnits,
                        creditLinePolicy: phaseToOpen.creditLinePolicy ?? "uncapped",
                        creditLineAmount: phaseToOpen.creditLineAmount ?? null,
                      })
                      setPhaseFormMode(mode)
                      setDialogOpen(true)
                    }}
                    onRemovePhase={(phaseId, phaseIndex) => {
                      onRemovePhase(phaseId, () => {
                        remove(phaseIndex)
                      })
                    }}
                  />
                )
              })}

              <div className="mt-6 flex justify-center">
                {subscriptionId ? (
                  canAddScheduledPhase || canAddPhaseAfterFuture ? (
                    <Button
                      size={"sm"}
                      className="w-1/2"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        if (canAddPhaseAfterFuture) {
                          openCreatePhaseAfterLastFuture()
                          return
                        }

                        openSchedulePhase()
                      }}
                    >
                      Add phase
                    </Button>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size={"sm"}
                          className="w-1/2 cursor-not-allowed opacity-50"
                          aria-disabled
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                          }}
                        >
                          Add phase
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="w-64">
                        {hasFuturePhase
                          ? "Edit the last future phase and add an end date before adding another phase."
                          : "Adding a phase requires an active phase."}
                      </TooltipContent>
                    </Tooltip>
                  )
                ) : fields.length > 0 && !fields[fields.length - 1]?.endAt ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size={"sm"}
                        className="w-1/2 cursor-not-allowed opacity-50"
                        aria-disabled
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                        }}
                      >
                        Add phase
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="w-56">
                      You can't add a new phase if the last phase is not ended. Add an end date to
                      the last phase
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    size={"sm"}
                    className="w-1/2"
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()

                      if (fields.length > 0) {
                        const lastPhase = fields[fields.length - 1]
                        const endAt = lastPhase?.endAt ?? Date.now()
                        const startAt = new Date(endAt).getTime() + 1

                        if (lastPhase) {
                          setSelectedPhase({
                            ...defaultValuesPhase,
                            // Continue immediately after the previous phase ends.
                            startAt: startAt,
                          })
                          setPhaseFormMode("create")
                        } else {
                          setSelectedPhase({
                            ...defaultValuesPhase,
                            startAt: startAt,
                          })
                          setPhaseFormMode("create")
                        }
                      } else {
                        setSelectedPhase(defaultValuesPhase)
                        setPhaseFormMode("create")
                      }

                      setDialogOpen(true)
                    }}
                  >
                    Add phase
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-center px-1 py-2">
              <EmptyPlaceholder className="min-h-[200px]">
                <EmptyPlaceholder.Icon>
                  <LayoutGrid className="h-8 w-8" />
                </EmptyPlaceholder.Icon>
                <EmptyPlaceholder.Title>No phases created</EmptyPlaceholder.Title>
                <EmptyPlaceholder.Description>
                  Add a phase to start the subscription
                </EmptyPlaceholder.Description>
                <EmptyPlaceholder.Action>
                  <Button
                    size={"sm"}
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()

                      if (!selectedCustomer) {
                        form.setError("customerId", {
                          message: "You need to select a customer first",
                        })
                        return
                      }

                      setPhaseFormMode("create")
                      setDialogOpen(true)
                    }}
                  >
                    Add phase
                  </Button>
                </EmptyPlaceholder.Action>
              </EmptyPlaceholder>
            </div>
          )}
        </motion.div>
      )}

      <PropagationStopper>
        <Sheet open={dialogOpen} onOpenChange={setDialogOpen}>
          <SheetContent className="hide-scrollbar flex max-h-screen w-full flex-col space-y-4 overflow-y-scroll md:w-1/2 lg:w-[700px]">
            <SheetHeader>
              <SheetTitle className="text-2xl">{getPhaseSheetTitle(phaseFormMode)}</SheetTitle>
              <SheetDescription>{getPhaseSheetDescription(phaseFormMode)}</SheetDescription>
            </SheetHeader>

            <SubscriptionPhaseForm
              defaultValues={{
                ...selectedPhase,
                customerId: selectedCustomer,
              }}
              mode={phaseFormMode}
              isReadOnly={phaseFormMode === "view"}
              onSubmit={(data) => {
                if (data.id !== "") {
                  const index = fields.findIndex((phase) => phase.id === data.id)
                  if (index !== -1) {
                    update(index, data)
                  } else {
                    append(data)
                  }
                } else {
                  append(data)
                }
              }}
              setDialogOpen={setDialogOpen}
            />
          </SheetContent>
        </Sheet>
      </PropagationStopper>
    </div>
  )
}
